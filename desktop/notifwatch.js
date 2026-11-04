// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
// Linux only: watches desktop notifications on the D-Bus session bus (needs the `dbus-monitor` tool,
// package "dbus" / "dbus-bin") and reports each one to onNotify({ app, title, text }).
const { spawn } = require('child_process');

function decode(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();
}
function parse(lines) {
  const strs = [];
  let acc = null;
  for (const l of lines) {
    if (strs.length >= 4) break;
    if (acc !== null) {
      acc += '\n' + l;
      if (l.endsWith('"')) { strs.push(acc.slice(0, -1)); acc = null; }
      continue;
    }
    const m = /^\s*string "(.*)$/.exec(l);
    if (!m) continue;
    if (m[1].endsWith('"')) strs.push(m[1].slice(0, -1));
    else acc = m[1];
  }
  if (strs.length < 4) return null;
  return { app: decode(strs[0]), icon: strs[1].trim(), title: decode(strs[2]), text: decode(strs[3]) };
}

function start(onNotify, onError) {
  if (process.platform !== 'linux') return null;
  let proc;
  try {
    proc = spawn('dbus-monitor', ["interface='org.freedesktop.Notifications',member='Notify'"], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { onError(e); return null; }
  proc.on('error', onError);
  let buf = '', cur = null, timer = null;
  const flush = () => {
    clearTimeout(timer);
    if (cur) { const n = parse(cur); cur = null; if (n) onNotify(n); }
  };
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (/^(method call|method return|signal|error)\b/.test(line)) {
        flush();
        cur = /interface=org\.freedesktop\.Notifications/.test(line) && /member=Notify\b/.test(line) ? [] : null;
      } else if (cur) {
        cur.push(line);
        clearTimeout(timer);
        timer = setTimeout(flush, 200);
      }
    }
  });
  return proc;
}
module.exports = { start };
