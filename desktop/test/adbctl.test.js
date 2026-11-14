// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
// Tests for adbctl.js with a fake `adb` program and a fake scrcpy control socket (no phone, no Electron needed).
//   node test/adbctl.test.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const A = require('../adbctl.js');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(10); } };

/* ---------- pure helpers ---------- */
test('parseDevices reads serial, state and model', () => {
  const d = A.parseDevices('List of devices attached\n192.168.1.50:37000\tdevice product:a model:Pixel_7 device:b transport_id:1\nR58M\tunauthorized usb:1-1 transport_id:2\n\n');
  assert.deepStrictEqual(d, [{ serial: '192.168.1.50:37000', state: 'device', model: 'Pixel 7' }, { serial: 'R58M', state: 'unauthorized', model: '' }]);
});
test('parseMdns reads connect and pairing services', () => {
  const m = A.parseMdns('List of discovered mdns services\nadb-XYZ\t_adb-tls-connect._tcp.\t192.168.1.50:41234\nadb-XYZ\t_adb-tls-pairing._tcp.\t192.168.1.50:37123\nnoise line\n');
  assert.deepStrictEqual(m, [{ name: 'adb-XYZ', type: 'connect', host: '192.168.1.50', port: 41234 }, { name: 'adb-XYZ', type: 'pair', host: '192.168.1.50', port: 37123 }]);
});
test('host:port validation refuses option-like input', () => {
  assert.ok(A.validHostPort('192.168.1.5:5555'));
  assert.ok(!A.validHostPort('-s evil:1'));
  assert.ok(!A.validHostPort('a b:1'));
  assert.ok(!A.validHostPort('192.168.1.5'));
});
test('key table', () => {
  assert.strictEqual(A.keyOf('KeyA'), 29); assert.strictEqual(A.keyOf('KeyZ'), 54);
  assert.strictEqual(A.keyOf('Digit0'), 7); assert.strictEqual(A.keyOf('Digit9'), 16);
  assert.strictEqual(A.keyOf('F1'), 131); assert.strictEqual(A.keyOf('F12'), 142);
  assert.strictEqual(A.keyOf('Enter'), 66); assert.strictEqual(A.keyOf('Backspace'), 67); assert.strictEqual(A.keyOf('MetaLeft'), 3);
  assert.strictEqual(A.keyOf('Nope'), 0);
});
test('scrcpy message layouts', () => {
  const t = A.Msg.touch(0, -2, 100, 200, 1080, 2400, 1, 1);
  assert.strictEqual(t.length, 32);
  assert.strictEqual(t[0], 2); assert.strictEqual(t[1], 0);
  assert.strictEqual(t.readBigUInt64BE(2), 0xfffffffffffffffen);
  assert.deepStrictEqual([t.readInt32BE(10), t.readInt32BE(14), t.readUInt16BE(18), t.readUInt16BE(20)], [100, 200, 1080, 2400]);
  assert.strictEqual(t.readUInt16BE(22), 0xffff);
  assert.deepStrictEqual([t.readInt32BE(24), t.readInt32BE(28)], [1, 1]);
  const up = A.Msg.touch(1, -2, 1, 2, 3, 4, 0, 1);
  assert.deepStrictEqual([up.readUInt16BE(22), up.readInt32BE(24), up.readInt32BE(28)], [0, 0, 0]);
  const s = A.Msg.scroll(5, 6, 1080, 2400, 0, -1);
  assert.strictEqual(s.length, 21); assert.strictEqual(s[0], 3);
  assert.strictEqual(s.readInt16BE(13), 0); assert.strictEqual(s.readInt16BE(15), -32768);
  const k = A.Msg.key(0, 66, 0, 0x1000);
  assert.strictEqual(k.length, 14); assert.deepStrictEqual([k[0], k[1], k.readInt32BE(2), k.readInt32BE(10)], [0, 0, 66, 0x1000]);
  const x = A.Msg.text('héllo');
  assert.deepStrictEqual([x[0], x.readUInt32BE(1), x.subarray(5).toString('utf8')], [1, 6, 'héllo']);
});

/* ---------- fake adb + fake control socket ---------- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ycadb-'));
const LOG = path.join(dir, 'log.jsonl');
const FAKE = path.join(dir, 'adb');
fs.writeFileSync(FAKE, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(a) + '\\n');
const out = (s) => process.stdout.write(s + '\\n');
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'cfg.json'))}, 'utf8'));
let i = 0; if (a[0] === '-s') i = 2;
const c = a[i];
if (c === 'start-server') process.exit(0);
if (c === 'devices') { out('List of devices attached'); for (const l of cfg.devices) out(l); process.exit(0); }
if (c === 'mdns') { out('List of discovered mdns services'); for (const l of cfg.mdns) out(l); process.exit(0); }
if (c === 'connect') { cfg.devices.push(a[1] + '\\tdevice product:p model:Fake_Phone device:d transport_id:9'); fs.writeFileSync(${JSON.stringify(path.join(dir, 'cfg.json'))}, JSON.stringify(cfg)); out('connected to ' + a[1]); process.exit(0); }
if (c === 'pair') { out(a[2] === '123456' ? 'Successfully paired to ' + a[1] : 'Failed: Wrong password'); process.exit(0); }
if (c === 'push') process.exit(0);
if (c === 'forward') { if (a[i + 1] === '--remove') process.exit(0); out(String(cfg.port)); process.exit(0); }
if (c === 'shell' && a[i + 1] === 'wm') { out('Physical size: 1080x2400'); process.exit(0); }
if (c === 'shell' && /^CLASSPATH=/.test(a[i + 1])) { setInterval(() => {}, 1000); return; }   // the scrcpy server: stays up until killed
process.exit(0);
`, { mode: 0o755 });
const setCfg = (o) => fs.writeFileSync(path.join(dir, 'cfg.json'), JSON.stringify(o));
const calls = () => fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const IP = '192.168.1.50';
const PHONE = `${IP}:41234\tdevice product:p model:Pixel_7 device:d transport_id:1`;

/** A control socket like scrcpy-server's: first connection(s) can be refused, then a dummy byte, then it records everything. */
function fakeServer(refuse = 0) {
  const got = [];
  let n = 0, conn = null;
  const srv = net.createServer((s) => {
    if (n++ < refuse) { s.destroy(); return; }
    conn = s;
    s.write(Buffer.from([0]));
    s.on('data', (d) => got.push(d));
    s.on('error', () => {});
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, got, buf: () => Buffer.concat(got), conn: () => conn })));
}
function count(b) { // whole messages received so far (a partial one at the end does not count)
  let n = 0, o = 0;
  while (o < b.length) {
    const t = b[o];
    const len = t === 2 ? 32 : t === 3 ? 21 : t === 0 ? 14 : t === 1 ? (b.length >= o + 5 ? 5 + b.readUInt32BE(o + 1) : 1e9) : t === 4 ? 2 : 1e9;
    if (o + len > b.length) break;
    n++; o += len;
  }
  return n;
}
function parseStream(b) { // split recorded bytes into messages by their known lengths
  const out = []; let o = 0;
  while (o < b.length) {
    const t = b[o];
    const len = t === 2 ? 32 : t === 3 ? 21 : t === 0 ? 14 : t === 1 ? 5 + b.readUInt32BE(o + 1) : t === 4 ? 2 : null;
    assert.ok(len, 'unknown message type ' + t);
    out.push(b.subarray(o, o + len)); o += len;
  }
  return out;
}

test('ensure: picks the device already connected by IP, ignores others', async () => {
  setCfg({ devices: ['10.0.0.9:5555\tdevice model:Other', PHONE], mdns: [], port: 1 });
  const api = A.createAdb(() => ({ adbPath: FAKE }));
  const r = await api.ensure('::ffff:' + IP);
  assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.serial, `${IP}:41234`);
});
test('ensure: a single USB device is used', async () => {
  setCfg({ devices: ['R58M\tdevice usb:1-1 model:Pixel_7'], mdns: [], port: 1 });
  const r = await A.createAdb(() => ({ adbPath: FAKE })).ensure(IP);
  assert.ok(r.ok); assert.strictEqual(r.serial, 'R58M');
});
test('ensure: two unrelated devices are not guessed', async () => {
  setCfg({ devices: ['A1\tdevice usb:1', 'B2\tdevice usb:2'], mdns: [], port: 1 });
  const r = await A.createAdb(() => ({ adbPath: FAKE })).ensure(IP);
  assert.ok(!r.ok && r.needPair);
});
test('ensure: connects through the mDNS port of this phone', async () => {
  setCfg({ devices: [], mdns: [`adb-X\t_adb-tls-connect._tcp.\t${IP}:41234`, 'adb-Y\t_adb-tls-connect._tcp.\t10.0.0.7:4000'], port: 1 });
  const r = await A.createAdb(() => ({ adbPath: FAKE })).ensure(IP);
  assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.serial, `${IP}:41234`);
  assert.ok(calls().some((c) => c[0] === 'connect' && c[1] === `${IP}:41234`));
  assert.ok(!calls().some((c) => c[0] === 'connect' && c[1].startsWith('10.0.0.7')), 'must not connect to another phone');
});
test('ensure: nothing available asks for pairing', async () => {
  setCfg({ devices: [], mdns: [], port: 1 });
  const r = await A.createAdb(() => ({ adbPath: FAKE })).ensure(IP);
  assert.ok(!r.ok && r.needPair);
});
test('adb missing is reported', async () => {
  const r = await A.createAdb(() => ({ adbPath: '/nope/adb' }), async () => ({ ok: false, out: '', err: '' })).devices();
  if (A.findAdb('/nope/adb')) return; // adb really installed on this machine: nothing to check
  assert.ok(!r.ok && r.needAdb);
});
test('pair: validates input, reports success and failure', async () => {
  setCfg({ devices: [], mdns: [], port: 1 });
  const api = A.createAdb(() => ({ adbPath: FAKE }));
  assert.ok(!(await api.pair('bad', '123456')).ok);
  assert.ok(!(await api.pair(`${IP}:37123`, '12')).ok);
  assert.ok(!(await api.pair(`${IP}:37123`, '000000')).ok);
  assert.ok((await api.pair(`${IP}:37123`, '123456')).ok);
});
test('discover returns the phone\'s own pair / connect ports', async () => {
  setCfg({ devices: [], mdns: [`a\t_adb-tls-pairing._tcp.\t${IP}:37123`, `a\t_adb-tls-connect._tcp.\t${IP}:41234`, 'b\t_adb-tls-pairing._tcp.\t10.0.0.7:1111'], port: 1 });
  const d = await A.createAdb(() => ({ adbPath: FAKE })).discover(IP);
  assert.strictEqual(d.pair.port, 37123); assert.strictEqual(d.connect.port, 41234);
});

test('scrcpy session: touch, drag, right click, wheel, keys, text, nav, release', async () => {
  const f = await fakeServer(2); // the first two connection attempts are refused: the server is still starting
  setCfg({ devices: [PHONE], mdns: [], port: f.port });
  let landscape = false, closed = null;
  const o = await A.openSession({ adb: FAKE, serial: `${IP}:41234`, jar: path.join(dir, 'jar'), getLandscape: () => landscape, onClosed: (w) => { closed = w; } });
  assert.ok(o.ok); const s = o.session; assert.strictEqual(s.mode, 'scrcpy');
  const startCall = calls().find((c) => c.includes('app_process'));
  assert.ok(startCall, 'server was started');
  assert.ok(startCall.includes(A.SERVER_VERSION) && startCall.includes('video=false') && startCall.includes('control=true') && startCall.includes('tunnel_forward=true'));
  assert.ok(startCall.some((x) => /^scid=[0-9a-f]{8}$/.test(x)));
  assert.ok(calls().some((c) => c.includes('push')) && calls().some((c) => c.includes('forward') && c.includes('tcp:0')));

  s.handle({ k: 'down', x: 0.5, y: 0.5, b: 0 });
  s.handle({ k: 'move', x: 0.5, y: 0.25 });
  s.handle({ k: 'up', x: 0.5, y: 0.25, b: 0 });
  s.handle({ k: 'down', x: 0.1, y: 0.1, b: 2 });   // right click = Back
  s.handle({ k: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: 2 });
  s.handle({ k: 'key', code: 'ControlLeft', d: true });
  s.handle({ k: 'key', code: 'KeyC', d: true });
  s.handle({ k: 'key', code: 'KeyC', d: false });
  s.handle({ k: 'key', code: 'ControlLeft', d: false });
  s.handle({ k: 'text', s: 'hi' });
  s.handle({ k: 'nav', a: 'home' });
  await until(() => count(f.buf()) >= 13);
  const m = parseStream(f.buf());
  const W = 1080, H = 2400;
  const px = (v, n) => Math.round(v * (n - 1));
  // touch down / move / up at the right pixels, with the screen size
  assert.deepStrictEqual([m[0][1], m[0].readInt32BE(10), m[0].readInt32BE(14), m[0].readUInt16BE(18), m[0].readUInt16BE(20)], [0, px(.5, W), px(.5, H), W, H]);
  assert.deepStrictEqual([m[1][1], m[1].readInt32BE(14)], [2, px(.25, H)]);
  assert.strictEqual(m[2][1], 1);
  assert.deepStrictEqual([m[3][0], m[3][1]], [4, 0]);                       // back
  assert.strictEqual(m[4][0], 3); assert.strictEqual(m[4].readInt16BE(15), -32768); // scroll down
  assert.strictEqual(m[5][0], 3);                                           // two notches
  assert.deepStrictEqual([m[6][0], m[6][1], m[6].readInt32BE(2)], [0, 0, 113]);     // Ctrl down
  assert.deepStrictEqual([m[7][0], m[7].readInt32BE(2), m[7].readInt32BE(10)], [0, 31, 0x3000]); // C with Ctrl held
  assert.strictEqual(m[8][1], 1);
  assert.deepStrictEqual([m[9][1], m[9].readInt32BE(10)], [1, 0]);          // Ctrl released: no modifier left
  assert.strictEqual(m[10].subarray(5).toString(), 'hi');
  assert.deepStrictEqual([m[11].readInt32BE(2), m[12].readInt32BE(2)], [3, 3]); // home down / up

  // rotation: the picture became landscape, so pixels follow the new shape
  landscape = true;
  s.handle({ k: 'down', x: 1, y: 1, b: 0 });
  await until(() => count(f.buf()) >= 14);
  const last = parseStream(f.buf()).pop();
  assert.deepStrictEqual([last.readInt32BE(10), last.readInt32BE(14), last.readUInt16BE(18), last.readUInt16BE(20)], [H - 1, W - 1, H, W]);

  // a finger still down is lifted by release()
  const before = parseStream(f.buf()).length;
  s.release();
  await until(() => count(f.buf()) > before);
  assert.strictEqual(parseStream(f.buf()).pop()[1], 1);

  s.close();
  await until(() => closed !== null);
  await until(() => calls().some((c) => c.includes('--remove'))); // the port forward is cleaned up
  f.srv.close();
});

test('scrcpy session: connection lost is reported', async () => {
  const f = await fakeServer(0);
  setCfg({ devices: [PHONE], mdns: [], port: f.port });
  let closed = null;
  const o = await A.openSession({ adb: FAKE, serial: `${IP}:41234`, jar: path.join(dir, 'jar'), onClosed: (w) => { closed = w; } });
  await until(() => f.conn());
  f.conn().destroy();
  await until(() => closed);
  assert.ok(/lost|stopped/.test(closed));
  o.session.close(); f.srv.close();
});

test('falls back to adb shell input when no server file is available', async () => {
  setCfg({ devices: [PHONE], mdns: [], port: 1 });
  const o = await A.openSession({ adb: FAKE, serial: `${IP}:41234`, jar: null, onClosed() {} });
  assert.ok(o.ok); assert.strictEqual(o.session.mode, 'shell');
  const s = o.session;
  s.handle({ k: 'down', x: 0.5, y: 0.5, b: 0 }); s.handle({ k: 'up', x: 0.5, y: 0.5, b: 0 });
  s.handle({ k: 'down', x: 0.5, y: 0.8, b: 0 }); s.handle({ k: 'move', x: 0.5, y: 0.2 }); s.handle({ k: 'up', x: 0.5, y: 0.2, b: 0 });
  s.handle({ k: 'key', code: 'Enter', d: true });
  s.handle({ k: 'text', s: 'a b' });
  s.handle({ k: 'nav', a: 'back' });
  await until(() => calls().filter((c) => c.includes('input')).length >= 5);
  const inp = calls().filter((c) => c.includes('input')).map((c) => c.slice(c.indexOf('input') + 1));
  assert.deepStrictEqual(inp[0], ['tap', '540', '1200']);
  assert.deepStrictEqual(inp[1].slice(0, 5), ['swipe', '540', '1919', '540', '480']);
  assert.deepStrictEqual(inp[2], ['keyevent', '66']);
  assert.deepStrictEqual(inp[3], ['text', "'a%sb'"]);
  assert.deepStrictEqual(inp[4], ['keyevent', '4']);
  s.close();
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  - ' + name); } catch (e) { console.log('  FAIL - ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})();
