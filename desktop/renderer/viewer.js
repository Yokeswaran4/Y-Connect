// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
// Draws the newest JPEG from the other device. Older pictures that were not drawn yet are skipped, so it never lags behind.
// Also forwards the mouse and keyboard to the shared device: over ADB for a phone (set up in the panel below), or - when the
// sharer allowed it - through Y Connect's own remote control.
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const wait = document.getElementById('wait');
let latest = null, busy = false;

async function pump() {
  if (busy) return;
  busy = true;
  while (latest) {
    const jpeg = latest; latest = null;
    try {
      const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; window.viewer.dims(bmp.width, bmp.height); } // rotation: control maps to the new shape
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      if (wait) { wait.remove(); }
    } catch {}
  }
  busy = false;
}
window.viewer.onFrame((jpeg) => { latest = jpeg; pump(); });
document.addEventListener('dblclick', () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); });

/* ---------- remote control ---------- */
const $ = (id) => document.getElementById(id);
const btn = $('ctl'), setupBtn = $('adbsetup'), tag = $('tag'), nav = $('nav'), panel = $('setup'), msg = $('msg');
let android = false, allowed = false, on = false, mode = null, starting = false, lastMove = 0, down = false, lastPos = null;
const typed = new Set(); // keys already sent as text, so their key-up is not sent as a key event

function setUi() {
  btn.hidden = !(android || allowed);
  setupBtn.hidden = !android;
  btn.textContent = starting ? 'Connecting…' : on ? 'Controlling — click to stop' : 'Control';
  btn.classList.toggle('on', on);
  tag.hidden = !on;
  tag.textContent = mode === 'adb' ? 'ADB' : mode === 'adb-basic' ? 'ADB (basic)' : 'Basic';
  nav.hidden = !(on && android);
  canvas.style.cursor = on ? 'crosshair' : 'default';
}
function send(ev) { if (on) window.viewer.input(ev); }
function release() { if (on) { window.viewer.input({ k: 'release' }); down = false; typed.clear(); } }
function stopControl() {
  release();
  if (mode === 'adb' || mode === 'adb-basic') window.viewer.adbStop();
  on = false; mode = null; setUi();
}
function say(text, ok) { msg.textContent = text || ''; msg.classList.toggle('ok', !!ok); }

/** Turns control on: ADB first for a phone, Y Connect's own control only when the phone allowed it. */
async function startControl() {
  if (starting) return;
  if (android) {
    starting = true; setUi();
    const r = await window.viewer.adbStart().catch((e) => ({ ok: false, error: String(e && e.message || e) }));
    starting = false;
    if (r.ok) { on = true; mode = r.mode === 'scrcpy' ? 'adb' : 'adb-basic'; setUi(); return; }
    if (allowed) { on = true; mode = 'ctl'; setUi(); return; }
    openPanel(r);
  } else if (allowed) { on = true; mode = 'ctl'; setUi(); }
}
function openPanel(r) {
  $('why').textContent = (r && r.error) || '';
  const d = r && r.disc;
  if (d && d.pair) $('pairHost').value = `${d.pair.host}:${d.pair.port}`;
  if (d && d.connect) $('connHost').value = `${d.connect.host}:${d.connect.port}`;
  say('');
  panel.hidden = false;
  setUi();
}
function closePanel() { panel.hidden = true; }
async function afterAdb(r) {
  $('doPair').disabled = $('doConnect').disabled = false;
  if (r.ok) { closePanel(); on = true; mode = r.mode === 'scrcpy' ? 'adb' : 'adb-basic'; setUi(); return; }
  say(r.error || 'Failed');
}
async function busyPanel(fn) {
  $('doPair').disabled = $('doConnect').disabled = true;
  say('Working…', true);
  afterAdb(await fn().catch((e) => ({ ok: false, error: String(e && e.message || e) })));
}
$('doPair').onclick = () => busyPanel(() => window.viewer.adbPair($('pairHost').value.trim(), $('pairCode').value.trim()));
$('doConnect').onclick = () => busyPanel(async () => {
  const hp = $('connHost').value.trim();
  const r = hp ? await window.viewer.adbConnect(hp) : await window.viewer.adbStart();
  if (!r.ok && r.disc) { if (r.disc.pair) $('pairHost').value = `${r.disc.pair.host}:${r.disc.pair.port}`; if (r.disc.connect && !hp) $('connHost').value = `${r.disc.connect.host}:${r.disc.connect.port}`; }
  return r;
});
$('doClose').onclick = closePanel;
setupBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  openPanel({ disc: await window.viewer.adbDiscover().catch(() => null) });
});
for (const b of [setupBtn, panel]) { b.addEventListener('dblclick', (e) => e.stopPropagation()); }

window.viewer.onInfo((i) => { android = !!(i && i.android); setUi(); });
window.viewer.onControl((v) => { allowed = v; if (!v && mode === 'ctl') { release(); on = false; mode = null; } setUi(); });
window.viewer.onAdbEnded(() => { on = false; mode = null; down = false; typed.clear(); setUi(); }); // phone disconnected / control server stopped
btn.addEventListener('click', (e) => { e.stopPropagation(); if (on) stopControl(); else startControl(); });
btn.addEventListener('dblclick', (e) => e.stopPropagation());
nav.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) send({ k: 'nav', a: b.dataset.a }); });
nav.addEventListener('dblclick', (e) => e.stopPropagation());

/** 0..1 position inside the picture itself (the canvas letterboxes it). null on the black bars, or - with clamp - the nearest edge. */
function pos(e, clamp) {
  const r = canvas.getBoundingClientRect();
  if (!canvas.width || !canvas.height) return null;
  const k = Math.min(r.width / canvas.width, r.height / canvas.height);
  const w = canvas.width * k, h = canvas.height * k;
  let x = (e.clientX - r.left - (r.width - w) / 2) / w, y = (e.clientY - r.top - (r.height - h) / 2) / h;
  if (x < 0 || y < 0 || x > 1 || y > 1) { if (!clamp) return null; x = Math.min(1, Math.max(0, x)); y = Math.min(1, Math.max(0, y)); }
  return { x, y };
}
canvas.addEventListener('mousemove', (e) => {
  if (!on || e.timeStamp - lastMove < 8) return;
  const p = pos(e, down); if (p) { lastMove = e.timeStamp; lastPos = p; send({ k: 'move', ...p }); }
});
window.addEventListener('mousemove', (e) => { // dragging past the edge of the picture keeps dragging
  if (!on || !down || e.target === canvas || e.timeStamp - lastMove < 8) return;
  const p = pos(e, true); if (p) { lastMove = e.timeStamp; lastPos = p; send({ k: 'move', ...p }); }
});
canvas.addEventListener('mousedown', (e) => {
  if (!on) return; e.preventDefault();
  const p = pos(e); if (p && (e.button === 0 || e.button === 2)) { lastPos = p; if (e.button === 0) down = true; send({ k: 'down', b: e.button, ...p }); }
});
window.addEventListener('mouseup', (e) => {
  if (!on || (e.button !== 0 && e.button !== 2)) return;
  const p = pos(e, true) || lastPos;
  if (e.button === 0) down = false;
  if (p) send({ k: 'up', b: e.button, ...p });
});
canvas.addEventListener('contextmenu', (e) => { if (on) e.preventDefault(); });
canvas.addEventListener('wheel', (e) => {
  if (!on) return; e.preventDefault();
  const p = pos(e); if (!p) return;
  const n = (v) => Math.sign(v) * Math.max(1, Math.round(Math.abs(v) / 100));
  send({ k: 'wheel', ...p, dx: e.deltaX ? n(e.deltaX) : 0, dy: e.deltaY ? n(e.deltaY) : 0 });
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (!on || !panel.hidden) return; // typing in the setup panel stays here
  e.preventDefault();
  // over ADB a typed character is sent as text: it works for any keyboard layout and for Shift / AltGr characters
  if ((mode === 'adb' || mode === 'adb-basic') && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) { typed.add(e.code); send({ k: 'text', s: e.key }); return; }
  send({ k: 'key', code: e.code, d: true, ch: e.key.length === 1 ? e.key : '', ctrl: e.ctrlKey || e.metaKey || e.altKey });
}, true);
window.addEventListener('keyup', (e) => {
  if (!on || !panel.hidden) return;
  e.preventDefault();
  if (typed.delete(e.code)) return;
  send({ k: 'key', code: e.code, d: false });
}, true);
window.addEventListener('blur', release);
// while controlling, a double click belongs to the other device
document.addEventListener('dblclick', (e) => { if (on) e.stopImmediatePropagation(); }, true);
setUi();
