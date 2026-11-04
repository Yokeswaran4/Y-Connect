// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
/*
 * File transfer over the already-encrypted Y Connect WebSocket.
 *
 *   sender                                   receiver
 *   file-offer {tid,name,size}   ------->
 *                                <-------    file-accept {tid}  |  file-reject {tid,reason}
 *   binary frames: AES-GCM( uint32 tid + data[<=64 KiB] )  ------->   (many)
 *   file-end {tid}               ------->
 *                                <-------    file-ack {tid,ok}
 *   file-cancel {tid} can be sent by either side at any time.
 *
 * Extensions (all optional, older versions simply ignore them):
 *   file-offer {..., rel, key}    rel = "Folder/sub/name.ext" (folder transfers), key = stable id of this exact file
 *   file-accept {tid, offset}     receiver already holds `offset` bytes of this key: the sender continues from there (resume)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, dialog, shell, ipcMain, Notification } = require('electron');
const { WebSocket } = require('ws');

const CHUNK = 64 * 1024;
const HIGH_WATER = 4 * 1024 * 1024; // pause reading the file while this much is queued on the socket
const FINAL = new Set(['done', 'failed', 'rejected', 'cancelled']);

let D = null;                // dependencies handed over by main.js
let uidCounter = 1;
const history = [];          // every transfer (oldest first), shown in the UI
const outgoing = new Map();  // tid -> transfer being sent
const incoming = new Map();  // tid -> transfer being received

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isFinal = (t) => FINAL.has(t.status);
const downloadDir = () => path.join(app.getPath('downloads'), 'YConnect');
const fmtSize = (b) => {
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(1) + ' ' + u[i];
};

/** Strip any directory part and characters Windows/Linux don't allow, so a peer can't write outside the folder. */
function safeName(n) {
  let s = String(n || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/[. ]+$/, '').slice(0, 150);
  if (!s || s === '.' || s === '..') s = 'file';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = '_' + s;
  return s;
}
/** Create a new file, never overwriting: "a.txt", "a (1).txt", "a (2).txt"... */
function openUnique(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const n = i === 0 ? name : `${base} (${i})${ext}`;
    const full = path.join(dir, n);
    try { return { fd: fs.openSync(full, 'wx'), full, name: n }; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('no free file name');
}

/** "A/b/../c" -> ["A","c"]: every segment made safe, no way to climb out of the download folder. */
function safeRel(rel, fallbackName) {
  const parts = String(rel || '').split(/[\\/]+/).filter((x) => x && x !== '.' && x !== '..').slice(0, 32).map(safeName);
  if (!parts.length) parts.push(safeName(fallbackName));
  return parts;
}
const partialDir = () => path.join(downloadDir(), '.partial');
const keyOk = (k) => typeof k === 'string' && /^[0-9a-f]{16,64}$/.test(k);
const partPaths = (key) => ({ part: path.join(partialDir(), key + '.part'), meta: path.join(partialDir(), key + '.json') });
function dropPartial(key) {
  if (!keyOk(key)) return;
  const { part, meta } = partPaths(key);
  fs.unlink(part, () => {}); fs.unlink(meta, () => {});
}
/** Throw away half-received files nobody continued for a week. */
function cleanOldPartials() {
  try {
    const d = partialDir();
    for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f);
      try { if (Date.now() - fs.statSync(full).mtimeMs > 7 * 86400e3) fs.unlinkSync(full); } catch {}
    }
  } catch {}
}
const peerIdOf = (ws) => { for (const [id, p] of D.peers) if (p.ws === ws) return id; return null; };

function track(t) {
  history.push(t);
  while (history.length > 100) {
    const i = history.findIndex(isFinal);
    if (i < 0) break;
    history.splice(i, 1);
  }
  D.pushState();
}
function list() {
  return history.map((t) => ({ id: t.uid, dir: t.dir, peer: t.peer, name: t.name, size: t.size, done: t.done, status: t.status, canResume: t.dir === 'out' && t.status === 'failed' && !!t.src && D.peers.has(t.peerId) })).reverse();
}
function finish(t, status) {
  if (isFinal(t)) return;
  t.status = status;
  (t.dir === 'out' ? outgoing : incoming).delete(t.tid);
  if (t.ackTimer) clearTimeout(t.ackTimer);
  if (t.dir === 'in') {
    resume(t);
    // a dropped connection keeps what has arrived so far, so the sender can continue later; everything else is thrown away
    const keep = status === 'failed' && t.keepPartial && t.key;
    if (status !== 'done' && !keep) t.stream.once('close', () => fs.unlink(t.full, () => {}));
    if (status !== 'done' && !keep && t.key) dropPartial(t.key);
    try { t.stream.destroy(); } catch {}
  }
  if (t.onAnswer) t.onAnswer(status === 'cancelled' ? 'cancel' : 'fail');
  const title = { done: t.dir === 'out' ? 'File sent' : 'File received', failed: 'Transfer failed', rejected: 'File declined', cancelled: 'Transfer cancelled' }[status];
  const extra = status === 'rejected' && t.reason ? ' — ' + t.reason : (status === 'failed' && t.disconnected ? ' — connection lost, will continue when the device is back' : '');
  D.addLog(status === 'done' ? 'file' : 'warn', title, `${t.name} (${fmtSize(t.size)})${extra}`);
  D.pushState();
}

/* ---------- sending ---------- */
const resumeQueue = new Map(); // peerId -> { items: [{ abs, rel }], at }   work left over after a dropped connection
const QUEUE_TTL = 60 * 60 * 1000;

/** Same file (path, size, modification time, our id) -> same key, so the receiver can recognise a half-sent file. */
function makeKey(abs, st, rel) {
  const me = (D.getConfig() || {}).id || '';
  return crypto.createHash('sha256').update([me, abs, st.size, Math.round(st.mtimeMs), rel || ''].join('|')).digest('hex').slice(0, 32);
}

/** Resolves to 'done' | 'rejected' | 'cancelled' | 'failed' | 'disconnected' | 'skipped'. */
async function sendFile(peerId, filePath, rel) {
  const p = D.peers.get(peerId);
  if (!p) return 'disconnected';
  let st;
  try { st = await fs.promises.stat(filePath); }
  catch { D.addLog('warn', 'Cannot read file', path.basename(String(filePath))); return 'skipped'; }
  if (!st.isFile()) { D.addLog('warn', 'Skipped', path.basename(filePath) + ' is not a file'); return 'skipped'; }

  const ws = p.ws;
  const key = makeKey(filePath, st, rel);
  const shown = rel || path.basename(filePath);
  const t = { uid: uidCounter++, tid: crypto.randomInt(1, 0xffffffff), dir: 'out', ws, peerId, peer: p.info.name, name: shown, size: st.size, done: 0, status: 'waiting', key, src: { abs: filePath, rel: rel || '' } };
  outgoing.set(t.tid, t);
  track(t);
  const offer = { type: 'file-offer', tid: t.tid, name: path.basename(filePath), size: t.size, key };
  if (rel) offer.rel = rel;
  D.sendTo(ws, offer);

  let timer;
  const answer = await new Promise((resolve) => {
    t.onAnswer = resolve;
    timer = setTimeout(() => resolve('timeout'), 60000);
  });
  clearTimeout(timer);
  t.onAnswer = null;
  if (answer !== 'accept') {
    if (answer === 'timeout') D.sendTo(ws, { type: 'file-cancel', tid: t.tid });
    finish(t, answer === 'reject' ? 'rejected' : answer === 'cancel' ? 'cancelled' : 'failed');
    return t.disconnected ? 'disconnected' : (answer === 'reject' ? 'rejected' : answer === 'cancel' ? 'cancelled' : 'failed');
  }

  // resume: the receiver may already have the first `offset` bytes
  let offset = Number(t.offset) || 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > t.size) offset = 0;
  t.done = offset;
  t.status = 'active';
  D.pushState();
  const head = Buffer.alloc(4);
  head.writeUInt32BE(t.tid);
  const rs = fs.createReadStream(filePath, { highWaterMark: CHUNK, start: offset });
  try {
    if (offset < t.size) {
      for await (const chunk of rs) {
        if (isFinal(t) || ws.readyState !== WebSocket.OPEN) throw new Error('stopped');
        while (ws.bufferedAmount > HIGH_WATER) {
          await sleep(10);
          if (isFinal(t) || ws.readyState !== WebSocket.OPEN) throw new Error('stopped');
        }
        ws.send(D.encryptBin(Buffer.concat([head, chunk])));
        t.done += chunk.length;
        D.pushState();
      }
    }
    if (t.done !== t.size) throw new Error('file changed while sending');
    D.sendTo(ws, { type: 'file-end', tid: t.tid });
    t.ackTimer = setTimeout(() => finish(t, 'failed'), 30000); // finish(t,'done') happens on file-ack
  } catch {
    rs.destroy();
    if (!isFinal(t)) { D.sendTo(ws, { type: 'file-cancel', tid: t.tid }); finish(t, 'failed'); }
    return t.disconnected ? 'disconnected' : 'failed';
  }
  // wait for the receiver's final answer so the next file in a folder starts only after this one is safe
  await new Promise((resolve) => { const iv = setInterval(() => { if (isFinal(t)) { clearInterval(iv); resolve(); } }, 50); });
  return t.status === 'done' ? 'done' : (t.disconnected ? 'disconnected' : t.status);
}

/** Every regular file below `dir`, as { abs, rel } with rel = "Folder/sub/file". Symlinks are skipped. */
async function walkFolder(dir, limit = 20000) {
  const out = [];
  const top = path.basename(dir) || 'Folder';
  async function go(abs, rel, depth) {
    if (out.length >= limit || depth > 40) return;
    let ents;
    try { ents = await fs.promises.readdir(abs, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (out.length >= limit) return;
      const a = path.join(abs, e.name), r = rel + '/' + e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await go(a, r, depth + 1);
      else if (e.isFile()) out.push({ abs: a, rel: r });
    }
  }
  await go(dir, top, 0);
  return out;
}

/** Turns dropped / picked paths into a flat list of files (folders are expanded). */
async function expand(paths) {
  const items = [];
  for (const p of paths) {
    let st;
    try { st = await fs.promises.lstat(p); } catch { D.addLog('warn', 'Cannot read', path.basename(String(p))); continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      const files = await walkFolder(p);
      D.addLog('file', 'Sending folder', `${path.basename(p)} (${files.length} file${files.length === 1 ? '' : 's'})`);
      items.push(...files);
    } else if (st.isFile()) items.push({ abs: p, rel: '' });
  }
  return items;
}

async function runItems(peerId, items) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const r = await sendFile(peerId, it.abs, it.rel);
    if (r === 'disconnected') { // keep this file and everything after it for when the device is back
      queueForResume(peerId, items.slice(i));
      return;
    }
    if (r === 'rejected' && it.rel) { D.addLog('warn', 'Folder declined', `${it.rel.split('/')[0]} (the other device said no)`); return; }
  }
}
function queueForResume(peerId, items) {
  if (!items.length) return;
  const q = resumeQueue.get(peerId) || { items: [], at: 0 };
  for (const it of items) if (!q.items.some((x) => x.abs === it.abs && x.rel === it.rel)) q.items.push(it);
  q.at = Date.now();
  resumeQueue.set(peerId, q);
  D.addLog('info', 'Transfer paused', `${q.items.length} file${q.items.length === 1 ? '' : 's'} will continue when the device reconnects`);
  D.pushState();
}
/** Called by main.js when a device (re)connects: continue what was interrupted. */
function onPeerConnected(peerId) {
  const q = resumeQueue.get(peerId);
  if (!q) return;
  resumeQueue.delete(peerId);
  if (Date.now() - q.at > QUEUE_TTL) return;
  D.addLog('file', 'Resuming transfer', `${q.items.length} file${q.items.length === 1 ? '' : 's'}`);
  // a failed row of the same file would only be confusing next to the continued one
  for (let i = history.length - 1; i >= 0; i--) if (history[i].dir === 'out' && history[i].peerId === peerId && history[i].status === 'failed' && history[i].disconnected) history.splice(i, 1);
  runItems(peerId, q.items).catch(() => {});
}
/** Manual "Resume" button: continue one failed outgoing file right now. */
function resumeOne(uid) {
  const t = history.find((x) => x.uid === uid);
  if (!t || t.dir !== 'out' || t.status !== 'failed' || !t.src) return false;
  if (!D.peers.has(t.peerId)) return false;
  const i = history.indexOf(t);
  if (i >= 0) history.splice(i, 1);
  runItems(t.peerId, [t.src]).catch(() => {});
  D.pushState();
  return true;
}
function dropQueue(peerId) { resumeQueue.delete(peerId); }
function sendMany(peerId, paths) {
  (async () => { try { await runItems(peerId, await expand(paths)); } catch {} })();
}
function cancel(uid) {
  const t = history.find((x) => x.uid === uid);
  if (!t || isFinal(t)) return;
  D.sendTo(t.ws, { type: 'file-cancel', tid: t.tid });
  finish(t, 'cancelled');
}

/* ---------- receiving ---------- */
const peerName = (ws) => { for (const p of D.peers.values()) if (p.ws === ws) return p.info.name; return 'device'; };

function onOffer(ws, msg) {
  const tid = Number(msg.tid), size = Number(msg.size);
  const reject = (reason) => D.sendTo(ws, { type: 'file-reject', tid, reason });
  if (!Number.isInteger(tid) || !Number.isFinite(size) || size < 0 || incoming.has(tid)) return reject('bad offer');
  const name = safeName(msg.name);
  if (!D.getConfig().acceptFiles) {
    D.addLog('warn', 'File declined', `${peerName(ws)} tried to send "${name}" (receiving is off)`);
    return reject('receiving is turned off');
  }
  const segs = msg.rel ? safeRel(msg.rel, name) : [name];
  const fileName = segs[segs.length - 1];
  const subDir = path.join(downloadDir(), ...segs.slice(0, -1));
  const key = keyOk(msg.key) ? msg.key : '';

  let stream, full, offset = 0, shownName;
  try {
    fs.mkdirSync(subDir, { recursive: true });
    if (key) {
      fs.mkdirSync(partialDir(), { recursive: true });
      const pp = partPaths(key);
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(pp.meta, 'utf8')); } catch {}
      let have = 0;
      try { have = fs.statSync(pp.part).size; } catch {}
      if (meta && meta.size === size && meta.name === fileName && meta.rel === segs.join('/') && have > 0 && have <= size) offset = have;
      else { try { fs.unlinkSync(pp.part); } catch {} }
      fs.writeFileSync(pp.meta, JSON.stringify({ size, name: fileName, rel: segs.join('/'), at: Date.now() }));
      const fd = fs.openSync(pp.part, offset ? 'a' : 'w');
      stream = fs.createWriteStream(pp.part, { fd });
      full = pp.part;
      shownName = segs.join('/');
    } else {
      const f = openUnique(subDir, fileName); // older sender: write straight to the final place
      stream = fs.createWriteStream(f.full, { fd: f.fd });
      full = f.full;
      shownName = segs.slice(0, -1).concat(f.name).join('/');
    }
  } catch { return reject('cannot write file'); }
  const t = { uid: uidCounter++, tid, dir: 'in', ws, peerId: peerIdOf(ws), peer: peerName(ws), name: shownName, size, done: offset, status: 'active', stream, full, key, segs, subDir, fileName };
  stream.on('error', () => {
    if (!isFinal(t)) { D.sendTo(ws, { type: 'file-cancel', tid }); finish(t, 'failed'); }
  });
  incoming.set(tid, t);
  track(t);
  if (offset) D.addLog('file', 'Continuing file', `${shownName} from ${fmtSize(offset)}`);
  D.sendTo(ws, offset ? { type: 'file-accept', tid, offset } : { type: 'file-accept', tid });
}
function onBinary(ws, plain) {
  if (plain.length < 4) return;
  const t = incoming.get(plain.readUInt32BE(0));
  if (!t || t.ws !== ws || isFinal(t)) return;
  const data = plain.subarray(4);
  t.done += data.length;
  if (t.done > t.size) { D.sendTo(ws, { type: 'file-cancel', tid: t.tid }); finish(t, 'failed'); return; }
  if (!t.stream.write(data) && typeof ws.pause === 'function' && !t.paused) {
    t.paused = true;
    ws.pause(); // disk is slower than the network: stop reading until it catches up
    t.stream.once('drain', () => resume(t));
  }
  D.pushState();
}
/** Undo ws.pause(). Must run on every exit path, otherwise the whole connection stays frozen. */
function resume(t) {
  if (!t.paused) return;
  t.paused = false;
  if (typeof t.ws.resume === 'function') t.ws.resume();
}
function onEnd(ws, tid) {
  const t = incoming.get(tid);
  if (!t || t.ws !== ws || isFinal(t)) return;
  resume(t); // a stream that is ending never emits 'drain'
  t.stream.end(() => {
    let ok = t.done === t.size;
    if (ok && t.key) { // the finished download moves from .partial to its real name (never overwriting)
      try {
        const f = openUnique(t.subDir, t.fileName);
        fs.closeSync(f.fd);
        fs.renameSync(t.full, f.full);
        fs.unlink(partPaths(t.key).meta, () => {});
        t.full = f.full;
        t.name = t.segs.slice(0, -1).concat(f.name).join('/');
      } catch { ok = false; }
    }
    D.sendTo(ws, { type: 'file-ack', tid, ok });
    finish(t, ok ? 'done' : 'failed');
    if (ok) received(t);
  });
}
function received(t) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: 'File received', body: `${t.name} from ${t.peer}`, icon: D.icon });
    n.on('click', () => shell.showItemInFolder(t.full));
    n.show();
  } catch {}
}

/* ---------- entry points used by main.js ---------- */
function onMessage(ws, msg) {
  const tid = Number(msg.tid);
  switch (msg.type) {
    case 'file-offer': return onOffer(ws, msg);
    case 'file-end': return onEnd(ws, tid);
    case 'file-accept': {
      const t = outgoing.get(tid);
      if (t && t.ws === ws && t.onAnswer) { t.offset = Number(msg.offset) || 0; t.onAnswer('accept'); }
      return;
    }
    case 'file-reject': {
      const t = outgoing.get(tid);
      if (t && t.ws === ws && t.onAnswer) { t.reason = String(msg.reason || ''); t.onAnswer('reject'); }
      return;
    }
    case 'file-ack': {
      const t = outgoing.get(tid);
      if (t && t.ws === ws) finish(t, msg.ok ? 'done' : 'failed');
      return;
    }
    case 'file-cancel': {
      for (const m of [outgoing, incoming]) {
        const t = m.get(tid);
        if (t && t.ws === ws) finish(t, 'cancelled');
      }
      return;
    }
  }
}
function onDisconnected(ws) {
  for (const t of history) {
    if (t.ws !== ws || isFinal(t)) continue;
    t.disconnected = true;       // not the user's choice: can be continued later
    t.keepPartial = true;        // receiver keeps the bytes that already arrived
    finish(t, 'failed');
  }
}

function init(deps) {
  D = deps;
  cleanOldPartials();
  ipcMain.handle('pick-and-send', async (_e, peerId) => {
    if (!D.peers.has(peerId)) return 0;
    const win = D.getWin();
    const opts = { properties: ['openFile', 'multiSelections'] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths.length) return 0;
    sendMany(peerId, r.filePaths);
    return r.filePaths.length;
  });
  ipcMain.handle('pick-folder-and-send', async (_e, peerId) => {
    if (!D.peers.has(peerId)) return 0;
    const win = D.getWin();
    const opts = { properties: ['openDirectory', 'multiSelections'] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths.length) return 0;
    sendMany(peerId, r.filePaths);
    return r.filePaths.length;
  });
  ipcMain.handle('resume-transfer', (_e, uid) => resumeOne(Number(uid)));
  ipcMain.handle('send-files', (_e, peerId, paths) => {
    if (!Array.isArray(paths)) return 0;
    const clean = paths.filter((p) => typeof p === 'string' && p);
    sendMany(peerId, clean);
    return clean.length;
  });
  ipcMain.handle('cancel-transfer', (_e, uid) => cancel(Number(uid)));
  ipcMain.handle('clear-transfers', () => {
    for (let i = history.length - 1; i >= 0; i--) if (isFinal(history[i])) history.splice(i, 1);
    D.pushState();
  });
  ipcMain.handle('open-downloads', async () => {
    const d = downloadDir();
    fs.mkdirSync(d, { recursive: true });
    await shell.openPath(d);
  });
}

module.exports = { init, onMessage, onBinary, onDisconnected, onPeerConnected, dropQueue, list, sendFile, sendMany, cancel, resumeOne, safeRel, walkFolder };
