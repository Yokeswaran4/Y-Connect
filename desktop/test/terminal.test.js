'use strict';
const assert = require('assert');
const remote = require('../remote');
if (process.platform === 'win32') { console.log('terminal test skipped on Windows'); process.exit(0); }

const sent = [];
const ws = { bufferedAmount: 0, readyState: 1 };
const peers = new Map([['p1', { ws, info: { id: 'p1', name: 'Phone', platform: 'android' } }]]);
const cfg = { allowCommands: true, name: 'PC' };
remote.init({ peers, sendTo: (w, o) => sent.push(o), getConfig: () => cfg, addLog: () => {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sid) => sent.filter((m) => m.type === 'cmd-term-data' && m.sid === sid).map((m) => m.d).join('');

(async () => {
  // off by default: refused
  cfg.allowCommands = false;
  remote.onMessage(ws, { type: 'cmd-term-open', sid: 'x' });
  assert.strictEqual(sent.pop().error.kind, 'disabled');
  cfg.allowCommands = true;

  remote.onMessage(ws, { type: 'cmd-term-open', sid: 's1' });
  assert.strictEqual(sent.find((m) => m.type === 'cmd-term-ready').sid, 's1');
  remote.onMessage(ws, { type: 'cmd-term-input', sid: 's1', d: 'cd /tmp\npwd\n' });
  await sleep(400);
  assert(/\/tmp\n/.test(text('s1')), 'shell state is kept: ' + text('s1'));
  assert(!/job control/.test(text('s1')), 'tty warning is hidden');

  // bash is used when installed (bash-only syntax works; the session reports its shell)
  const hasBash = require('fs').existsSync('/bin/bash') || require('fs').existsSync('/usr/bin/bash');
  if (hasBash) {
    assert.strictEqual(sent.find((m) => m.type === 'cmd-term-ready' && m.sid === 's1').shell, 'bash');
    sent.length = 0;
    remote.onMessage(ws, { type: 'cmd-term-input', sid: 's1', d: '[[ abc == a* ]] && echo bash-ok-$BASH_VERSINFO\n' });
    await sleep(300);
    assert(/bash-ok-\d/.test(text('s1')), 'terminal runs bash: ' + text('s1'));
  }

  // guard rails apply to every line
  remote.onMessage(ws, { type: 'cmd-term-input', sid: 's1', d: 'sudo ls\nrm -rf x\necho ok\n' });
  await sleep(300);
  const t = text('s1');
  assert(/refused: "sudo"/.test(t) && /refused: "rm"/.test(t) && /ok\n/.test(t));

  // large output goes through (more than the old 48 KB limit)
  sent.length = 0;
  remote.onMessage(ws, { type: 'cmd-term-input', sid: 's1', d: 'head -c 300000 /dev/zero | tr "\\0" a; echo\n' });
  await sleep(1200);
  assert(text('s1').replace(/[^a]/g, '').length >= 300000, 'big output');

  // Ctrl+C stops a running program but keeps the shell
  sent.length = 0;
  remote.onMessage(ws, { type: 'cmd-term-input', sid: 's1', d: 'sleep 30\n' });
  await sleep(300);
  remote.onMessage(ws, { type: 'cmd-term-int', sid: 's1' });
  await sleep(300);
  remote.onMessage(ws, { type: 'cmd-term-input', sid: 's1', d: 'echo still-here\n' });
  await sleep(300);
  assert(/still-here/.test(text('s1')));

  // exit ends the session; limit of sessions
  remote.onMessage(ws, { type: 'cmd-term-open', sid: 's2' });
  remote.onMessage(ws, { type: 'cmd-term-open', sid: 's3' });
  assert.strictEqual(sent.filter((m) => m.type === 'cmd-term-exit' && m.sid === 's3')[0].error.kind, 'busy');
  remote.onMessage(ws, { type: 'cmd-term-close', sid: 's2' });
  remote.onMessage(ws, { type: 'cmd-term-input', sid: 's1', d: 'exit 4\n' });
  await sleep(500);
  const ex = sent.find((m) => m.type === 'cmd-term-exit' && m.sid === 's1');
  assert(ex && ex.code === 4);
  console.log('terminal ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
