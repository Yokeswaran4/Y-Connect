// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
// Loopback test for transfer.js (no Electron, no network): two instances talk through in-memory sockets.
//   node test/transfer.test.js
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yconnect-tt-'));
let currentDownloads = null;
const handlers = new Map();
const electronMock = {
  app: { getPath: () => currentDownloads },
  dialog: {}, shell: {}, Notification: { isSupported: () => false },
  ipcMain: { handle: (n, f) => handlers.set(n, f) },
};
class FakeWS { }
FakeWS.OPEN = 1;
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return electronMock;
  if (req === 'ws') return { WebSocket: FakeWS };
  return origLoad.call(this, req, ...rest);
};

function makeNode(name) {
  const file = require.resolve('../transfer.js');
  delete require.cache[file];
  const mod = require(file);
  const dl = path.join(tmp, name);
  fs.mkdirSync(dl, { recursive: true });
  const node = { name, mod, peers: new Map(), logs: [], dl, bytesIn: 0 };
  node.paths = { downloads: dl };
  node.ctx = () => { currentDownloads = dl; };
  mod.init({
    peers: node.peers,
    sendTo: (ws, obj) => ws.deliver(obj),
    encryptBin: (b) => Buffer.from(b), // like the real cipher: output is a fresh buffer, the sender reuses its read buffer
    getConfig: () => ({ id: name, acceptFiles: node.accept !== false }),
    addLog: (k, t, x) => node.logs.push(`${k}|${t}|${x || ''}`),
    pushState: () => {}, getWin: () => null, icon: '',
  });
  return node;
}
// run a node's code with its own download folder selected
const as = (n, fn) => { currentDownloads = n.dl; return fn(); };

function connect(a, b) { // a <-> b, a's socket is wsA, b's socket is wsB
  const mk = () => ({ readyState: 1, bufferedAmount: 0, pause() {}, resume() {}, q: [], busy: false });
  const wsA = mk(), wsB = mk();
  // one ordered channel per direction (like TCP): control messages and binary frames keep their order, each with a small delay
  const pump = (from, to, toNode) => {
    if (from.busy) return;
    from.busy = true;
    const step = () => {
      const job = from.q.shift();
      if (!job) { from.busy = false; return; }
      setTimeout(() => {   // about 64 KiB per ms whatever the frame size, so the tests' timing does not depend on CHUNK
        from.bufferedAmount -= job.len;
        if (from.readyState === 1 && to.readyState === 1) as(toNode, () => job.run());
        step();
      }, Math.max(1, Math.round(job.len / 65536)));
    };
    step();
  };
  wsA.deliver = (obj) => { const o = JSON.parse(JSON.stringify(obj)); wsA.q.push({ len: 0, run: () => b.mod.onMessage(wsB, o) }); pump(wsA, wsB, b); };
  wsB.deliver = (obj) => { const o = JSON.parse(JSON.stringify(obj)); wsB.q.push({ len: 0, run: () => a.mod.onMessage(wsA, o) }); pump(wsB, wsA, a); };
  wsA.send = (buf) => {
    wsA.bufferedAmount += buf.length;
    wsA.q.push({ len: buf.length, run: () => { b.bytesIn += buf.length - 4; b.mod.onBinary(wsB, Buffer.from(buf)); } });
    pump(wsA, wsB, b);
  };
  wsB.send = () => {};
  a.peers.set(b.name, { ws: wsA, info: { id: b.name, name: b.name } });
  b.peers.set(a.name, { ws: wsB, info: { id: a.name, name: a.name } });
  return { wsA, wsB, cut() { wsA.readyState = 3; wsB.readyState = 3; a.peers.delete(b.name); b.peers.delete(a.name); as(a, () => a.mod.onDisconnected(wsA)); as(b, () => b.mod.onDisconnected(wsB)); } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 15000) { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(10); } }
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const tree = (dir, base = dir, out = {}) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.name === '.partial' || e.isSymbolicLink()) continue; if (e.isDirectory()) tree(f, base, out); else out[path.relative(base, f).split(path.sep).join('/')] = sha(f); } return out; };
const states = (n) => n.mod.list().map((t) => t.status);

(async () => {
  let pass = 0;
  const ok = (name) => { pass++; console.log('  ok  ' + name); };

  // 1. single file
  {
    const A = makeNode('A1'), B = makeNode('B1'); connect(A, B);
    const f = path.join(tmp, 'one.bin'); fs.writeFileSync(f, crypto.randomBytes(3 * 1024 * 1024 + 123));
    await as(A, () => A.mod.sendFile('B1', f));
    await until(() => states(B).includes('done'));
    assert.strictEqual(sha(path.join(B.dl, 'YConnect', 'one.bin')), sha(f));
    assert.deepStrictEqual(fs.readdirSync(path.join(B.dl, 'YConnect', '.partial')), []);
    ok('single file arrives bit-for-bit and .partial is empty');
  }

  // 2. folder with sub folders, odd names, empty dir, symlink
  {
    const A = makeNode('A2'), B = makeNode('B2'); connect(A, B);
    const root = path.join(tmp, 'Photos');
    fs.mkdirSync(path.join(root, 'trip', 'day1'), { recursive: true });
    fs.mkdirSync(path.join(root, 'empty'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
    fs.writeFileSync(path.join(root, 'trip', 'b.bin'), crypto.randomBytes(200000));
    fs.writeFileSync(path.join(root, 'trip', 'day1', 'c.bin'), crypto.randomBytes(70000));
    fs.writeFileSync(path.join(root, 'trip', 'day1', 'ünï cödé 日本.txt'), 'x');
    try { fs.symlinkSync('/etc', path.join(root, 'link')); } catch {}
    as(A, () => A.mod.sendMany('B2', [root]));
    await until(() => states(B).filter((s) => s === 'done').length === 4);
    assert.deepStrictEqual(tree(path.join(B.dl, 'YConnect', 'Photos')), tree(root));
    ok('folder arrives with the same structure and contents (symlink skipped)');
  }

  // 3. hostile relative paths stay inside the download folder
  {
    const A = makeNode('A3'), B = makeNode('B3'); const c = connect(A, B);
    const f = path.join(tmp, 'evil.txt'); fs.writeFileSync(f, 'pwned');
    for (const rel of ['../../evil.txt', '/etc/evil.txt', 'a/../../evil.txt', 'C:\\Windows\\evil.txt', 'x/./y/evil.txt']) {
      const before = B.mod.list().length;
      await as(A, () => A.mod.sendFile('B3', f, rel));
      await until(() => B.mod.list().filter((t) => t.status === 'done').length > before - 0 && B.mod.list().length > before);
    }
    await sleep(100);
    const inside = tree(path.join(B.dl, 'YConnect'));
    assert.strictEqual(Object.keys(inside).length, 5, JSON.stringify(inside));
    assert(!fs.existsSync(path.join(B.dl, 'evil.txt')) && !fs.existsSync(path.join(tmp, 'evil.txt.x')));
    assert(!fs.existsSync('/etc/evil.txt'));
    ok('hostile folder paths cannot escape Downloads/YConnect');
  }

  // 4. resume after the connection drops in the middle
  {
    const A = makeNode('A4'), B = makeNode('B4'); const c1 = connect(A, B);
    const f = path.join(tmp, 'big.bin'); const size = 24 * 1024 * 1024 + 7;
    fs.writeFileSync(f, crypto.randomBytes(size));
    as(A, () => A.mod.sendMany('B4', [f]));
    await until(() => B.bytesIn > 6 * 1024 * 1024);
    c1.cut();
    await sleep(150);
    assert(A.logs.some((l) => l.includes('Transfer paused')), 'sender queued the file for later');
    const partDir = path.join(B.dl, 'YConnect', '.partial');
    const parts = fs.readdirSync(partDir).filter((x) => x.endsWith('.part'));
    assert.strictEqual(parts.length, 1, 'partial file kept');
    const had = fs.statSync(path.join(partDir, parts[0])).size;
    assert(had > 0 && had < size, 'partial is a real prefix: ' + had);
    assert(!fs.existsSync(path.join(B.dl, 'YConnect', 'big.bin')), 'no final file yet');
    const before = B.bytesIn;
    connect(A, B);
    as(A, () => A.mod.onPeerConnected('B4'));
    await until(() => states(B).includes('done'));
    const resent = B.bytesIn - before;
    assert.strictEqual(sha(path.join(B.dl, 'YConnect', 'big.bin')), sha(f));
    assert(resent <= size - had + 64 * 1024, `only the missing part is sent (resent ${resent}, missing ${size - had})`);
    assert(resent < size * 0.9, 'much less than the whole file');
    assert.deepStrictEqual(fs.readdirSync(partDir), []);
    ok(`resume: had ${had} of ${size} bytes, re-sent only ${resent}, result identical`);
  }

  // 5. folder interrupted between files continues with the remaining ones
  {
    const A = makeNode('A5'), B = makeNode('B5'); const c1 = connect(A, B);
    const root = path.join(tmp, 'Docs'); fs.mkdirSync(root);
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(root, `f${i}.bin`), crypto.randomBytes(2 * 1024 * 1024));
    as(A, () => A.mod.sendMany('B5', [root]));
    await until(() => B.bytesIn > 5 * 1024 * 1024);
    c1.cut();
    await sleep(200);
    connect(A, B);
    as(A, () => A.mod.onPeerConnected('B5'));
    await until(() => Object.keys(tree(path.join(B.dl, 'YConnect', 'Docs'))).length === 6 && states(B).filter((s) => s === 'active').length === 0);
    assert.deepStrictEqual(tree(path.join(B.dl, 'YConnect', 'Docs')), tree(root));
    ok('interrupted folder: all 6 files complete after reconnect');
  }

  // 6. cancelled transfer leaves nothing behind
  {
    const A = makeNode('A6'), B = makeNode('B6'); connect(A, B);
    const f = path.join(tmp, 'c.bin'); fs.writeFileSync(f, crypto.randomBytes(30 * 1024 * 1024));
    const p = as(A, () => A.mod.sendFile('B6', f));
    await until(() => B.bytesIn > 2 * 1024 * 1024);
    as(A, () => A.mod.cancel(A.mod.list()[0].id));
    await p; await sleep(300);
    const d = path.join(B.dl, 'YConnect');
    assert.deepStrictEqual(fs.readdirSync(path.join(d, '.partial')), []);
    assert(!fs.existsSync(path.join(d, 'c.bin')));
    ok('cancel removes the partial file');
  }

  // 7. old sender (no key, no rel) still works and receiving can be turned off
  {
    const A = makeNode('A7'), B = makeNode('B7'); const c = connect(A, B);
    const f = path.join(tmp, 'old.txt'); fs.writeFileSync(f, 'legacy');
    const wsB = B.peers.get('A7').ws;
    as(B, () => B.mod.onMessage(wsB, { type: 'file-offer', tid: 77, name: 'legacy.txt', size: 6 }));
    await sleep(20);
    as(B, () => B.mod.onBinary(wsB, Buffer.concat([Buffer.from([0, 0, 0, 77]), Buffer.from('legacy')])));
    as(B, () => B.mod.onMessage(wsB, { type: 'file-end', tid: 77 }));
    await until(() => states(B).includes('done'));
    assert.strictEqual(fs.readFileSync(path.join(B.dl, 'YConnect', 'legacy.txt'), 'utf8'), 'legacy');
    B.accept = false;
    const r = await as(A, () => A.mod.sendFile('B7', f));
    assert.strictEqual(r, 'rejected');
    ok('old-style offers still work; "Accept incoming files" off rejects');
  }

  console.log(`\n${pass} tests passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
