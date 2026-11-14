// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
/*
 * Screen sharing over the already-encrypted Y Connect WebSocket (either direction). The viewer can also control the shared device when the sharer allows it.
 *
 *   sharer                                    viewer
 *   screen-start {sid,w,h}   ------->          opens the viewer
 *   binary frames: AES-GCM( uint32 0 + uint32 sid + JPEG )  ------->   (many, newest wins)
 *   screen-stop {sid}        ------->  or  <-------   (the viewer closing its window also stops the sharer)
 *
 * Remote control (optional, off unless the sharer turned "Allow remote control" on):
 *   screen-start {ctl:true}  the sharer allows control          screen-ctl {sid,on}  the sharer switches it on / off while sharing
 *   screen-input {sid,ev}    viewer -> sharer, ev as described in inputctl.js (coordinates are 0..1 of the picture)
 * The sharer checks every input event itself: right socket, right sid, control on, rate limit, then inputctl.sanitize.
 *
 * Controlling a PHONE from this computer: besides the screen-input path above (which needs the phone's accessibility service),
 * the viewer window can use ADB / Wireless debugging (adbctl.js): input then goes straight from this computer to the phone's adbd
 * through the scrcpy-server control channel. The phone owner allows it by pairing in Developer options; nothing is sent over Y Connect.
 *
 * Binary frames share the socket with file transfers. File transfer ids are never 0, so tid 0 marks a screen frame and
 * older versions (which look the id up and find nothing) simply ignore them.
 *
 * Capturing (this computer -> phone) runs in a hidden window (renderer/capture.js), because getUserMedia needs a renderer.
 * Viewing (phone -> this computer) is a plain window (renderer/viewer.js) that draws the newest JPEG on a canvas.
 */
const path = require('path');
const crypto = require('crypto');
const { BrowserWindow, desktopCapturer, ipcMain, screen: displays } = require('electron');
const { WebSocket } = require('ws');
const inputctl = require('./inputctl');
const adbctl = require('./adbctl');

const MAX_FRAME = 6 * 1024 * 1024;   // a bigger "JPEG" than this is not from us
const BUSY = 96 * 1024;              // socket has this much queued (a slow link, or a file is being sent): drop frames instead of letting them pile up as lag
const OPTS = { maxDim: 1280, fps: 20, quality: 0.5 };

let D = null;
let share = null; // { peerId, ws, sid, win, announced, ctl, ctlOn, bucket }   this computer is sharing
let view = null;  // { peerId, ws, sid, win, name, closing, ctl, android, landscape, adb, adbBusy } this computer is watching
let adbApi = null;
const adbc = () => adbApi || (adbApi = adbctl.createAdb(() => ({ adbPath: D.getConfig().adbPath })));

const hdr = (sid) => { const b = Buffer.alloc(8); b.writeUInt32BE(0, 0); b.writeUInt32BE(sid, 4); return b; };
const peerOf = (ws) => { for (const [id, p] of D.peers) if (p.ws === ws) return { id, name: p.info.name }; return null; };
const alive = (w) => w && !w.isDestroyed();

function state() {
  return { sharing: share ? share.peerId : null, viewing: view ? view.peerId : null, controlled: !!(share && share.ctlOn), adbControl: !!(view && view.adb) };
}

/* ---------- remote control of this computer ---------- */
let ctlr = null;
function geometry() {
  const d = displays.getPrimaryDisplay();
  return { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, scale: d.scaleFactor || 1 };
}
const control = () => ctlr || (ctlr = inputctl.createController({ getGeometry: geometry }));
const RATE = 400;   // input events per second a viewer may send
function setControl(on, notify) {
  const s = share;
  if (!s) return;
  on = !!on && s.ctl;
  if (s.ctlOn === on) return;
  s.ctlOn = on;
  if (!on && ctlr) ctlr.releaseAll();
  if (notify && s.announced) D.sendTo(s.ws, { type: 'screen-ctl', sid: s.sid, on });
  D.addLog('info', on ? 'Remote control on' : 'Remote control off', s.name);
  D.pushState();
}
function onInput(ws, sid, ev) {
  const s = share;
  if (!s || !s.ctlOn || s.ws !== ws || s.sid !== sid) return;
  const now = Date.now();
  s.bucket = Math.min(RATE, s.bucket + (now - s.last) * RATE / 1000); s.last = now;
  if (s.bucket < 1) return;
  s.bucket--;
  control().handle(ev);
}
/** Called when the user changes the setting: turning it off ends control straight away. */
function onConfigChanged() {
  if (share && D.getConfig().allowControl !== true) { share.ctl = false; setControl(false, true); }
}

/* ---------- this computer shares its screen ---------- */
async function startShare(peerId) {
  const p = D.peers.get(peerId);
  if (!p) return { ok: false, error: 'Device is not connected' };
  if (share) return { ok: false, error: 'Already sharing the screen' };
  let sourceId;
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    if (!sources.length) return { ok: false, error: 'No screen found to share' };
    const primary = String(displays.getPrimaryDisplay().id);
    sourceId = (sources.find((s) => s.display_id === primary) || sources[0]).id;
  } catch (e) { return { ok: false, error: 'Screen capture is not allowed: ' + e.message }; }
  if (share || !D.peers.has(peerId)) return { ok: false, error: 'Device is not connected' };

  const win = new BrowserWindow({
    show: false, width: 320, height: 240,
    webPreferences: { preload: path.join(__dirname, 'capture-preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const s = { peerId, ws: p.ws, sid: crypto.randomInt(1, 0xffffffff), win, announced: false, name: p.info.name, ctl: false, ctlOn: false, bucket: RATE, last: Date.now() };
  if (D.getConfig().allowControl === true) {
    const a = control().available();
    if (a.ok) { s.ctl = true; s.ctlOn = true; } else D.addLog('warn', 'Remote control is not available', a.hint);
  }
  share = s;
  win.on('closed', () => { if (share === s) stopShare(true); });
  win.webContents.on('did-finish-load', () => { if (alive(win)) win.webContents.send('capture-start', { sourceId, ...OPTS }); });
  win.loadFile(path.join(__dirname, 'renderer', 'capture.html')).catch(() => stopShare(true));
  D.addLog('info', 'Sharing screen', 'with ' + p.info.name);
  D.pushState();
  return { ok: true };
}
function stopShare(notify) {
  const s = share;
  if (!s) return;
  share = null;
  if (ctlr) ctlr.releaseAll();
  if (notify && s.announced) D.sendTo(s.ws, { type: 'screen-stop', sid: s.sid });
  if (alive(s.win)) s.win.destroy();
  D.addLog('info', 'Screen sharing stopped', s.name);
  D.pushState();
}
/** One JPEG from the hidden capture window. Returns false when the frame was dropped (the capturer then slows down). */
function onCaptured(event, data, w, h) {
  const s = share;
  if (!s || !alive(s.win) || event.sender !== s.win.webContents) return false;
  if (s.ws.readyState !== WebSocket.OPEN) { stopShare(false); return false; }
  if (!(data instanceof Uint8Array)) return false;
  const jpeg = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (!jpeg.length || jpeg.length > MAX_FRAME) return false;
  if (!s.announced) {
    s.announced = true;
    D.sendTo(s.ws, { type: 'screen-start', sid: s.sid, w: Number(w) | 0, h: Number(h) | 0, ctl: s.ctlOn });
  }
  if (s.ws.bufferedAmount > BUSY) return false;
  s.ws.send(D.encryptBin(Buffer.concat([hdr(s.sid), jpeg]), s.ws));
  return true;
}

/* ---------- this computer watches the phone ---------- */
function openViewer(p, sid) {
  if (view) closeViewer(true);
  const win = new BrowserWindow({
    width: 420, height: 860, minWidth: 240, minHeight: 240, backgroundColor: '#000000', title: p.name + ' — screen', icon: D.icon, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'viewer-preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: true },
  });
  const peer = D.peers.get(p.id);
  const v = { peerId: p.id, ws: peerWs(p.id), sid, win, name: p.name, closing: false, ctl: false, android: !!(peer && peer.info.platform === 'android'), landscape: false, adb: null, adbBusy: false };
  view = v;
  win.on('closed', () => {
    if (view !== v) return;
    view = null;
    stopAdb(v, false);
    if (!v.closing && v.ws && v.ws.readyState === WebSocket.OPEN) D.sendTo(v.ws, { type: 'screen-stop', sid: v.sid }); // user closed the window
    D.pushState();
  });
  win.webContents.on('did-finish-load', () => { if (view === v && alive(win)) { win.webContents.send('viewer-info', { android: v.android }); win.webContents.send('viewer-ctl', v.ctl); } });
  win.loadFile(path.join(__dirname, 'renderer', 'viewer.html'));
  D.addLog('info', 'Watching screen', p.name);
  D.pushState();
}
function setViewCtl(on) {
  if (!view) return;
  view.ctl = on;
  if (alive(view.win)) try { view.win.webContents.send('viewer-ctl', on); } catch {}
}
const peerWs = (id) => { const p = D.peers.get(id); return p ? p.ws : null; };
function closeViewer(silent) {
  const v = view;
  if (!v) return;
  v.closing = !!silent;
  view = null;
  stopAdb(v, false);
  if (alive(v.win)) v.win.destroy();
  D.pushState();
}

/* ---------- messages from the other device ---------- */
function onMessage(ws, msg) {
  const sid = Number(msg.sid);
  if (!Number.isInteger(sid) || sid <= 0) return;
  const p = peerOf(ws);
  if (!p) return;
  if (msg.type === 'screen-start') {
    if (D.getConfig().acceptScreen === false) { D.sendTo(ws, { type: 'screen-stop', sid }); return; }
    openViewer(p, sid);
    if (msg.ctl === true) setViewCtl(true);
  } else if (msg.type === 'screen-ctl') {
    if (view && view.ws === ws && view.sid === sid) setViewCtl(msg.on === true);
  } else if (msg.type === 'screen-input') {
    onInput(ws, sid, msg.ev);
  } else if (msg.type === 'screen-stop') {
    if (view && view.ws === ws && view.sid === sid) { D.addLog('info', 'Screen sharing ended', p.name); closeViewer(true); }
    if (share && share.ws === ws && share.sid === sid) stopShare(false); // the viewer closed its window
  }
}
/** A binary frame with tid 0: uint32 0 + uint32 sid + JPEG. */
function onFrame(ws, plain) {
  const v = view;
  if (!v || v.ws !== ws || plain.length < 9 || plain.length > MAX_FRAME || plain.readUInt32BE(4) !== v.sid || !alive(v.win)) return;
  try { v.win.webContents.send('viewer-frame', plain.subarray(8)); } catch {}
}
function onDisconnected(ws) {
  if (share && share.ws === ws) stopShare(false);
  if (view && view.ws === ws) closeViewer(true);
}
/** The viewer window sends what the user did with the mouse / keyboard. */
function onViewerInput(e, ev) {
  const v = view;
  if (!v || !alive(v.win) || e.sender !== v.win.webContents) return;
  if (v.adb) { // control over ADB: straight to the phone, nothing is sent through Y Connect
    const clean = inputctl.sanitize(ev);
    if (!clean) return;
    if (clean.k === 'release') v.adb.session.release(); else v.adb.session.handle(clean);
    return;
  }
  if (!v.ctl) return;
  if (!v.ws || v.ws.readyState !== WebSocket.OPEN) return;
  D.sendTo(v.ws, { type: 'screen-input', sid: v.sid, ev });
}

/* ---------- controlling the phone over ADB ---------- */
function stopAdb(v, tellViewer) {
  const a = v && v.adb;
  if (!a) return;
  v.adb = null;
  try { a.session.close(); } catch {}
  D.addLog('info', 'ADB control stopped', v.name);
  if (tellViewer && alive(v.win)) try { v.win.webContents.send('adb-ended'); } catch {}
  D.pushState();
}
const fromViewer = (e) => { const v = view; return v && alive(v.win) && e.sender === v.win.webContents ? v : null; };

async function adbStart(e) {
  const v = fromViewer(e);
  if (!v) return { ok: false, error: 'No screen is being shown.' };
  if (!v.android) return { ok: false, error: 'ADB control is only for Android phones.' };
  if (v.adb) return { ok: true, mode: v.adb.session.mode };
  if (v.adbBusy) return { ok: false, error: 'Still connecting…' };
  const p = D.peers.get(v.peerId);
  if (!p) return { ok: false, error: 'Device is not connected.' };
  v.adbBusy = true;
  try {
    const r = await adbc().ensure(p.info.address);
    if (!r.ok) return { ...r, disc: await adbc().discover(p.info.address) };
    if (view !== v) return { ok: false, error: 'The viewer was closed.' };
    const o = await adbctl.openSession({
      adb: r.adb, serial: r.serial, jar: adbctl.findServerJar(),
      getLandscape: () => v.landscape,
      log: (m) => D.addLog('warn', 'ADB control', m),
      onClosed: (why) => { if (v.adb && v.adb.session === sess) { stopAdb(v, true); D.addLog('warn', 'ADB control ended', String(why || '')); } },
    });
    if (!o.ok) return o;
    const sess = o.session;
    if (view !== v) { sess.close(); return { ok: false, error: 'The viewer was closed.' }; }
    v.adb = { session: sess, serial: r.serial };
    D.addLog('info', 'Controlling ' + v.name + ' over ADB', sess.mode === 'scrcpy' ? 'fast mode' : 'basic mode (scrcpy-server unavailable)');
    D.pushState();
    return { ok: true, mode: sess.mode, model: r.model || '' };
  } catch (err) {
    return { ok: false, error: 'ADB control failed: ' + (err && err.message || err) };
  } finally { v.adbBusy = false; }
}
async function adbPair(e, hostPort, code) {
  const v = fromViewer(e);
  if (!v) return { ok: false, error: 'No screen is being shown.' };
  const r = await adbc().pair(String(hostPort || '').trim(), String(code || '').trim());
  if (!r.ok) return r;
  D.addLog('info', 'Paired with the phone for ADB', v.name);
  return adbStart(e); // pairing succeeded: find the connect port (mDNS) and start
}
async function adbConnect(e, hostPort) {
  const v = fromViewer(e);
  if (!v) return { ok: false, error: 'No screen is being shown.' };
  const r = await adbc().connect(String(hostPort || '').trim());
  if (!r.ok) return r;
  return adbStart(e);
}
async function adbDiscover(e) {
  const v = fromViewer(e);
  if (!v) return { ok: false };
  const p = D.peers.get(v.peerId);
  return p ? adbc().discover(p.info.address) : { ok: false };
}
async function adbStatus() {
  const found = adbctl.findAdb(D.getConfig().adbPath);
  return { adb: found, server: !!adbctl.findServerJar(), serverVersion: adbctl.SERVER_VERSION };
}
function onViewerDims(e, w, h) {
  const v = fromViewer(e);
  if (v && Number(w) > 0 && Number(h) > 0) v.landscape = Number(w) > Number(h);
}

function init(deps) {
  D = deps;
  ipcMain.handle('screen-share-start', (_e, peerId) => startShare(String(peerId)));
  ipcMain.handle('screen-share-stop', () => { stopShare(true); return true; });
  ipcMain.handle('screen-frame', onCaptured);
  ipcMain.on('viewer-input', onViewerInput);
  ipcMain.on('viewer-dims', onViewerDims);
  ipcMain.handle('adb-start', adbStart);
  ipcMain.handle('adb-stop', (e) => { const v = fromViewer(e); if (v) stopAdb(v, false); return true; });
  ipcMain.handle('adb-pair', (e, hp, code) => adbPair(e, hp, code));
  ipcMain.handle('adb-connect', (e, hp) => adbConnect(e, hp));
  ipcMain.handle('adb-discover', adbDiscover);
  ipcMain.handle('adb-status', adbStatus);
  ipcMain.handle('screen-control-set', (_e, on) => { setControl(on === true, true); return true; });
  ipcMain.on('screen-capture-failed', (e, why) => {
    if (share && alive(share.win) && e.sender === share.win.webContents) { D.addLog('warn', 'Screen sharing failed', String(why || '').slice(0, 120)); stopShare(true); }
  });
}

module.exports = { init, onMessage, onFrame, onDisconnected, state, stopShare, onConfigChanged };
