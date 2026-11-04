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
const remote = require('./remote');
const battery = require('./battery');
const autostart = require('./autostart');
const deviceinfo = require('./deviceinfo');
const updates = require('./updates');
const legacy = require('./legacy');
const latency = require('./latency').create({
  ids: () => [...peers.keys()],
  send: (id, obj) => { const p = peers.get(id); if (p) sendTo(p.ws, obj); },
  onChange: (id) => { if (win && !win.isDestroyed()) win.webContents.send('latency', id, latency.stats(id)); },
});

const VERSION_LABEL = 'v1.1';
const WS_PORT = 48998;
const UDP_PORT = 48999;
const SALT = 'y-connect-v1';
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
let key = null, config = null, lastClip = '', pushTimer = null;
let logEntries = [];
let autostartError = null; // { why, fix } when the last attempt to change launch-on-startup failed
const startHidden = process.argv.includes('--hidden');
let updateInfo = null;     // result of the last update check (shown in Settings)
let myBattery = null;      // { level, charging } or null when this computer has no battery
const peers = new Map();   // device id -> { ws, info }
const pending = new Set(); // outgoing connections in progress
const nearby = new Map();  // device id -> { id, name, platform, address, port, seen }  (every Y Connect heard on the LAN)
const NEARBY_TTL = 10000;
let pairRequest = null;    // { id, name, address, time } - another device wants to pair with us
let nearbySig = '';
const myPlatform = () => (process.platform === 'win32' ? 'windows' : 'linux');

/* ---------- config ---------- */
function randomCode() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += a[crypto.randomInt(a.length)];
  return s.slice(0, 4) + '-' + s.slice(4);
}
function loadConfig() {
  const file = path.join(app.getPath('userData'), 'config.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  config = Object.assign({
    id: crypto.randomUUID(),
    name: os.hostname(),
    passphrase: randomCode(),
    clipboardSync: true,
    notifySync: true,
    acceptFiles: true,
    launchOnStartup: false, // start with the computer when you log in (Windows / Linux)
    startHidden: true,    // when launching on startup: stay in the tray (true) or show the window (false)
    batterySync: true,    // share this computer's battery level and show the phone's
    allowCommands: false, // phone may run commands here (never with sudo/admin). Off until the user turns it on
    theme: 'system', // system | light | dark
    systemColors: true, // follow the OS accent colour; off = Y Connect blue
    ignored: [], // ids of devices that were unpaired: never auto-connect to them
    autoUpdateCheck: false, // opt-in: look for a newer release about once a day and show a notification
    lastUpdateCheck: 0,
    notifiedVersion: '',
  }, saved);
  if (!Array.isArray(config.ignored)) config.ignored = [];
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

/* ---------- crypto (AES-256-GCM, key from pairing code) ---------- */
const norm = (p) => (String(p).toUpperCase().replace(/[^A-Z0-9]/g, '') || '-');
function deriveKey() { key = crypto.pbkdf2Sync(norm(config.passphrase), SALT, 100000, 32, 'sha256'); }
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, enc, c.getAuthTag()]).toString('base64');
}
function decrypt(str) {
  const b = Buffer.from(str, 'base64');
  if (b.length < 29) throw new Error('short');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(b.length - 16));
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8'));
}

// binary frames (file data): iv[12] + ciphertext + tag[16]
function encryptBin(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, enc, c.getAuthTag()]);
}
function decryptBin(b) {
  if (b.length < 29) throw new Error('short');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]);
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
  return { config, peers: [...peers.values()].map((p) => ({ ...p.info, lat: latency.stats(p.info.id) })), nearby: nearbyList(), pairRequest, log: logEntries, ips: localIps(), version: VERSION_LABEL, accent: accentColor(), platform: process.platform, update: updateInfo && updateInfo.newer ? updateInfo : null, transfers: transfer.list(), autostart: { supported: autostart.supported, enabled: autostart.isEnabled(), hidden: config.startHidden !== false, error: autostartError } };
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
function sendTo(ws, obj) { try { if (ws.readyState === WebSocket.OPEN) ws.send(encrypt(obj)); } catch {} }
function broadcast(obj) {
  const data = encrypt(obj);
  let n = 0;
  for (const p of peers.values()) if (p.ws.readyState === WebSocket.OPEN) { p.ws.send(data); n++; }
  return n;
}
function closeAll() {
  for (const p of peers.values()) { try { p.ws.close(); } catch {} }
  peers.clear();
  pushState();
}
function dropSocket(ws) {
  transfer.onDisconnected(ws);
  remote.onDisconnected(ws);
  for (const [id, p] of peers) {
    if (p.ws === ws) { peers.delete(id); latency.drop(id); addLog('link', 'Disconnected', p.info.name); }
  }
  pushState();
}
function attach(ws, addr) {
  ws._addr = String(addr || '?').replace(/^::ffff:/, '');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => (isBinary ? handleBinary(ws, data) : handle(ws, data.toString())));
  ws.on('close', () => dropSocket(ws));
  ws.on('error', () => {});
  sendTo(ws, helloMsg());
}
function handleBinary(ws, data) {
  if (![...peers.values()].some((p) => p.ws === ws)) return;
  let plain;
  try { plain = decryptBin(Buffer.isBuffer(data) ? data : Buffer.concat(data)); }
  catch { try { ws.close(); } catch {} return; }
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
  let msg;
  try { msg = decrypt(raw); } catch {
    // Not decryptable: drop it silently. An unknown socket is closed; an already connected peer stays connected.
    if (![...peers.values()].some((p) => p.ws === ws)) { try { ws.close(); } catch {} }
    return;
  }
  if (msg.type === 'hello') {
    if (msg.id === config.id || isIgnored(msg.id)) { ws.close(); return; }
    const old = peers.get(msg.id);
    const isNew = !old || old.ws !== ws;
    if (old && old.ws !== ws) { peers.delete(msg.id); try { old.ws.close(); } catch {} }
    peers.set(msg.id, { ws, info: { id: msg.id, name: String(msg.name || 'Device'), platform: String(msg.platform || '?'), address: ws._addr } });
    if (isNew) { addLog('link', 'Connected', String(msg.name || 'Device')); latency.reset(msg.id); latency.ping(msg.id); setTimeout(() => transfer.onPeerConnected(msg.id), 1500); }
    if (pairRequest && pairRequest.id === msg.id) pairRequest = null;
    nearbySig = '';
    sendBattery(ws);
    pushState();
    return;
  }
  if (![...peers.values()].some((p) => p.ws === ws)) return;
  if (msg.type === 'unpair') {
    for (const [id, p] of peers) {
      if (p.ws === ws) { ignoreDevice(id); addLog('link', 'Unpaired by', p.info.name); }
    }
    try { ws.close(); } catch {}
    return;
  }
  if (msg.type === 'ping') { if (Number.isFinite(msg.n)) sendTo(ws, { type: 'pong', n: msg.n }); return; }
  if (msg.type === 'pong') { if (Number.isFinite(msg.n)) for (const [id, p] of peers) if (p.ws === ws) latency.onPong(id, msg.n); return; }
  if (typeof msg.type === 'string' && msg.type.startsWith('file-')) { transfer.onMessage(ws, msg); return; }
  if (typeof msg.type === 'string' && msg.type.startsWith('cmd-')) { remote.onMessage(ws, msg); return; }
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
function connectTo(host, port) {
  const tag = host + ':' + port;
  if (pending.has(tag)) return;
  pending.add(tag);
  let ws;
  try { ws = new WebSocket('ws://' + host + ':' + port, { handshakeTimeout: 4000 }); }
  catch { pending.delete(tag); return; }
  ws.on('open', () => attach(ws, host));
  ws.on('close', () => { pending.delete(tag); dropSocket(ws); });
  ws.on('error', () => { pending.delete(tag); });
}

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
const isIgnored = (id) => config.ignored.includes(id);
function ignoreDevice(id) { if (!isIgnored(id)) { config.ignored.push(id); saveConfig(); } }
function unignoreDevice(id) { const i = config.ignored.indexOf(id); if (i >= 0) { config.ignored.splice(i, 1); saveConfig(); } }
function unpairDevice(id) {
  const p = peers.get(id);
  if (!p) return false;
  sendTo(p.ws, { type: 'unpair' });   // tell the other side so it stops reconnecting as well
  ignoreDevice(id);
  transfer.dropQueue(id);
  addLog('link', 'Unpaired', p.info.name);
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
function udpSend(obj, address) {
  if (!udp) return;
  try { udp.send(Buffer.from(JSON.stringify(obj)), UDP_PORT, address, () => {}); } catch {}
}
// The pairing code itself is never sent over the network - the request only makes the other device ask for it.
function sendPairRequest(id) {
  const n = nearby.get(id);
  if (!n) return null;
  unignoreDevice(id);
  const msg = { app: 'yconnect', type: 'pair-request', id: config.id, name: config.name, platform: myPlatform() };
  udpSend(msg, n.address);
  setTimeout(() => udpSend(msg, n.address), 400); // UDP can drop packets
  addLog('info', 'Pairing started', 'Enter the code on ' + n.name);
  return { code: config.passphrase, name: n.name };
}
function cancelPair(id) {
  const n = nearby.get(id);
  if (n) udpSend({ app: 'yconnect', type: 'pair-cancel', id: config.id }, n.address);
}
function onPairRequest(j, rinfo) {
  const id = cleanStr(j.id, 64);
  if (!id || peers.has(id)) return;
  unignoreDevice(id);
  if (pairRequest && pairRequest.id === id && Date.now() - pairRequest.time < 2000) return; // duplicate packet
  pairRequest = { id, name: cleanStr(j.name, 40) || 'Device', address: rinfo.address, time: Date.now() };
  addLog('info', 'Pairing request', pairRequest.name + ' wants to pair');
  if (Notification.isSupported()) {
    const n = new Notification({ title: pairRequest.name + ' wants to pair', body: 'Enter the pairing code shown on ' + pairRequest.name, icon: ICON });
    n.on('click', showWindow);
    n.show();
  }
  showWindow();
  pushState();
}
function onPairCancel(j) {
  if (pairRequest && pairRequest.id === cleanStr(j.id, 64)) { pairRequest = null; pushState(); }
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
      if (j.type === 'pair-request') return onPairRequest(j, rinfo);
      if (j.type === 'pair-cancel') return onPairCancel(j);
      if (j.type) return; // unknown message from a newer version
      noteNearby(j, rinfo);
      if (peers.has(j.id)) return;
      // the device with the smaller id dials, so two devices never connect to each other twice
      if (config.id < j.id && !isIgnored(j.id)) connectTo(rinfo.address, Number(j.port) || WS_PORT);
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
  const oldPass = norm(config.passphrase), oldName = config.name;
  if (typeof patch.name === 'string' && patch.name.trim()) config.name = patch.name.trim().slice(0, 40);
  if (typeof patch.passphrase === 'string' && patch.passphrase.trim()) config.passphrase = patch.passphrase.trim().slice(0, 64);
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
  if (typeof patch.allowCommands === 'boolean') config.allowCommands = patch.allowCommands;
  if (typeof patch.systemColors === 'boolean') config.systemColors = patch.systemColors;
  const wantUpd = typeof patch.autoUpdateCheck === 'boolean' && patch.autoUpdateCheck && !config.autoUpdateCheck;
  if (typeof patch.autoUpdateCheck === 'boolean') config.autoUpdateCheck = patch.autoUpdateCheck;
  if (['system', 'light', 'dark'].includes(patch.theme)) {
    config.theme = patch.theme;
    nativeTheme.themeSource = patch.theme;
    if (win && !win.isDestroyed()) win.setBackgroundColor(bgColor());
  }
  saveConfig();
  if (norm(config.passphrase) !== oldPass) { config.ignored = []; saveConfig(); deriveKey(); closeAll(); addLog('info', 'Pairing code changed', 'Reconnecting…'); }
  else if (config.name !== oldName) broadcast(helloMsg());
  if (wantUpd) checkForUpdates(true); // switched on: check right away so the result is visible
  pushState();
  return snapshot();
});
ipcMain.handle('unpair', (_e, id) => unpairDevice(String(id)));
ipcMain.handle('pair-request', (_e, id) => sendPairRequest(String(id)));
ipcMain.handle('pair-cancel', (_e, id) => { cancelPair(String(id)); return true; });
ipcMain.handle('dismiss-pair', () => { pairRequest = null; pushState(); return true; });
ipcMain.handle('connect-ip', (_e, host) => {
  host = String(host || '').trim();
  if (!/^[A-Za-z0-9.\-]{1,253}$/.test(host)) return false;
  connectTo(host, WS_PORT);
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
app.on('before-quit', () => { app.isQuitting = true; });
app.on('window-all-closed', () => { if (!tray) app.quit(); });
app.whenReady().then(() => {
  legacy.run(); // remove menu / startup entries and icons left by the previous name
  integrateDesktop();
  Menu.setApplicationMenu(null);
  loadConfig();
  deriveKey();
  startServer();
  startDiscovery();
  remote.init({ peers, sendTo, getConfig: () => config, addLog });
  transfer.init({ peers, sendTo, encryptBin, getConfig: () => config, addLog, pushState, getWin: () => win, icon: ICON });
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
