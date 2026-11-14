// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
// Protocol test for screen.js with a mocked Electron: sharer side and viewer side.
//   node test/screen.test.js
const Module = require('module');
const assert = require('assert');

const handlers = new Map(), listeners = new Map(), windows = [];
class FakeWin {
  constructor(o) {
    this.o = o; this.sent = []; this.destroyed = false; this.ev = {};
    this.webContents = { send: (ch, d) => this.sent.push([ch, d]), on: () => {} };
    windows.push(this);
  }
  on(n, f) { this.ev[n] = f; }
  loadFile() { return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  destroy() { if (this.destroyed) return; this.destroyed = true; if (this.ev.closed) this.ev.closed(); }
  close() { this.destroy(); }
}
const electronMock = {
  BrowserWindow: FakeWin,
  desktopCapturer: { getSources: async () => [{ id: 'screen:1:0', display_id: '7' }, { id: 'screen:2:0', display_id: '8' }] },
  ipcMain: { handle: (n, f) => handlers.set(n, f), on: (n, f) => listeners.set(n, f) },
  screen: { getPrimaryDisplay: () => ({ id: 8, bounds: { x: 0, y: 0, width: 100, height: 200 }, scaleFactor: 1 }) },
};
class FakeWS {}
FakeWS.OPEN = 1;
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return electronMock;
  if (req === './inputctl') return { createController: () => fakeCtl };
  if (req === 'ws') return { WebSocket: FakeWS };
  return origLoad.call(this, req, ...rest);
};
const handled = [];
const fakeCtl = { available: () => ({ ok: true, tool: 'fake' }), handle: (e) => { handled.push(e); return true; }, releaseAll: () => handled.push('RELEASE') };
const screen = require('../screen.js');

const mkWs = () => ({ readyState: 1, bufferedAmount: 0, sent: [], send(b) { this.sent.push(b); } });
const ws = mkWs();
const peers = new Map([['p1', { ws, info: { id: 'p1', name: 'Phone' } }]]);
const json = [], logs = [];
const cfg = {};
screen.init({
  peers, getConfig: () => cfg, addLog: (...a) => logs.push(a), pushState: () => {}, icon: null,
  sendTo: (w, o) => json.push(o),
  encryptBin: (b) => Buffer.from(b), // the real cipher also returns a fresh buffer
});

(async () => {
  // ---- viewer: the phone shares, we watch
  screen.onMessage(ws, { type: 'screen-start', sid: 42, w: 10, h: 20 });
  assert.strictEqual(windows.length, 1);
  assert.deepStrictEqual(screen.state(), { sharing: null, viewing: 'p1', controlled: false, adbControl: false });
  const frame = (sid, body) => { const h = Buffer.alloc(8); h.writeUInt32BE(0, 0); h.writeUInt32BE(sid, 4); return Buffer.concat([h, Buffer.from(body)]); };
  screen.onFrame(ws, frame(42, 'jpegdata'));
  screen.onFrame(ws, frame(99, 'wrong session'));
  screen.onFrame(mkWs(), frame(42, 'wrong socket'));
  const got = windows[0].sent.filter((s) => s[0] === 'viewer-frame');
  assert.strictEqual(got.length, 1);
  assert.strictEqual(Buffer.from(got[0][1]).toString(), 'jpegdata');
  console.log('  ok  viewer shows only frames of the right device and session');

  windows[0].ev.closed && windows[0].destroy(); // user closes the viewer window
  assert.deepStrictEqual(json.pop(), { type: 'screen-stop', sid: 42 });
  assert.strictEqual(screen.state().viewing, null);
  console.log('  ok  closing the viewer tells the sharer to stop');

  screen.onMessage(ws, { type: 'screen-start', sid: 43 });
  screen.onMessage(ws, { type: 'screen-stop', sid: 43 });
  assert.strictEqual(screen.state().viewing, null);
  assert.ok(!json.some((j) => j.type === 'screen-stop' && j.sid === 43), 'no echo when the sharer ended it');
  console.log('  ok  sharer ending the session closes the viewer quietly');

  // ---- sharer: we share to the phone
  const r = await handlers.get('screen-share-start')({}, 'p1');
  assert.strictEqual(r.ok, true);
  const cap = windows[windows.length - 1];
  assert.strictEqual((await handlers.get('screen-share-start')({}, 'p1')).ok, false, 'only one session at a time');
  const jpeg = new Uint8Array([1, 2, 3, 4, 5]);
  assert.strictEqual(await handlers.get('screen-frame')({ sender: {} }, jpeg, 1, 1), false, 'frames from other windows are refused');
  assert.strictEqual(await handlers.get('screen-frame')({ sender: cap.webContents }, jpeg, 100, 200), true);
  const start = json.find((j) => j.type === 'screen-start');
  assert.ok(start && start.w === 100 && start.h === 200 && start.sid > 0);
  const out = ws.sent[0];
  assert.strictEqual(out.readUInt32BE(0), 0);
  assert.strictEqual(out.readUInt32BE(4), start.sid);
  assert.deepStrictEqual([...out.subarray(8)], [1, 2, 3, 4, 5]);
  console.log('  ok  sharer announces once, then sends [0][sid][jpeg]');

  ws.bufferedAmount = 5 * 1024 * 1024;
  assert.strictEqual(await handlers.get('screen-frame')({ sender: cap.webContents }, jpeg, 100, 200), false);
  assert.strictEqual(ws.sent.length, 1, 'frame dropped while the socket is backed up');
  ws.bufferedAmount = 0;
  console.log('  ok  frames are dropped while the connection is busy');

  screen.onMessage(ws, { type: 'screen-stop', sid: start.sid }); // the phone closed its viewer
  assert.strictEqual(screen.state().sharing, null);
  assert.ok(cap.destroyed);
  console.log('  ok  viewer stopping ends the sharing and closes the capture window');

  await handlers.get('screen-share-start')({}, 'p1');
  screen.onDisconnected(ws);
  assert.strictEqual(screen.state().sharing, null);
  console.log('  ok  a dropped connection ends the session');

  // ---- remote control: off by default
  json.length = 0; handled.length = 0;
  await handlers.get('screen-share-start')({}, 'p1');
  let cap2 = windows[windows.length - 1];
  await handlers.get('screen-frame')({ sender: cap2.webContents }, jpeg, 100, 200);
  let st = json.find((j) => j.type === 'screen-start');
  assert.strictEqual(st.ctl, false);
  screen.onMessage(ws, { type: 'screen-input', sid: st.sid, ev: { k: 'move', x: .5, y: .5 } });
  assert.strictEqual(handled.length, 0, 'input ignored while control is off');
  screen.stopShare(true);
  console.log('  ok  input is ignored unless the user allowed control');

  // ---- allowed
  cfg.allowControl = true; json.length = 0;
  await handlers.get('screen-share-start')({}, 'p1');
  cap2 = windows[windows.length - 1];
  await handlers.get('screen-frame')({ sender: cap2.webContents }, jpeg, 100, 200);
  st = json.find((j) => j.type === 'screen-start');
  assert.strictEqual(st.ctl, true);
  assert.strictEqual(screen.state().controlled, true);
  const ev = { k: 'down', x: .1, y: .2, b: 0 };
  screen.onMessage(ws, { type: 'screen-input', sid: st.sid, ev });
  screen.onMessage(ws, { type: 'screen-input', sid: st.sid + 1, ev: { k: 'move', x: 0, y: 0 } });
  screen.onMessage(mkWs(), { type: 'screen-input', sid: st.sid, ev: { k: 'move', x: 0, y: 0 } });
  assert.deepStrictEqual(handled, [ev], 'only the right socket and session get through');
  console.log('  ok  input from the right viewer is passed on, others are dropped');

  handled.length = 0;
  for (let i = 0; i < 2000; i++) screen.onMessage(ws, { type: 'screen-input', sid: st.sid, ev: { k: 'move', x: 0, y: 0 } });
  assert.ok(handled.length < 800, 'rate limited: ' + handled.length);
  console.log('  ok  input flood is rate limited');

  json.length = 0; handled.length = 0;
  await handlers.get('screen-control-set')({}, false);
  assert.deepStrictEqual(json.pop(), { type: 'screen-ctl', sid: st.sid, on: false });
  assert.ok(handled.includes('RELEASE'), 'held keys are released');
  screen.onMessage(ws, { type: 'screen-input', sid: st.sid, ev });
  assert.ok(!handled.includes(ev));
  assert.strictEqual(screen.state().controlled, false);
  await handlers.get('screen-control-set')({}, true);
  assert.strictEqual(screen.state().controlled, true, 'sharer can turn it back on');
  console.log('  ok  Stop control revokes immediately and releases keys');

  cfg.allowControl = false; handled.length = 0; json.length = 0;
  screen.onConfigChanged();
  assert.strictEqual(screen.state().controlled, false);
  await handlers.get('screen-control-set')({}, true);
  assert.strictEqual(screen.state().controlled, false, 'cannot be re-enabled once the setting is off');
  screen.stopShare(true);
  console.log('  ok  turning the setting off ends control');

  // ---- viewer side
  cfg.allowControl = false;
  screen.onMessage(ws, { type: 'screen-start', sid: 77, ctl: true });
  const vw = windows[windows.length - 1];
  assert.deepStrictEqual(vw.sent.filter((x) => x[0] === 'viewer-ctl').pop(), ['viewer-ctl', true]);
  const fromViewer = { sender: vw.webContents };
  json.length = 0;
  listeners.get('viewer-input')(fromViewer, { k: 'key', code: 'KeyA', d: true });
  assert.deepStrictEqual(json.pop(), { type: 'screen-input', sid: 77, ev: { k: 'key', code: 'KeyA', d: true } });
  listeners.get('viewer-input')({ sender: {} }, { k: 'key', code: 'KeyA', d: true });
  assert.strictEqual(json.length, 0, 'other windows cannot inject input');
  screen.onMessage(ws, { type: 'screen-ctl', sid: 77, on: false });
  assert.deepStrictEqual(vw.sent.filter((x) => x[0] === 'viewer-ctl').pop(), ['viewer-ctl', false]);
  listeners.get('viewer-input')(fromViewer, { k: 'move', x: 0, y: 0 });
  assert.strictEqual(json.length, 0, 'nothing is sent after the sharer revoked control');
  console.log('  ok  viewer forwards input only while the sharer allows it');
  console.log('\nscreen ok');
})().catch((e) => { console.error(e); process.exit(1); });
