// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
const assert = require('assert');
const I = require('../inputctl');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok  - ' + name); };
const G = { x: 0, y: 0, width: 1000, height: 500, scale: 1 };

test('sanitize clamps coordinates and drops junk', () => {
  assert.deepStrictEqual(I.sanitize({ k: 'move', x: 2, y: -1 }), { k: 'move', x: 1, y: 0 });
  assert.strictEqual(I.sanitize({ k: 'move', x: 'a', y: 0 }), null);
  assert.strictEqual(I.sanitize({ k: 'move', x: NaN, y: 0 }), null);
  assert.strictEqual(I.sanitize(null), null);
  assert.strictEqual(I.sanitize({ k: 'rm -rf' }), null);
  assert.strictEqual(I.sanitize({ k: 'down', x: .5, y: .5, b: 1 }).b, 0);
  assert.strictEqual(I.sanitize({ k: 'down', x: .5, y: .5, b: 2 }).b, 2);
});
test('sanitize limits wheel, key and text', () => {
  assert.strictEqual(I.sanitize({ k: 'wheel', x: 0, y: 0, dx: 0, dy: 0 }), null);
  assert.strictEqual(I.sanitize({ k: 'wheel', x: 0, y: 0, dy: 9999 }).dy, 20);
  assert.strictEqual(I.sanitize({ k: 'key', code: 'Nope', d: true }), null);
  assert.deepStrictEqual(I.sanitize({ k: 'key', code: 'KeyA', d: true }), { k: 'key', code: 'KeyA', d: true });
  assert.strictEqual(I.sanitize({ k: 'text', s: 'a\u0000b' }).s, 'ab');
  assert.strictEqual(I.sanitize({ k: 'text', s: 'x'.repeat(5000) }).s.length, I.MAX_TEXT);
  assert.strictEqual(I.sanitize({ k: 'text', s: '' }), null);
  assert.strictEqual(I.sanitize({ k: 'nav', a: 'format' }), null);
});
test('xdotool mapping', () => {
  assert.deepStrictEqual(I.xdotoolJobs(I.sanitize({ k: 'move', x: .5, y: .5 }), G), [['mousemove', 500, 250]]);
  assert.deepStrictEqual(I.xdotoolJobs(I.sanitize({ k: 'down', x: 0, y: 1, b: 2 }), G), [['mousemove', 0, 500, 'mousedown', '3']]);
  const w = I.xdotoolJobs(I.sanitize({ k: 'wheel', x: 0, y: 0, dy: -2 }), G);
  assert.deepStrictEqual(w[1], ['click', '--repeat', '2', '4']);
  assert.deepStrictEqual(I.xdotoolJobs({ k: 'key', code: 'ArrowLeft', d: true }, G), [['keydown', 'Left']]);
  assert.deepStrictEqual(I.xdotoolJobs({ k: 'text', s: '-rf' }, G)[0].slice(-2), ['--', '-rf']);
});
test('display offset and scale are applied', () => {
  const g = { x: 1920, y: 0, width: 1920, height: 1080, scale: 1.5 };
  assert.deepStrictEqual(I.xdotoolJobs({ k: 'move', x: 0, y: 0 }, g), [['mousemove', 2880, 0]]);
});
test('ydotool mapping', () => {
  assert.deepStrictEqual(I.ydotoolJobs({ k: 'key', code: 'KeyA', d: true }, G), [['key', '30:1']]);
  assert.deepStrictEqual(I.ydotoolJobs({ k: 'down', x: 0, y: 0, b: 0 }, G)[1], ['click', '0x40']);
  assert.deepStrictEqual(I.ydotoolJobs({ k: 'up', x: 0, y: 0, b: 2 }, G)[1], ['click', '0x81']);
});
test('windows lines', () => {
  assert.deepStrictEqual(I.winLines({ k: 'down', x: .5, y: 1, b: 0 }), ['m 0.50000 1.00000', 'd 0']);
  assert.deepStrictEqual(I.winLines({ k: 'key', code: 'ArrowUp', d: false }), ['k 38 0 1']);
  assert.strictEqual(I.winLines({ k: 'text', s: 'hi' })[0], 't ' + Buffer.from('hi').toString('base64'));
});
test('every key has all three mappings', () => {
  for (const [c, v] of Object.entries(I.KEYS)) assert(v.sym && v.ev > 0 && v.vk > 0, c);
});
function ctl(over) {
  const runs = [];
  const c = I.createController(Object.assign({ platform: 'linux', env: { XDG_SESSION_TYPE: 'x11' }, has: (x) => x === 'xdotool', getGeometry: () => G,
    run: (cmd, args, cb) => { runs.push([cmd, ...args]); setImmediate(cb); } }, over));
  return { c, runs };
}
test('controller runs xdotool and releases held keys', (done) => {
  const { c, runs } = ctl();
  assert(c.handle({ k: 'key', code: 'ShiftLeft', d: true }));
  assert(c.handle({ k: 'key', code: 'KeyA', d: true }));
  c.releaseAll();
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(c._queue().length, 3);          // the rest waits and goes out as one process
});
test('queued xdotool commands are chained into one process', (done) => {
  const { c, runs } = ctl();
  c.handle({ k: 'key', code: 'KeyA', d: true });
  c.handle({ k: 'key', code: 'KeyA', d: false });
  c.handle({ k: 'key', code: 'KeyB', d: true });
  c.handle({ k: 'text', s: 'hi' });
  c.handle({ k: 'key', code: 'KeyB', d: false });
  setTimeout(() => {
    assert.strictEqual(runs.length, 4, JSON.stringify(runs));      // A-down | [A-up B-down] | type | B-up
    assert.deepStrictEqual(runs[1], ['xdotool', 'keyup', 'a', 'keydown', 'b']);
    assert.strictEqual(runs[2][1], 'type');
    done_ = true;
  }, 30);
});
let done_ = false;
test('controller collapses queued pointer moves', () => {
  const { c } = ctl();
  c.handle({ k: 'key', code: 'KeyA', d: true });  // occupies the runner
  for (let i = 0; i < 50; i++) c.handle({ k: 'move', x: i / 100, y: 0 });
  assert(c._queue().length <= 2, 'queue ' + c._queue().length);
});
test('controller refuses without a tool and reports a hint', () => {
  const { c } = ctl({ has: () => false });
  const a = c.available();
  assert(!a.ok && /xdotool/.test(a.hint));
  assert.strictEqual(c.handle({ k: 'move', x: 0, y: 0 }), false);
});
test('wayland prefers ydotool', () => {
  const { c } = ctl({ env: { XDG_SESSION_TYPE: 'wayland' }, has: () => true });
  assert.strictEqual(c.available().tool, 'ydotool');
});
test('windows controller feeds the helper', () => {
  const lines = [];
  const stdin = { writable: true, on() {}, write: (l) => lines.push(l), end() {} };
  const c = I.createController({ platform: 'win32', startHelper: () => ({ stdin, on() {}, exitCode: null, killed: false, kill() {} }) });
  assert(c.handle({ k: 'down', x: .5, y: .5, b: 0 }));
  assert.deepStrictEqual(lines, ['m 0.50000 0.50000\n', 'd 0\n']);
});
test('nav events are ignored on the desktop', () => {
  const { c } = ctl();
  assert.strictEqual(c.handle({ k: 'nav', a: 'back' }), false);
});

setTimeout(() => { assert(done_, 'chain test did not finish'); console.log(`\n${passed} passed`); }, 80);
