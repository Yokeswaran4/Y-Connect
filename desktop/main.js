// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
const { app, BrowserWindow, ipcMain, net, clipboard, Notification, Tray, Menu, nativeImage, nativeTheme, systemPreferences, shell, dialog } = require('electron');

// Linux stability: avoid /dev/shm crashes, Wayland+Vulkan clashes and blank windows from GPU issues
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-dev-shm-usage');
  app.commandLine.appendSwitch('disable-features', 'Vulkan');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  // Software rendering is the safe default (avoids blank windows on odd GPU setups) but it is much slower.
  // Start with YCONNECT_GPU=1 to use the GPU: smoother animations on most machines.
  if (process.env.YCONNECT_GPU !== '1') app.disableHardwareAcceleration();
  else app.commandLine.appendSwitch('enable-gpu-rasterization');
}
const path = require('path');
const os = require('os');
const fs = require('fs');
const dgram = require('dgram');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const transfer = require('./transfer');
const screenShare = require('./screen');
const remote = require('./remote');
const storage = require('./storage');
const battery = require('./battery');
const autostart = require('./autostart');
const deviceinfo = require('./deviceinfo');
const updates = require('./updates');
const legacy = require('./legacy');
const pc = require('./paircrypto');
const latency = require('./latency').create({
  ids: () => [...peers.keys()],
  send: (id, obj) => { const p = peers.get(id); if (p) sendTo(p.ws, obj); },
  onChange: (id) => { if (win && !win.isDestroyed()) win.webContents.send('latency', id, latency.stats(id)); },
});

const VERSION_LABEL = 'v2.0';
const WS_PORT = 48998;
const UDP_PORT = 48999;
const MAX_CLIP = 1024 * 1024;
const ICON = path.join(__dirname, 'build', 'icon.png');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('com.yokeswaran.yconnect');
try { if (process.platform === 'linux') app.setDesktopName('y-connect.desktop'); } catch {}

// An AppImage installs no menu entry, so docks and launchers cannot match its window to an icon.
// On every start from an AppImage this writes the entry and icon into the user's folders (no root needed).
function integrateDesktop() {
  if (process.platform !== 'linux' || !process.env.APPIMAGE) return;
  try {
    const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    const iconDir = path.join(data, 'icons', 'hicolor', '512x512', 'apps');
    const appsDir = path.join(data, 'applications');
    fs.mkdirSync(iconDir, { recursive: true });
    fs.mkdirSync(appsDir, { recursive: true });
    const icon = path.join(iconDir, 'y-connect.png');
    const src = fs.readFileSync(path.join(__dirname, 'build', 'icon.png'));
    let cur = null; try { cur = fs.readFileSync(icon); } catch {}
    let iconChanged = false;
    if (!cur || !cur.equals(src)) { fs.writeFileSync(icon, src); iconChanged = true; }
    const q = (x) => '"' + String(x).replace(/(["`$\\])/g, '\\$1') + '"';
    const entry = ['[Desktop Entry]', 'Type=Application', 'Name=Y Connect', 'Comment=Share notifications, clipboard and files between your devices',
      'Exec=' + q(process.env.APPIMAGE), 'Icon=' + icon, 'Terminal=false', 'Categories=Utility;Network;', 'StartupWMClass=y-connect', ''].join('\n');
    const file = path.join(appsDir, 'y-connect.desktop');
    let old = ''; try { old = fs.readFileSync(file, 'utf8'); } catch {}
    if (old !== entry) { fs.writeFileSync(file, entry); iconChanged = true; }
    if (iconChanged) legacy.refreshCaches(); // so the dock picks up the new icon without logging out
  } catch {}
}

let win = null, tray = null, wss = null, udp = null;
let config = null, lastClip = '', pushTimer = null;
let logEntries = [];
let autostartError = null; // { why, fix } when the last attempt to change launch-on-startup failed
const startHidden = process.argv.includes('--hidden');
let updateInfo = null;     // result of the last update check (shown in Settings)
let myBattery = null;      // { level, charging } or null when this computer has no battery
const peers = new Map();   // device id -> { ws, info }
const pending = new Set(); // outgoing connections in progress
const nearby = new Map();  // device id -> { id, name, platform, address, port, seen }  (every Y Connect heard on the LAN)
const NEARBY_TTL = 10000;
let pairRequest = null;    // { id, name, address, sas, time, ws } - another device wants to pair with us (waiting for Accept / Decline)
let pairOut = null;        // { id, name, sas, state, ws } - we asked another device to pair; state: waiting | declined | failed
const pairKeys = new Map(); // paired device id -> AES key (derived from that pair's own random code)
const waitingSince = new Map(); // paired device id -> when we first heard it while not connected
let nearbySig = '';
const myPlatform = () => (process.platform === 'win32' ? 'windows' : 'linux');

/* ---------- config ---------- */
function loadConfig() {
  const file = path.join(app.getPath('userData'), 'config.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  config = Object.assign({
    id: crypto.randomUUID(),
    name: os.hostname(),
    paired: {}, // device id -> { name, code }: one random pairing code per paired device
    clipboardSync: true,
    notifySync: true,
    acceptFiles: true,
    launchOnStartup: false, // start with the computer when you log in (Windows / Linux)
    startHidden: true,    // when launching on startup: stay in the tray (true) or show the window (false)
    batterySync: true,    // share this computer's battery level and show the phone's
    allowControl: false,  // a device that views our shared screen may move the mouse / type here. Off until the user turns it on
    adbPath: '',          // optional: full path of adb, used to control a phone from the screen viewer (found in PATH / the Android SDK otherwise)
    allowCommands: false, // phone may run commands here (never with sudo/admin). Off until the user turns it on
    theme: 'system', // system | light | dark
    systemColors: true, // follow the OS accent colour; off = Y Connect blue
    autoUpdateCheck: false, // opt-in: look for a newer release about once a day and show a notification
    lastUpdateCheck: 0,
    notifiedVersion: '',
  }, saved);
  if (!config.paired || typeof config.paired !== 'object' || Array.isArray(config.paired)) config.paired = {};
  delete config.passphrase; // the single shared code of earlier versions is gone: every pair has its own code now
  delete config.ignored;
  if (!['system', 'light', 'dark'].includes(config.theme)) config.theme = 'system';
  config.startHidden = config.startHidden !== false;
  delete config.allowRemove; // removing files from the phone no longer exists
  nativeTheme.themeSource = config.theme;
  saveConfig();
}
function saveConfig() {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  } catch {}
}

/* ---------- crypto (AES-256-GCM, key from the pairing code of that device pair) ---------- */
function loadKeys() {
  pairKeys.clear();
  for (const [id, d] of Object.entries(config.paired)) {
    if (d && pc.validCode(d.code)) pairKeys.set(id, pc.deriveKey(d.code));
    else delete config.paired[id];
  }
}
function storePair(id, name, code) {
  config.paired[id] = { name: String(name || 'Device').slice(0, 40), code };
  pairKeys.set(id, pc.deriveKey(code));
  saveConfig();
}
function forgetPair(id) {
  delete config.paired[id];
  pairKeys.delete(id);
  waitingSince.delete(id);
  saveConfig();
}

/* ---------- state for the UI ---------- */
const preview = (t) => String(t).replace(/\s+/g, ' ').slice(0, 60);
function addLog(kind, title, text = '') {
  const top = logEntries[0];
  if (top && top.kind === kind && top.title === title && top.text === text) { top.time = Date.now(); top.count = (top.count || 1) + 1; pushState(); return; }
  logEntries.unshift({ time: Date.now(), kind, title, text, count: 1 });
  logEntries = logEntries.slice(0, 50);
  pushState();
}
function localIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if ((i.family === 'IPv4' || i.family === 4) && !i.internal) out.push(i.address);
  }
  return out;
}
/** Windows (and macOS) accent colour; falls back to Y Connect blue on Linux. */
function accentColor() {
  if (!config.systemColors) return '#5aa5f0';
  try {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      const c = systemPreferences.getAccentColor(); // RRGGBBAA
      if (c && c.length >= 6) return '#' + c.slice(0, 6);
    }
  } catch {}
  return '#5aa5f0';
}
const bgColor = () => (nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3');
function snapshot() {
  const { paired: _codes, ...publicConfig } = config; // pairing codes never go to the window
  return { config: publicConfig, peers: [...peers.values()].map((p) => ({ ...p.info, lat: latency.stats(p.info.id) })), nearby: nearbyList(), mounts: storage.list(), pairRequest: pairRequest && { id: pairRequest.id, name: pairRequest.name, sas: pairRequest.sas }, pairOut: pairOut && { id: pairOut.id, name: pairOut.name, sas: pairOut.sas, state: pairOut.state }, log: logEntries, ips: localIps(), version: VERSION_LABEL, accent: accentColor(), platform: process.platform, update: updateInfo && updateInfo.newer ? updateInfo : null, transfers: transfer.list(), screen: screenShare.state(), autostart: { supported: autostart.supported, enabled: autostart.isEnabled(), hidden: config.startHidden !== false, error: autostartError } };
}
function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (win && !win.isDestroyed()) win.webContents.send('update', snapshot());
  }, 50);
}

/* ---------- networking ---------- */
const helloMsg = () => ({ type: 'hello', id: config.id, name: config.name, platform: myPlatform() });
const isPeerSocket = (ws) => [...peers.values()].some((p) => p.ws === ws);
// Pairing frames (and "who are you" probes) are plain JSON. Everything else is base64 AES-GCM, which never starts with "{".
function sendRaw(ws, obj) { try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch {} }
function sendTo(ws, obj) { try { if (ws._key && ws.readyState === WebSocket.OPEN) ws.send(pc.seal(ws._key, JSON.stringify(obj))); } catch {} }
function broadcast(obj) {
  const text = JSON.stringify(obj);
  let n = 0;
  for (const p of peers.values()) if (p.ws.readyState === WebSocket.OPEN && p.ws._key) { p.ws.send(pc.seal(p.ws._key, text)); n++; }
  return n;
}
function dropSocket(ws) {
  transfer.onDisconnected(ws);
  screenShare.onDisconnected(ws);
  remote.onDisconnected(ws);
  storage.onDisconnected(ws);
  if (pairRequest && pairRequest.ws === ws) { pairRequest = null; }
  if (pairOut && pairOut.ws === ws && pairOut.state === 'waiting') pairOut.state = 'failed';
  for (const [id, p] of peers) {
    if (p.ws === ws) { peers.delete(id); latency.drop(id); addLog('link', 'Disconnected', p.info.name); }
  }
  pushState();
}
/**
 * mode: 'in' (someone connected to us), 'connect' (we dial a paired device: we know its key),
 *       'pair' (we dial a device to ask it to pair), 'probe' (we dial an IP and ask who is there).
 */
function attach(ws, addr, o = {}) {
  ws._addr = String(addr || '?').replace(/^::ffff:/, '');
  ws._mode = o.mode || 'in';
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => (isBinary ? handleBinary(ws, data) : handle(ws, data.toString())));
  ws.on('close', () => { clearTimeout(ws._life); dropSocket(ws); });
  ws.on('error', () => {});
  // a socket that never becomes a connected device (or finishes pairing) is closed
  ws._life = setTimeout(() => { if (!isPeerSocket(ws)) { try { ws.close(); } catch {} } }, 60000);
  if (ws._mode === 'connect') useKey(ws, o.id), sayHello(ws);
  else if (ws._mode === 'pair') startPairOut(ws, o.id, o.name);
  else if (ws._mode === 'probe') sendRaw(ws, { t: 'who' });
}
function useKey(ws, id) { ws._peerId = id; ws._key = pairKeys.get(id); }
function sayHello(ws) { ws._helloSent = true; sendTo(ws, helloMsg()); }
function handleBinary(ws, data) {
  if (!isPeerSocket(ws) || !ws._key) return;
  let plain;
  try { plain = pc.openBytes(ws._key, Buffer.isBuffer(data) ? data : Buffer.concat(data)); }
  catch { try { ws.close(); } catch {} return; }
  if (plain.length >= 8 && plain.readUInt32BE(0) === 0) return screenShare.onFrame(ws, plain); // tid 0 = screen picture
  transfer.onBinary(ws, plain);
}
const suppressed = new Map(); // notifications we display ourselves, so the D-Bus watcher never forwards them back
const recentIn = new Map();
const recentOut = new Map();
let sentTimes = [];
const fresh = (map, key, ttl) => {
  const now = Date.now();
  for (const [k, t] of map) if (now - t > 30000) map.delete(k);
  const last = map.get(key);
  map.set(key, now);
  return !(last && now - last < ttl);
};
// Find a PNG for a freedesktop icon and return it as small base64, so the phone can show the source app's icon.
// Many apps send no usable icon name, so the app's name is also looked up in the installed .desktop files.
const iconCache = new Map();
let desktopIndex = null;
const ICON_SIZES = ['256x256', '192x192', '128x128', '96x96', '64x64', '48x48', '512x512'];
function iconRoots() {
  const h = os.homedir();
  return [path.join(h, '.local/share/icons'), '/usr/share/icons', '/var/lib/flatpak/exports/share/icons', path.join(h, '.local/share/flatpak/exports/share/icons')];
}
function listDirs(d) { try { return fs.readdirSync(d); } catch { return []; } }
function loadDesktopIndex() {
  if (desktopIndex) return desktopIndex;
  desktopIndex = new Map(); // lower-case name / file id -> Icon value
  const h = os.homedir();
  for (const dir of ['/usr/share/applications', '/usr/local/share/applications', path.join(h, '.local/share/applications'), '/var/lib/flatpak/exports/share/applications', path.join(h, '.local/share/flatpak/exports/share/applications')]) {
    for (const f of listDirs(dir)) {
      if (!f.endsWith('.desktop')) continue;
      try {
        const txt = fs.readFileSync(path.join(dir, f), 'utf8').split(/\n\[/)[0];
        const ic = /^Icon=(.+)$/m.exec(txt), nm = /^Name=(.+)$/m.exec(txt);
        if (!ic) continue;
        const icon = ic[1].trim();
        desktopIndex.set(f.replace(/\.desktop$/, '').toLowerCase(), icon);
        if (nm) desktopIndex.set(nm[1].trim().toLowerCase(), icon);
      } catch {}
    }
  }
  return desktopIndex;
}
function pngB64(f) {
  try {
    if (!f.toLowerCase().endsWith('.png') || fs.statSync(f).size > 600000) return '';
    const img = nativeImage.createFromPath(f);
    if (!img.isEmpty()) return img.resize({ width: 96, height: 96 }).toPNG().toString('base64');
  } catch {}
  return '';
}
function resolveIconName(name) {
  if (name.startsWith('file://')) { try { name = decodeURIComponent(name.slice(7)); } catch { return ''; } }
  if (path.isAbsolute(name)) return pngB64(name);
  for (const root of iconRoots()) {
    for (const theme of listDirs(root)) {
      for (const sz of ICON_SIZES) {
        const r = pngB64(path.join(root, theme, sz, 'apps', name + '.png')) || pngB64(path.join(root, theme, 'apps', sz.split('x')[0], name + '.png'));
        if (r) return r;
      }
    }
  }
  return pngB64(`/usr/share/pixmaps/${name}.png`);
}
function findIcon(name, appName) {
  const key = (name || '') + '|' + (appName || '');
  if (iconCache.has(key)) return iconCache.get(key);
  const names = [];
  if (name) names.push(name);
  const low = String(appName || '').trim().toLowerCase();
  if (low) {
    const idx = loadDesktopIndex();
    for (const k of [low, low.replace(/\s+/g, '-')]) if (idx.has(k)) names.push(idx.get(k));
    names.push(low.replace(/\s+/g, '-'));
  }
  let out = '';
  for (const n of [...new Set(names)]) { out = resolveIconName(n); if (out) break; }
  iconCache.set(key, out);
  return out;
}
function startNotifWatch() {
  require('./notifwatch').start(({ app: a, icon, title, text }) => {
    if (!config.notifySync || !peers.size) return;
    if (/y[ -]?connect/i.test(a) || (!title && !text)) return; // never forward our own notifications
    const key = title + '|' + text;
    const s = suppressed.get(key);
    if (s && Date.now() - s < 15000) return; // it is a notification we just showed for another device
    if (!fresh(recentOut, a + '|' + key, 4000)) return; // duplicate
    const now = Date.now();
    sentTimes = sentTimes.filter((t) => now - t < 10000);
    if (sentTimes.length >= 8) return; // flood protection
    sentTimes.push(now);
    if (broadcast({ type: 'notification', app: a, title, text, icon: findIcon(icon, a), ts: now }) > 0) addLog('notif', 'Notification sent', (a ? a + ': ' : '') + (title || text));
  }, () => addLog('warn', 'Notification forwarding off', 'Install “dbus” (dbus-monitor) to send this computer’s notifications'));
}
function showNotification(appName, title, text, iconB64) {
  if (!fresh(recentIn, appName + '|' + title + '|' + text, 3000)) return;
  const t = appName ? (title ? `${appName} — ${title}` : appName) : (title || 'Notification');
  suppressed.set(t + '|' + (text || ''), Date.now());
  if (Notification.isSupported()) {
    let icon = ICON;
    if (iconB64 && iconB64.length < 300000) {
      try { const img = nativeImage.createFromBuffer(Buffer.from(iconB64, 'base64')); if (!img.isEmpty()) icon = img; } catch {}
    }
    new Notification({ title: t, body: text || '', icon }).show();
  }
  addLog('notif', t, text || '');
}
function handle(ws, raw) {
  if (raw.charCodeAt(0) === 123) return handlePlain(ws, raw); // "{"
  let msg;
  if (!ws._key) {
    // first encrypted frame on a socket someone opened to us: find out which paired device it is by whose key opens it
    let who = null;
    for (const [id, k] of pairKeys) { try { msg = JSON.parse(pc.open(k, raw)); who = id; break; } catch {} }
    if (!who) { sendRaw(ws, { t: 'unknown' }); setTimeout(() => { try { ws.close(); } catch {} }, 300); return; }
    useKey(ws, who);
  } else {
    try { msg = JSON.parse(pc.open(ws._key, raw)); } catch {
      // Not decryptable: drop it silently. An unknown socket is closed; an already connected peer stays connected.
      if (!isPeerSocket(ws)) { try { ws.close(); } catch {} }
      return;
    }
  }
  if (msg.type === 'hello') {
    if (msg.id !== ws._peerId || msg.id === config.id) { try { ws.close(); } catch {} return; } // the key proves who it is
    const old = peers.get(msg.id);
    const isNew = !old || old.ws !== ws;
    if (old && old.ws !== ws) { peers.delete(msg.id); try { old.ws.close(); } catch {} }
    const name = String(msg.name || 'Device').slice(0, 40);
    peers.set(msg.id, { ws, info: { id: msg.id, name, platform: String(msg.platform || '?').slice(0, 16), address: ws._addr } });
    if (config.paired[msg.id] && config.paired[msg.id].name !== name) { config.paired[msg.id].name = name; saveConfig(); }
    if (!ws._helloSent) sayHello(ws);
    if (isNew) { addLog('link', 'Connected', name); latency.reset(msg.id); latency.ping(msg.id); setTimeout(() => transfer.onPeerConnected(msg.id), 1500); }
    waitingSince.delete(msg.id);
    if (pairOut && pairOut.id === msg.id) pairOut = null;
    nearbySig = '';
    sendBattery(ws);
    pushState();
    return;
  }
  if (!isPeerSocket(ws)) return;
  if (msg.type === 'unpair') {
    const id = ws._peerId;
    const p = peers.get(id);
    forgetPair(id);
    transfer.dropQueue(id);
    addLog('link', 'Unpaired by', p ? p.info.name : 'a device');
    try { ws.close(); } catch {}
    return;
  }
  if (msg.type === 'ping') { if (Number.isFinite(msg.n)) sendTo(ws, { type: 'pong', n: msg.n }); return; }
  if (msg.type === 'pong') { if (Number.isFinite(msg.n)) for (const [id, p] of peers) if (p.ws === ws) latency.onPong(id, msg.n); return; }
  if (typeof msg.type === 'string' && msg.type.startsWith('screen-')) { screenShare.onMessage(ws, msg); return; }
  if (typeof msg.type === 'string' && msg.type.startsWith('file-')) { transfer.onMessage(ws, msg); return; }
  if (typeof msg.type === 'string' && msg.type.startsWith('cmd-')) { remote.onMessage(ws, msg); return; }
  if (typeof msg.type === 'string' && msg.type.startsWith('fs-')) { storage.onMessage(ws, msg); return; }
  if (msg.type === 'clipboard') {
    if (!config.clipboardSync || typeof msg.text !== 'string' || !msg.text || msg.text.length > MAX_CLIP) return;
    lastClip = msg.text; // set first so the poller never echoes it back
    writeClip(msg.text);
    addLog('clip', 'Clipboard received', preview(msg.text));
  } else if (msg.type === 'battery') {
    if (!config.batterySync) return;
    const level = Math.round(Number(msg.level));
    if (!(level >= 0 && level <= 100)) return;
    for (const p of peers.values()) if (p.ws === ws) { p.info.battery = { level, charging: msg.charging === true }; pushState(); }
  } else if (msg.type === 'notification') {
    if (!config.notifySync) return;
    showNotification(String(msg.app || ''), String(msg.title || ''), String(msg.text || ''), typeof msg.icon === 'string' ? msg.icon : '');
  }
}
function startServer() {
  wss = new WebSocketServer({ port: WS_PORT });
  wss.on('connection', (ws, req) => attach(ws, req.socket.remoteAddress));
  wss.on('error', (e) => addLog('warn', 'Server error', e.message));
}
function dial(host, port, o, onFail) {
  const tag = host + ':' + port;
  if (pending.has(tag)) return false;
  pending.add(tag);
  let ws;
  try { ws = new WebSocket('ws://' + host + ':' + port, { handshakeTimeout: 4000, perMessageDeflate: false }); }
  catch { pending.delete(tag); if (onFail) onFail(); return false; }
  ws.on('open', () => attach(ws, host, o));
  ws.on('close', () => { pending.delete(tag); dropSocket(ws); });
  ws.on('error', () => { pending.delete(tag); if (onFail) onFail(); });
  return true;
}
const connectTo = (host, port, id) => dial(host, port, { mode: 'connect', id });

/* ---------- battery ---------- */
function sendBattery(ws) {
  if (!config.batterySync || !myBattery) return;
  const m = { type: 'battery', level: myBattery.level, charging: myBattery.charging };
  if (ws) sendTo(ws, m); else broadcast(m);
}
async function pollBattery() {
  let b = null;
  try { b = await battery.read(); } catch {}
  const changed = JSON.stringify(b) !== JSON.stringify(myBattery);
  myBattery = b;
  if (changed) sendBattery();
}

/* ---------- unpair ---------- */
// Every pair has its own code, so unpairing one device only forgets that device's code. Nothing else is affected,
// and pairing again simply creates a new random code.
function forgetPeer(id, why) {
  const p = peers.get(id);
  forgetPair(id);
  transfer.dropQueue(id);
  if (why) addLog('link', why, p ? p.info.name : id);
}
function unpairDevice(id) {
  const p = peers.get(id);
  if (!p) return false;
  sendTo(p.ws, { type: 'unpair' });   // tell the other side so it forgets this pair as well
  forgetPeer(id, 'Unpaired');
  setTimeout(() => { try { p.ws.close(); } catch {} }, 150);
  return true;
}

/* ---------- nearby devices & pairing ---------- */
// Nearby = devices running Y Connect on this network that we are not connected to (yet).
function nearbyList() {
  const now = Date.now();
  const out = [];
  for (const [id, n] of nearby) {
    if (now - n.seen > NEARBY_TTL) { nearby.delete(id); continue; }
    if (peers.has(id)) continue;
    out.push({ id: n.id, name: n.name, platform: n.platform, address: n.address });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
function refreshNearby() {
  const sig = nearbyList().map((n) => n.id + n.name + n.address).join('|');
  if (sig !== nearbySig) { nearbySig = sig; pushState(); }
}
const cleanStr = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').slice(0, max);
function noteNearby(j, rinfo) {
  const id = cleanStr(j.id, 64);
  if (!id) return;
  nearby.set(id, { id, name: cleanStr(j.name, 40) || 'Device', platform: cleanStr(j.platform, 16) || 'device', address: rinfo.address, port: Number(j.port) || WS_PORT, seen: Date.now() });
  refreshNearby();
}

// Pairing, from the point of view of the device that asks ("out") ...
function startPairOut(ws, id, name) {
  if (pairOut && pairOut.ws && pairOut.ws !== ws) { try { pairOut.ws.close(); } catch {} }
  const kp = pc.newKeyPair();
  ws._pair = { role: 'out', id, name, kp };
  pairOut = { id, name: name || 'Device', sas: '', state: 'waiting', ws };
  sendRaw(ws, { t: 'pair-req', id: config.id, name: config.name, platform: myPlatform(), pub: kp.pub });
  addLog('info', 'Pairing started', 'Waiting for ' + pairOut.name + ' to accept');
  pushState();
}
function requestPair(id) {
  const n = nearby.get(id);
  if (!n) return null;
  pairOut = { id, name: n.name, sas: '', state: 'waiting', ws: null };
  const ok = dial(n.address, n.port, { mode: 'pair', id, name: n.name }, () => { if (pairOut && pairOut.id === id && !pairOut.ws && pairOut.state === 'waiting') { pairOut.state = 'failed'; pushState(); } });
  if (!ok && pairOut && !pairOut.ws) pairOut.state = 'failed';
  pushState();
  return { name: n.name };
}
function cancelPair() {
  const o = pairOut;
  pairOut = null;
  if (o && o.ws) { try { o.ws.close(); } catch {} }
  pushState();
}
// ... and of the device that is asked ("in").
function onPairReq(ws, m) {
  const id = cleanStr(m.id, 64);
  if (!id || id === config.id || ws._pair || isPeerSocket(ws)) return;
  if (pairOut && pairOut.id === id && pairOut.state === 'waiting') {
    // both devices asked each other at the same moment: the one with the smaller id keeps its own request
    if (config.id < id) { sendRaw(ws, { t: 'pair-decline' }); try { ws.close(); } catch {} return; }
    cancelPair();
  }
  if (pairRequest) { sendRaw(ws, { t: 'pair-decline' }); try { ws.close(); } catch {} return; } // one question at a time
  let kp, secret;
  try { kp = pc.newKeyPair(); secret = pc.agree(kp.priv, m.pub); } catch { try { ws.close(); } catch {} return; }
  const name = cleanStr(m.name, 40) || 'Device';
  ws._pair = { role: 'in', id, name, secret, accepted: false };
  pairRequest = { id, name, address: ws._addr, sas: pc.checkNumber(secret, m.pub, kp.pub), time: Date.now(), ws };
  sendRaw(ws, { t: 'pair-pub', pub: kp.pub });
  addLog('info', 'Pairing request', name + ' wants to pair');
  if (Notification.isSupported()) {
    const n = new Notification({ title: name + ' wants to pair', body: 'Open Y Connect to accept or decline', icon: ICON });
    n.on('click', showWindow);
    n.show();
  }
  showWindow();
  pushState();
}
function acceptPair() {
  const r = pairRequest;
  if (!r || !r.ws || r.ws.readyState !== WebSocket.OPEN) { pairRequest = null; pushState(); return false; }
  r.ws._pair.accepted = true;
  sendRaw(r.ws, { t: 'pair-accept' });
  pairRequest = null;
  addLog('info', 'Pairing accepted', r.name);
  pushState();
  return true;
}
function declinePair() {
  const r = pairRequest;
  pairRequest = null;
  if (r && r.ws) { sendRaw(r.ws, { t: 'pair-decline' }); setTimeout(() => { try { r.ws.close(); } catch {} }, 200); addLog('info', 'Pairing declined', r.name); }
  pushState();
}

// plain (unencrypted) frames: only pairing and discovery of who is behind an address
function handlePlain(ws, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m !== 'object' || isPeerSocket(ws)) return;
  switch (m.t) {
    case 'who': // someone dialled our IP and asks who we are
      sendRaw(ws, { t: 'iam', id: config.id, name: config.name, platform: myPlatform() });
      break;
    case 'iam': { // answer to our probe: known device -> connect, new device -> ask it to pair
      if (ws._mode !== 'probe') return;
      const id = cleanStr(m.id, 64);
      if (!id || id === config.id) { try { ws.close(); } catch {} return; }
      if (pairKeys.has(id)) { ws._mode = 'connect'; useKey(ws, id); sayHello(ws); }
      else { ws._mode = 'pair'; startPairOut(ws, id, cleanStr(m.name, 40) || 'Device'); }
      break;
    }
    case 'unknown': // the device we dialled does not know us (it was unpaired there): forget it here too
      if (ws._mode === 'connect' && ws._peerId) {
        const name = (config.paired[ws._peerId] || {}).name || 'A device';
        forgetPeer(ws._peerId, 'No longer paired');
        addLog('info', 'Pair removed', name + ' no longer recognises this device. Pair again to reconnect.');
        try { ws.close(); } catch {}
      }
      break;
    case 'pair-req': onPairReq(ws, m); break;
    case 'pair-pub': { // out: the other device sent its half of the key exchange
      const pr = ws._pair;
      if (!pr || pr.role !== 'out' || pr.secret) return;
      try { pr.secret = pc.agree(pr.kp.priv, m.pub); } catch { try { ws.close(); } catch {} return; }
      if (pairOut && pairOut.ws === ws) { pairOut.sas = pc.checkNumber(pr.secret, pr.kp.pub, m.pub); pushState(); }
      break;
    }
    case 'pair-decline':
      if (ws._pair && ws._pair.role === 'out' && pairOut && pairOut.ws === ws) { pairOut.state = 'declined'; addLog('info', 'Pairing declined', pairOut.name + ' declined'); pushState(); }
      try { ws.close(); } catch {}
      break;
    case 'pair-accept': { // out: the other user tapped Accept -> create this pair's random code and hand it over
      const pr = ws._pair;
      if (!pr || pr.role !== 'out' || !pr.secret || pr.sent || !pairOut || pairOut.ws !== ws) return;
      pr.sent = true;
      const code = pc.randomCode();
      sendRaw(ws, { t: 'pair-code', d: pc.seal(pc.transportKey(pr.secret), code) });
      storePair(pr.id, pr.name, code);
      useKey(ws, pr.id);
      sayHello(ws);
      addLog('info', 'Paired', pr.name);
      break;
    }
    case 'pair-code': { // in: we accepted, now the code arrives
      const pr = ws._pair;
      if (!pr || pr.role !== 'in' || !pr.accepted || !pr.secret || pr.done) return;
      let code;
      try { code = pc.open(pc.transportKey(pr.secret), String(m.d || '')); } catch { try { ws.close(); } catch {} return; }
      if (!pc.validCode(code)) { try { ws.close(); } catch {} return; }
      pr.done = true;
      storePair(pr.id, pr.name, code);
      useKey(ws, pr.id);
      addLog('info', 'Paired', pr.name);
      break;
    }
  }
}

/* ---------- discovery (UDP broadcast) ---------- */
function broadcastTargets() {
  const t = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if ((i.family !== 'IPv4' && i.family !== 4) || i.internal) continue;
      const ip = i.address.split('.').map(Number), mask = i.netmask.split('.').map(Number);
      t.add(ip.map((o, n) => (o | (~mask[n] & 255))).join('.'));
    }
  }
  return [...t];
}
function beacon() {
  if (!udp) return;
  const msg = Buffer.from(JSON.stringify({ app: 'yconnect', id: config.id, name: config.name, platform: myPlatform(), port: WS_PORT }));
  for (const target of broadcastTargets()) { try { udp.send(msg, UDP_PORT, target, () => {}); } catch {} }
}
function startDiscovery() {
  udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('error', (e) => addLog('warn', 'Discovery error', e.message));
  udp.on('message', (buf, rinfo) => {
    try {
      const j = JSON.parse(buf.toString());
      if (j.app !== 'yconnect' || j.id === config.id) return;
      if (j.type) return; // pairing now runs over the WebSocket; other types come from newer versions
      noteNearby(j, rinfo);
      if (peers.has(j.id)) { waitingSince.delete(j.id); return; }
      if (!pairKeys.has(j.id)) return; // not paired: it only shows up under Nearby
      // the device with the smaller id dials, so two devices never connect to each other twice.
      // If the smaller one stays silent for a while (it forgot this pair), the other one dials too and learns that.
      const now = Date.now();
      if (!waitingSince.has(j.id)) waitingSince.set(j.id, now);
      if (config.id < j.id || now - waitingSince.get(j.id) > 9000) connectTo(rinfo.address, Number(j.port) || WS_PORT, j.id);
    } catch {}
  });
  udp.bind(UDP_PORT, () => { try { udp.setBroadcast(true); } catch {} beacon(); });
  setInterval(beacon, 3000);
  setInterval(refreshNearby, 2000); // drop devices that stopped announcing
}

/* ---------- clipboard ---------- */
// Newer Electron versions return Promises from clipboard calls, so always await them.
// On Wayland (niri, sway, Hyprland, GNOME, KDE) an app in the background may neither read nor set the clipboard
// through Electron. The wl-clipboard tools (wl-paste / wl-copy) can, so they are used when they are installed.
let useWl = null; // null = not checked yet
function hasBin(n) {
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    try { fs.accessSync(path.join(d, n), fs.constants.X_OK); return true; } catch {}
  }
  return false;
}
function wlOn() {
  if (useWl === null) useWl = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY && hasBin('wl-paste') && hasBin('wl-copy');
  return useWl;
}
function wlRead() {
  return new Promise((resolve) => {
    require('child_process').execFile('wl-paste', ['--no-newline', '--type', 'text'], { encoding: 'utf8', timeout: 1500, maxBuffer: 2 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) {
        // an empty or non-text clipboard is normal; a missing protocol means wl-clipboard cannot be used here
        if (err.code === 'ENOENT' || /does not support|failed to connect|data-control|compositor/i.test(String(errOut))) { useWl = false; resolve(null); }
        else resolve('');
        return;
      }
      resolve(typeof out === 'string' ? out : '');
    });
  });
}
function wlWrite(t) {
  return new Promise((resolve) => {
    try {
      const p = require('child_process').spawn('wl-copy', ['--type', 'text/plain'], { stdio: ['pipe', 'ignore', 'ignore'] });
      p.on('error', () => { useWl = false; resolve(false); });
      p.on('close', (code) => resolve(code === 0));
      p.stdin.on('error', () => {});
      p.stdin.end(t);
    } catch { useWl = false; resolve(false); }
  });
}
async function readClip() {
  if (wlOn()) {
    const v = await wlRead();
    if (v !== null) return v;
  }
  try { const v = await clipboard.readText(); return typeof v === 'string' ? v : ''; } catch { return ''; }
}
async function writeClip(t) {
  if (wlOn() && await wlWrite(t)) return;
  try { await clipboard.writeText(t); } catch {}
}
let polling = false;
async function pollClipboard() {
  if (polling) return;
  polling = true;
  try {
    const t = await readClip();
    if (!t || t === lastClip) return;
    lastClip = t;
    if (!config.clipboardSync || t.length > MAX_CLIP) return;
    if (broadcast({ type: 'clipboard', text: t, ts: Date.now() }) > 0) addLog('clip', 'Clipboard sent', preview(t));
  } finally { polling = false; }
}

/* ---------- window / tray ---------- */
function showWindow() { if (win) { win.show(); win.focus(); } }
function createWindow(show = true) {
  win = new BrowserWindow({
    show,
    width: 940, height: 660, minWidth: 720, minHeight: 520,
    backgroundColor: bgColor(), title: 'Y Connect', icon: ICON, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => { if (tray && !app.isQuitting) { e.preventDefault(); win.hide(); } });
}
function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 24, height: 24 }));
    tray.setToolTip('Y Connect');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Y Connect', click: showWindow },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  } catch { tray = null; }
}

/* ---------- IPC ---------- */
ipcMain.handle('state', () => snapshot());
const ALLOWED_LINKS = new Set(['https://discord.com/users/895560596064464956', 'https://www.reddit.com/user/yokeswaran_n']);
ipcMain.handle('open-external', (_e, url) => {
  if (!ALLOWED_LINKS.has(url) && !updates.SAFE_URL.test(String(url))) return false;
  shell.openExternal(url);
  return true;
});
ipcMain.handle('get-licenses', () => {
  const out = {};
  for (const [k, f] of [['gpl', 'LICENSE-GPL-3.0.txt'], ['third', 'THIRD-PARTY-NOTICES.txt']]) {
    try { out[k] = fs.readFileSync(path.join(__dirname, 'licenses', f), 'utf8'); } catch { out[k] = 'License file not found.'; }
  }
  return out;
});
ipcMain.handle('set-config', (_e, patch) => {
  const oldName = config.name;
  if (typeof patch.name === 'string' && patch.name.trim()) config.name = patch.name.trim().slice(0, 40);
  if (typeof patch.clipboardSync === 'boolean') config.clipboardSync = patch.clipboardSync;
  if (typeof patch.notifySync === 'boolean') config.notifySync = patch.notifySync;
  if (typeof patch.acceptFiles === 'boolean') config.acceptFiles = patch.acceptFiles;
  const oldHidden = config.startHidden;
  if (typeof patch.startHidden === 'boolean') config.startHidden = patch.startHidden;
  const startupChanged = typeof patch.launchOnStartup === 'boolean';
  const modeChanged = config.startHidden !== oldHidden && config.launchOnStartup; // the entry has to be rewritten with / without --hidden
  if (startupChanged || modeChanged) {
    const want = startupChanged ? patch.launchOnStartup : true;
    const r = autostart.set(want, config.startHidden);
    autostartError = r.ok ? null : { why: r.why, fix: r.fix };
    if (r.ok) config.launchOnStartup = want;
    else { config.launchOnStartup = autostart.isEnabled(); if (!startupChanged) config.startHidden = oldHidden; }
    if (!r.ok) addLog('warn', 'Launch on startup failed', r.why + ' ' + r.fix);
    else addLog('info', want ? 'Launch on startup: on' : 'Launch on startup: off', want ? (config.startHidden ? 'Starts hidden in the tray' : 'Shows the window') : '');
  } else if (config.startHidden !== oldHidden) addLog('info', 'Startup mode saved', config.startHidden ? 'Starts hidden in the tray' : 'Shows the window');
  if (typeof patch.batterySync === 'boolean') { config.batterySync = patch.batterySync; if (config.batterySync) sendBattery(); }
  if (typeof patch.adbPath === 'string') config.adbPath = patch.adbPath.trim().slice(0, 500);
  if (typeof patch.allowCommands === 'boolean') config.allowCommands = patch.allowCommands;
  if (typeof patch.allowControl === 'boolean') { config.allowControl = patch.allowControl; screenShare.onConfigChanged(); }
  if (typeof patch.systemColors === 'boolean') config.systemColors = patch.systemColors;
  const wantUpd = typeof patch.autoUpdateCheck === 'boolean' && patch.autoUpdateCheck && !config.autoUpdateCheck;
  if (typeof patch.autoUpdateCheck === 'boolean') config.autoUpdateCheck = patch.autoUpdateCheck;
  if (['system', 'light', 'dark'].includes(patch.theme)) {
    config.theme = patch.theme;
    nativeTheme.themeSource = patch.theme;
    if (win && !win.isDestroyed()) win.setBackgroundColor(bgColor());
  }
  saveConfig();
  if (config.name !== oldName) broadcast(helloMsg());
  if (wantUpd) checkForUpdates(true); // switched on: check right away so the result is visible
  pushState();
  return snapshot();
});
// Phone storage as a drive / network location (see storage.js). The phone has to switch sharing on itself.
ipcMain.handle('storage-mount', async (_e, id) => {
  const p = peers.get(String(id));
  if (!p) return { ok: false, error: 'The phone is not connected.' };
  if (p.info.platform !== 'android') return { ok: false, error: 'Only a phone can share its storage.' };
  const r = await storage.mount(p.info.id, p.info.name);
  if (r.ok && r.drive) shell.openPath(r.drive + '\\');
  else if (r.ok && r.via === 'gio') require('child_process').execFile('gio', ['open', r.dav], () => {});
  pushState();
  return r;
});
ipcMain.handle('storage-unmount', async (_e, id) => { const ok = await storage.unmount(String(id)); pushState(); return ok; });
ipcMain.handle('unpair', (_e, id) => unpairDevice(String(id)));
ipcMain.handle('pair-request', (_e, id) => requestPair(String(id)));
ipcMain.handle('pair-cancel', () => { cancelPair(); return true; });
ipcMain.handle('pair-accept', () => acceptPair());
ipcMain.handle('pair-decline', () => { declinePair(); return true; });
ipcMain.handle('connect-ip', (_e, host) => {
  host = String(host || '').trim();
  if (!/^[A-Za-z0-9.\-]{1,253}$/.test(host)) return false;
  dial(host, WS_PORT, { mode: 'probe' });
  return true;
});
ipcMain.handle('send-clipboard', async () => {
  const t = await readClip();
  if (!t) return 0;
  lastClip = t;
  const n = broadcast({ type: 'clipboard', text: t, ts: Date.now() });
  if (n > 0) addLog('clip', 'Clipboard sent', preview(t));
  return n;
});
/* ---------- device info / debug report ---------- */
const infoExtra = () => ({ label: VERSION_LABEL, startup: { enabled: autostart.isEnabled(), hidden: config.startHidden !== false }, tray: !!tray, battery: !!myBattery });
// the Settings page only needs the short version, which is gathered once (it starts a few system commands)
let infoCache = null;
const loadInfo = () => infoCache || (infoCache = deviceinfo.collect(infoExtra()));
ipcMain.handle('device-info', async () => ({ brief: (await loadInfo()).brief }));

/* ---------- update check ---------- */
async function checkForUpdates(notify) {
  const r = await updates.check(VERSION_LABEL, (u, o) => net.fetch(u, o));
  updateInfo = r;
  if (r.ok) { config.lastUpdateCheck = Date.now(); saveConfig(); }
  if (r.ok && r.newer) {
    addLog('info', 'Update available', r.latest + ' is out (you have ' + VERSION_LABEL + ')');
    if (notify && Notification.isSupported() && config.notifiedVersion !== r.latest) {
      config.notifiedVersion = r.latest; saveConfig();
      const n = new Notification({ title: 'Y Connect ' + r.latest + ' is available', body: 'Click to see what’s new and download it.', icon: ICON });
      n.on('click', () => shell.openExternal(r.url));
      n.show();
    }
  }
  pushState();
  return r;
}
ipcMain.handle('check-update', () => checkForUpdates(false));
const autoCheckDue = () => config.autoUpdateCheck && Date.now() - (config.lastUpdateCheck || 0) > 24 * 3600 * 1000;

const debugReport = async () => deviceinfo.toText(await deviceinfo.collect(infoExtra()), logEntries); // full details, built only when asked for
ipcMain.handle('copy-debug-report', async () => {
  const t = await debugReport();
  lastClip = t; // so the clipboard watcher does not send the report to the other devices
  await writeClip(t);
  return true;
});
ipcMain.handle('save-debug-report', async () => {
  const r = await dialog.showSaveDialog(win, { title: 'Save debug report', defaultPath: path.join(app.getPath('documents'), 'y-connect-debug.txt'), filters: [{ name: 'Text', extensions: ['txt'] }] });
  if (r.canceled || !r.filePath) return false;
  try { fs.writeFileSync(r.filePath, await debugReport()); return true; } catch (e) { addLog('warn', 'Could not save debug report', e.message); return false; }
});
ipcMain.handle('ping-now', (_e, id) => { latency.burst(String(id)); return true; });
ipcMain.handle('test-notification', () => {
  return broadcast({ type: 'notification', app: 'Y Connect', title: 'Test from ' + config.name, text: 'Notification sync works!', ts: Date.now() });
});

/* ---------- lifecycle ---------- */
app.on('second-instance', showWindow);
app.on('before-quit', () => { app.isQuitting = true; storage.unmountAll().catch(() => {}); });
app.on('window-all-closed', () => { if (!tray) app.quit(); });
app.whenReady().then(() => {
  legacy.run(); // remove menu / startup entries and icons left by the previous name
  integrateDesktop();
  Menu.setApplicationMenu(null);
  loadConfig();
  loadKeys();
  startServer();
  startDiscovery();
  remote.init({ peers, sendTo, getConfig: () => config, addLog });
  storage.init({ peers, sendTo, addLog, pushState });
  screenShare.init({ peers, sendTo, encryptBin: (buf, ws) => pc.sealBytes(ws._key, buf), getConfig: () => config, addLog, pushState, icon: ICON });
  transfer.init({ peers, sendTo, encryptBin: (buf, ws) => pc.sealBytes(ws._key, buf), getConfig: () => config, addLog, pushState, getWin: () => win, icon: ICON });
  createTray();
  createWindow(!(startHidden && tray)); // started by autostart: stay in the tray (but show the window if there is no tray)
  if (config.launchOnStartup) { const r = autostart.set(true, config.startHidden); if (!r.ok) { autostartError = { why: r.why, fix: r.fix }; addLog('warn', 'Launch on startup failed', r.why + ' ' + r.fix); } } // refreshes the path if the app was moved
  nativeTheme.on('updated', () => {
    if (win && !win.isDestroyed()) win.setBackgroundColor(bgColor());
    pushState();
  });
  if (process.platform === 'win32') systemPreferences.on('accent-color-changed', () => pushState());
  readClip().then((t) => { lastClip = t; });
  setInterval(pollClipboard, 700);
  startNotifWatch();
  pollBattery();
  loadInfo().then((i) => addLog('info', 'Device info', i.summary)).catch(() => {});
  setTimeout(() => { if (autoCheckDue()) checkForUpdates(true); }, 15000); // not during start-up
  setInterval(() => { if (autoCheckDue()) checkForUpdates(true); }, 6 * 3600 * 1000);
  setInterval(pollBattery, 60000);
  setInterval(() => latency.tick(!!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()), 2000);
  setInterval(() => {
    for (const p of peers.values()) {
      if (p.ws.isAlive === false) { p.ws.terminate(); continue; }
      p.ws.isAlive = false;
      try { p.ws.ping(); } catch {}
    }
  }, 15000);
});
