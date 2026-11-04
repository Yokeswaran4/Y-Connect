// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
// Connection latency to each paired device: a small encrypted "ping" goes over the same link as everything else
// and the other side answers with "pong", so the number is what clipboard / notifications / files really experience.
// Devices that don't know "ping" ignore it, so older versions stay compatible (they just show "No reply yet").
const KEEP = 60;        // samples kept per device (about 2 minutes at 2 s)
const TIMEOUT = 5000;   // no pong after this long = lost
const SLOW_EVERY = 10;  // while the window is hidden, ping only every 10th tick (20 s)
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const r1 = (v) => Math.round(v * 10) / 10;

/** deps: ids() -> connected device ids, send(id, obj), onChange(id) */
function create({ ids, send, onChange }) {
  const st = new Map(); // id -> { samples, times, pend: Map(n -> t0), seq, answered }
  let slow = 0;
  const get = (id) => {
    let s = st.get(id);
    if (!s) { s = { samples: [], times: [], pend: new Map(), seq: 0, answered: false }; st.set(id, s); }
    return s;
  };
  const push = (s, v) => {
    s.samples.push(v); s.times.push(Date.now());
    if (s.samples.length > KEEP) { s.samples.shift(); s.times.shift(); }
  };

  function ping(id) {
    const s = get(id), n = ++s.seq;
    s.pend.set(n, nowMs());
    send(id, { type: 'ping', n });
  }
  function onPong(id, n) {
    const s = st.get(id);
    const t0 = s && s.pend.get(n);
    if (t0 == null) return; // unknown or already timed out
    s.pend.delete(n);
    s.answered = true;
    push(s, nowMs() - t0);
    onChange(id);
  }
  function sweep() {
    const t = nowMs();
    for (const [id, s] of st) {
      let lost = false;
      for (const [n, t0] of s.pend) if (t - t0 > TIMEOUT) { s.pend.delete(n); push(s, null); lost = true; }
      if (lost) onChange(id);
    }
  }
  /** Call every 2 s. `fast` = somebody is looking at the window; otherwise it pings rarely to stay quiet. */
  function tick(fast) {
    sweep();
    slow = (slow + 1) % SLOW_EVERY;
    if (fast || slow === 0) for (const id of ids()) ping(id);
  }
  function burst(id) {
    if (!st.has(id) && !ids().includes(id)) return;
    for (let i = 0; i < 5; i++) setTimeout(() => { if (ids().includes(id)) ping(id); }, i * 150);
  }
  const reset = (id) => { st.delete(id); };
  const drop = (id) => { st.delete(id); };

  /** Snapshot for the UI (null until the first sample or ping). */
  function stats(id) {
    const s = st.get(id);
    if (!s) return null;
    const sm = s.samples, ok = sm.filter((v) => v != null);
    let jit = 0, pairs = 0;
    for (let i = 1; i < sm.length; i++) if (sm[i] != null && sm[i - 1] != null) { jit += Math.abs(sm[i] - sm[i - 1]); pairs++; }
    return {
      samples: sm.map((v) => (v == null ? null : r1(v))), times: s.times.slice(), answered: s.answered,
      last: sm.length ? (sm[sm.length - 1] == null ? null : r1(sm[sm.length - 1])) : null,
      avg: ok.length ? r1(ok.reduce((a, b) => a + b, 0) / ok.length) : null,
      min: ok.length ? r1(Math.min(...ok)) : null,
      max: ok.length ? r1(Math.max(...ok)) : null,
      jitter: pairs ? r1(jit / pairs) : null,
      loss: sm.length ? Math.round((100 * (sm.length - ok.length)) / sm.length) : 0,
    };
  }
  return { ping, onPong, tick, burst, reset, drop, stats };
}
module.exports = { create, KEEP };
