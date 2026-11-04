// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
const assert = require('assert');
const { isNewer, parts, check, SAFE_URL } = require('../updates');

assert.deepStrictEqual(parts('v1.2.0-beta'), [1, 2, 0]);
assert.ok(isNewer('v1.2', 'v1.1'));
assert.ok(isNewer('v1.10', 'v1.9'));          // numeric, not alphabetical
assert.ok(isNewer('1.1.1', 'v1.1'));
assert.ok(!isNewer('v1.1', '1.1.0'));         // same version written differently
assert.ok(!isNewer('v1.0', 'v1.1'));
assert.ok(SAFE_URL.test('https://github.com/Yokeswaran4/Y-Connect/releases/tag/v1.2'));
assert.ok(!SAFE_URL.test('https://evil.example/Yokeswaran4/Y-Connect/releases'));
assert.ok(!SAFE_URL.test('https://github.com/Yokeswaran4/Y-Connect/releases/../../x?y'));

const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
(async () => {
  let r = await check('v1.1', reply(200, { tag_name: 'v1.2', html_url: 'https://github.com/Yokeswaran4/Y-Connect/releases/tag/v1.2', body: 'Notes' }));
  assert.ok(r.ok && r.newer && r.latest === 'v1.2' && r.notes === 'Notes');
  r = await check('v1.1', reply(200, { tag_name: 'v1.1', html_url: 'https://github.com/Yokeswaran4/Y-Connect/releases/tag/v1.1' }));
  assert.ok(r.ok && !r.newer);
  r = await check('v1.1', reply(200, { tag_name: 'v9', html_url: 'https://evil.example/x' }));
  assert.ok(r.newer && r.url.startsWith('https://github.com/Yokeswaran4/'));  // a foreign link is replaced
  r = await check('v1.1', reply(404, {}));
  assert.ok(r.ok && !r.newer);
  r = await check('v1.1', reply(403, {}));
  assert.ok(!r.ok && /limiting/.test(r.error));
  r = await check('v1.1', async () => { throw new Error('offline'); });
  assert.ok(!r.ok && /reach GitHub/.test(r.error));
  console.log('updates: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
