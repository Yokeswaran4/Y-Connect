// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
const $ = (id) => document.getElementById(id);
const setHtml = (el, h) => { if (el._h === h) return false; el._h = h; el.innerHTML = h; return true; }; // skip identical repaints
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let inited = false;
let lastTrSig = null;
let trFilter = 'all';
let lastState = null;
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

// --- theme: use the system accent colour, nudged so it stays readable on light/dark surfaces ---
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function mix(hex, other, t) {
  const a = parseInt(hex.slice(1), 16);
  const ch = (sh) => Math.round(((a >> sh) & 255) * (1 - t) + ((other >> sh) & 255) * t);
  return '#' + [16, 8, 0].map((sh) => ch(sh).toString(16).padStart(2, '0')).join('');
}
function applyAccent(s) {
  let accent = /^#[0-9a-f]{6}$/i.test(s.accent || '') ? s.accent : '#5aa5f0';
  const l = lum(accent);
  if (darkQuery.matches && l < 0.15) accent = mix(accent, 0xffffff, 0.4);
  else if (!darkQuery.matches && l > 0.55) accent = mix(accent, 0x000000, 0.35);
  const r = document.documentElement.style;
  r.setProperty('--accent', accent);
  r.setProperty('--on-accent', lum(accent) > 0.4 ? '#000000' : '#ffffff');
}
darkQuery.addEventListener('change', () => { if (lastState) applyAccent(lastState); });

// --- helpers ---
const fmt = (b) => {
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(1) + ' ' + u[i];
};
function statusText(t) {
  switch (t.status) {
    case 'waiting': return t.dir === 'out' ? `Waiting for ${t.peer} to accept…` : 'Starting…';
    case 'active': return `${fmt(t.done)} / ${fmt(t.size)}`;
    case 'done': return `Done · ${fmt(t.size)}`;
    case 'rejected': return `Declined by ${t.peer}`;
    case 'cancelled': return 'Cancelled';
    default: return t.canResume ? 'Connection lost · will continue automatically, or press Resume' : 'Failed';
  }
}


// --- navigation (sliding highlight) ---
const tabs = Array.from(document.querySelectorAll('.tab'));
function movePill() {
  const on = document.querySelector('.tab.on');
  if (!on) return;
  const p = $('pill');
  p.style.height = on.offsetHeight + 'px';
  p.style.transform = `translateY(${on.offsetTop}px)`;
}
const pages = Array.from(document.querySelectorAll('.page'));
pages.forEach((p) => Array.from(p.children).forEach((c, i) => c.style.setProperty('--i', Math.min(i, 9))));
const pageIndex = (p) => tabs.findIndex((t) => 'p-' + t.dataset.page === p.id);
function showTab(t) {
  const sel = tabs.indexOf(t);
  tabs.forEach((x) => x.classList.toggle('on', x === t));
  pages.forEach((p) => {
    const i = pageIndex(p);
    p.classList.toggle('on', i === sel);
    p.classList.toggle('before', i < sel); // sits to the left: slides out/in from the left
    p.classList.toggle('after', i > sel);
  });
  const ti = document.querySelector('.titles');
  if (ti && $('pgTitle').textContent !== t.dataset.title) { ti.classList.remove('swap'); void ti.offsetWidth; ti.classList.add('swap'); }
  $('pgTitle').textContent = t.dataset.title;
  $('pgSub').textContent = t.dataset.sub;
  movePill();
}
tabs.forEach((t, i) => { t.title = 'Ctrl+' + (i + 1); t.addEventListener('click', () => showTab(t)); });
showTab(tabs.find((t) => t.classList.contains('on')) || tabs[0]);
// keyboard: Ctrl+1..7 switches page
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  const n = Number(e.key);
  if (n >= 1 && n <= tabs.length && !document.querySelector('.modal.on')) { e.preventDefault(); tabs[n - 1].click(); }
});
window.addEventListener('resize', movePill);
requestAnimationFrame(movePill);

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('on'), 1800);
}
// only newly appeared rows animate in
let armTimer = null;
let armed = null; // device whose Unpair button was clicked once (needs a second click)
const seen = { peers: new Set(), nearby: new Set(), tr: new Set(), log: new Set() };
const freshBy = new Map();
const enter = (set, key) => {
  let f = freshBy.get(set);
  if (!f) freshBy.set(set, (f = new Set()));
  if (!set.has(key)) { set.add(key); f.add(key); setTimeout(() => f.delete(key), 800); }
  return f.has(key) ? ' enter' : '';
};
const initial = (n) => esc((n || '?').trim().charAt(0).toUpperCase());
const ic = (n) => `<svg><use href="#i-${n}"/></svg>`;
const platIc = (p) => (p === 'android' ? 'phone' : p === 'windows' ? 'monitor' : 'laptop');
const platName = (p) => ({ android: 'Android', windows: 'Windows', linux: 'Linux' }[p] || String(p || 'Device'));
const batHtml = (b) => { const lv = Number(b.level) || 0, cls = !b.charging && lv <= 15 ? ' low' : !b.charging && lv <= 35 ? ' mid' : ''; return `<span class="bat${cls}" title="${b.charging ? 'Charging' : 'Battery'}">${ic(b.charging ? 'bolt' : 'battery')}${lv}%</span>`; };
const setStat = (id, n) => { const el = $(id); if (el.textContent !== String(n)) { el.textContent = n; el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); } };
let logFilter = 'all';
const setBadge = (el, n) => { el.textContent = n; el.classList.toggle('hide', !n); };

// --- connection latency (per device) ---
const KEEP = 60; // samples the main process keeps; the graph always spans this many slots
const lat = { open: new Set(), data: new Map(), hover: new Set(), fresh: new Set(), addr: new Map() };
const fmtMs = (v) => (v == null ? '—' : (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ms');
function quality(l) {
  if (!l || !l.samples.length) return { cls: 'q-idle', label: 'Measuring…' };
  if (!l.answered) return { cls: 'q-idle', label: 'No reply yet' };
  const rec = l.samples.slice(-5), ok = rec.filter((v) => v != null);
  if (!ok.length) return { cls: 'q-bad', label: 'No reply' };
  if (rec.length - ok.length >= 2) return { cls: 'q-bad', label: 'Unstable' };
  const avg = ok.reduce((a, b) => a + b, 0) / ok.length;
  if (avg < 20) return { cls: 'q-ok', label: 'Excellent' };
  if (avg < 60) return { cls: 'q-good', label: 'Good' };
  if (avg < 150) return { cls: 'q-fair', label: 'Fair' };
  return { cls: 'q-bad', label: 'Poor' };
}
function latSvg(l, w, h, big) {
  const sm = l ? l.samples : [], ok = sm.filter((v) => v != null);
  const max = Math.max(40, ...ok) * 1.15, off = KEEP - sm.length, step = w / (KEEP - 1);
  const X = (i) => (off + i) * step, Y = (v) => h - 2 - (v / max) * (h - 4);
  let line = '', area = '', run = [];
  const pts = () => run.map(([x, y]) => x.toFixed(1) + ' ' + y.toFixed(1)).join('L');
  const flush = () => {
    if (!run.length) return;
    line += 'M' + pts() + (run.length === 1 ? 'l.1 0' : '');
    if (run.length > 1) area += 'M' + run[0][0].toFixed(1) + ' ' + h + 'L' + pts() + 'L' + run[run.length - 1][0].toFixed(1) + ' ' + h + 'Z';
    run = [];
  };
  let lost = '';
  sm.forEach((v, i) => { if (v == null) { flush(); lost += `<rect class="lx" x="${(X(i) - 1).toFixed(1)}" y="0" width="2" height="${h}"/>`; } else run.push([X(i), Y(v)]); });
  flush();
  const grid = big ? [0.25, 0.5, 0.75].map((f) => `<line class="lg" x1="0" x2="${w}" y1="${(h * f).toFixed(1)}" y2="${(h * f).toFixed(1)}"/>`).join('') : '';
  return `<svg class="${big ? 'latchart' : 'spark'}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${grid}<path class="la" d="${area}"/>${lost}<path class="ll" d="${line}"/>${big ? `<line class="cur" y1="0" y2="${h}" x1="0" x2="0" style="display:none"/>` : ''}</svg>`;
}
function latHtml(id) {
  const l = lat.data.get(id), q = quality(l), open = lat.open.has(id);
  let h = `<button class="latbar ${q.cls}" aria-expanded="${open}" title="Show or hide details"><i class="qd"></i><b>${l ? fmtMs(l.last) : '—'}</b><span class="dim s">${q.label}</span><span class="chev">${open ? 'Hide details ▴' : 'Details ▾'}</span></button>`;
  if (open) {
    const max = Math.max(40, ...(l ? l.samples.filter((v) => v != null) : [])) * 1.15;
    h += `<div class="latpanel ${q.cls}${lat.fresh.has(id) ? ' fresh' : ''}"><div class="dim s">Address · ${esc(lat.addr.get(id) || '—')}</div><div class="latmain"><span class="dim s">${Math.round(max)} ms</span>${latSvg(l, 300, 90, true)}<div class="latx dim s"><span>~2 min ago</span><span class="lattip">Hover the graph for details</span><span>now</span></div></div>`
      + `<div class="latstats">${[['Now', l && l.last], ['Average', l && l.avg], ['Best', l && l.min], ['Worst', l && l.max], ['Jitter', l && l.jitter]].map(([k, v]) => `<div><small>${k}</small><b>${fmtMs(v)}</b></div>`).join('')}<div><small>Lost</small><b>${l ? l.loss : 0}%</b></div></div>`
      + `<div class="btns" style="margin:0"><button class="b ghost sm pingbtn">Ping ×5</button><span class="dim s" style="align-self:center">${l && !l.answered && l.samples.length > 2 ? 'This device’s Y Connect version doesn’t answer pings yet.' : 'Measured through the encrypted link, every 2 s while this window is open.'}</span></div></div>`;
  }
  return h;
}
function paintLat(id) {
  if (lat.hover.has(id)) return; // don't redraw under the pointer
  const el = Array.from(document.querySelectorAll('#peers .peer')).find((i) => i.dataset.id === id);
  const box = el && el.querySelector('.lat');
  if (box) setHtml(box, latHtml(id));
  lat.fresh.delete(id);
}

function render(s) {
  lastState = s;
  applyAccent(s);
  if (!inited) {
    $('myName').value = s.config.name;
    $('pass').value = s.config.passphrase;
    inited = true;
  }
  $('tClip').checked = s.config.clipboardSync;
  $('tNotif').checked = s.config.notifySync;
  $('tFiles').checked = s.config.acceptFiles;
  const au = s.autostart || { supported: false };
  $('startCard').style.display = au.supported ? '' : 'none';
  $('tStart').checked = !!au.enabled;
  $('startMode').style.display = au.enabled ? '' : 'none'; // only matters while launch on startup is on
  document.querySelectorAll('#segStart button').forEach((b) => b.classList.toggle('on', (b.dataset.hidden === '1') === (au.hidden !== false)));
  $('startErr').classList.toggle('hide', !au.error);
  $('startWhy').textContent = au.error ? 'Why: ' + au.error.why + ' How to fix: ' + au.error.fix : '';
  $('tBat').checked = s.config.batterySync !== false;
  $('tCmd').checked = !!s.config.allowCommands;
  $('tColors').checked = s.config.systemColors;
  document.querySelectorAll('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === s.config.theme));
  $('colHint').textContent = s.platform === 'win32' || s.platform === 'darwin'
    ? 'Follow the system accent color. Off uses Y Connect blue.'
    : 'This system has no accent color to follow, so Y Connect blue is used.';
  $('ver').textContent = s.version;
  $('tUpd').checked = !!s.config.autoUpdateCheck;
  paintUpdate(s, lastUpd);
  $('ips').textContent = s.ips.length ? s.ips[0] : 'No network';
  setHtml($('ipChips'), s.ips.length ? s.ips.map((i) => `<span class="chip">${esc(i)}</span>`).join('') : '<span class="dim">No network connection detected</span>');
  $('led').classList.toggle('ok', s.peers.length > 0);
  $('stTxt').textContent = s.peers.length ? `${s.peers.length} device${s.peers.length > 1 ? 's' : ''} connected` : 'Waiting for devices';
  setBadge($('bDev'), s.peers.length);
  setStat('statDev', s.peers.length);
  setStat('statNear', s.nearby.length);

  $('hint').innerHTML = '';
  for (const id of [...lat.data.keys()]) if (!s.peers.some((p) => p.id === id)) { lat.data.delete(id); lat.open.delete(id); lat.hover.delete(id); }
  for (const p of s.peers) { if (p.lat) lat.data.set(p.id, p.lat); lat.addr.set(p.id, p.address); }
  const peersHtml = s.peers.length
    ? s.peers.map((p) => `<div class="peer${enter(seen.peers, p.id)}" data-id="${esc(p.id)}"><div class="dropcue">${ic('download')}Drop to send to ${esc(p.name)}</div><div class="peer-top"><div class="avatar">${ic(platIc(p.platform))}<i class="dot"></i></div><div class="grow"><b>${esc(p.name)}</b><div class="dim s">${esc(platName(p.platform))}</div></div>${s.config.batterySync !== false && p.battery ? batHtml(p.battery) : ''}</div><div class="peer-actions"><button class="b sm sendbtn">${ic('send')}Send file</button><button class="b ghost sm sendfolderbtn">${ic('folder')}Send folder</button><button class="b ghost sm unpairbtn${armed === p.id ? ' armed' : ''}" title="Unpair this device">${armed === p.id ? 'Confirm unpair' : ic('unlink')}</button></div><div class="lat" data-lat></div></div>`).join('')
    : `<div class="card" style="grid-column:1/-1;margin:0"><div class="radar big"><div class="scan">${ic('wifi')}</div><b>Looking for devices…</b><span class="s">Open Y Connect on another device on the same Wi-Fi.</span><div class="steps"><span><i>1</i>Open Y Connect on your phone</span><span><i>2</i>Pick it under Nearby</span><span><i>3</i>Type the code shown</span></div></div></div>`;
  setHtml($('peers'), peersHtml);
  for (const p of s.peers) paintLat(p.id);

  const nearbyHtml = s.nearby.length
    ? s.nearby.map((n) => `<div class="item nearby${enter(seen.nearby, n.id)}" data-id="${esc(n.id)}"><div class="avatar">${ic(platIc(n.platform))}</div><div class="grow"><b>${esc(n.name)}</b><div class="dim s">${esc(platName(n.platform))}</div></div><button class="b sm pairbtn">${ic('plus')}Pair</button></div>`).join('')
    : `<div class="radar"><div class="scan">${ic('pulse')}</div><b>Scanning your network…</b><span class="s">No other devices found yet. Open Y Connect on your other device.</span></div>`;
  setHtml($('nearby'), nearbyHtml);

  // pairing dialogs follow the state
  if (pairing && s.peers.some((p) => p.id === pairing.id)) {
    const n = pairing.name;
    closePair(false);
    toast('Paired with ' + n);
  }
  const pr = s.pairRequest;
  if (!pr) dismissedPair = null;
  if (pr && enterFor !== pr.id && dismissedPair !== pr.id) openEnter(pr);
  else if (!pr && enterFor && $('mEnter').classList.contains('on')) closeEnter(false);

  const live = s.transfers.filter((t) => t.status === 'waiting' || t.status === 'active').length;
  setBadge($('bTr'), live);
  setStat('statTr', live);
  const trMatch = (t) => trFilter === 'sent' ? t.dir === 'out' : trFilter === 'received' ? t.dir === 'in' : trFilter === 'queued' ? t.status === 'waiting' : true;
  $('cAll').textContent = s.transfers.length;
  $('cSent').textContent = s.transfers.filter((t) => t.dir === 'out').length;
  $('cRecv').textContent = s.transfers.filter((t) => t.dir === 'in').length;
  $('cQueued').textContent = s.transfers.filter((t) => t.status === 'waiting').length;
  const trList = s.transfers.filter(trMatch);
  const stLabel = (t) => ({ waiting: 'Queued', active: 'Transferring', done: 'Complete', rejected: 'Declined', cancelled: 'Cancelled' }[t.status] || (t.canResume ? 'Paused' : 'Failed'));
  const trBuild = () => trList.length
    ? trList.map((t) => {
        const isLive = t.status === 'waiting' || t.status === 'active';
        const pct = t.size > 0 ? Math.min(100, Math.round((t.done / t.size) * 100)) : (t.status === 'done' ? 100 : 0);
        const st = ['waiting', 'active', 'done', 'rejected', 'cancelled'].includes(t.status) ? t.status : (t.canResume ? 'paused' : 'failed');
        const btn = isLive ? `<button class="b ghost sm cancelbtn" data-id="${t.id}">${ic('x')}Cancel</button>` : (t.canResume ? `<button class="b sm resumebtn" data-id="${t.id}">${ic('resume')}Resume</button>` : '');
        return `<div class="tr${enter(seen.tr, t.id)}" data-tid="${t.id}" data-status="${st}" data-live="${isLive ? 1 : 0}"><div class="tr-top"><div class="dir">${ic(t.dir === 'out' ? 'send' : 'download')}</div><div class="grow"><b>${esc(t.name)}</b><div class="dim s">${t.dir === 'out' ? 'To' : 'From'} ${esc(t.peer)}</div></div>${isLive ? `<span class="pct">${pct}%</span>` : ''}${btn}</div>`
          + (isLive ? `<div class="bar"><div style="width:${pct}%"></div></div>` : '')
          + `<div class="tr-st"><span class="pillst">${esc(stLabel(t))}</span><span class="sttxt">${esc(statusText(t))}</span></div></div>`;
      }).join('')
    : s.transfers.length
      ? `<div class="card empty"><div class="em-ic">${ic('transfers')}</div><b>No ${trFilter} transfers</b><span class="s">Nothing here right now.</span></div>`
      : `<div class="card empty"><div class="em-ic">${ic('transfers')}</div><b>No transfers yet</b><span class="s">Use “Send file” or “Send folder” on a device, or drop files onto it.</span></div>`;
  // while only progress changes, update the numbers in place (no rebuild, so the bar glides)
  const trSig = trFilter + '#' + trList.map((t) => t.id + ':' + t.status + ':' + (t.canResume ? 1 : 0)).join('|');
  if (trList.length && trSig === lastTrSig) {
    for (const t of trList) {
      const el = $('transfers').querySelector(`.tr[data-tid="${t.id}"]`);
      if (!el) continue;
      const pct = t.size > 0 ? Math.min(100, Math.round((t.done / t.size) * 100)) : (t.status === 'done' ? 100 : 0);
      const pe = el.querySelector('.pct'), be = el.querySelector('.bar>div'), se = el.querySelector('.sttxt');
      if (pe) pe.textContent = pct + '%';
      if (be) be.style.width = pct + '%';
      if (se) se.textContent = statusText(t);
    }
  } else { lastTrSig = trSig; setHtml($('transfers'), trBuild()); }

  const logs = logFilter === 'warn' ? s.log.filter((l) => l.kind === 'warn') : s.log;
  $('logCount').textContent = logs.length ? `${logs.length} event${logs.length > 1 ? 's' : ''}` : '';
  const logHtml = logs.length
    ? logs.map((l) => {
        const t = new Date(l.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const w = l.kind === 'warn' ? ' warn' : '';
        return `<div class="ev${w}${enter(seen.log, l.time + ':' + l.title)}"><time>${t}</time><span><span class="tag${w}">${esc(l.kind)}</span><b>${esc(l.title)}</b> <span class="dim">${esc(l.text)}</span>${l.count > 1 ? `<span class="x">×${l.count}</span>` : ''}</span></div>`;
      }).join('')
    : `<div class="empty"><div class="em-ic">${ic('activity')}</div><b>${logFilter === 'warn' ? 'No warnings' : 'Nothing yet'}</b><span class="s">${logFilter === 'warn' ? 'Everything is running smoothly.' : 'Events will show up here as they happen.'}</span></div>`;
  setHtml($('log'), logHtml);
}

// --- pairing: click a nearby device -> code is shown here; the other device enters it ---
let pairing = null;      // { id, name } while our code is on screen
let enterFor = null;     // id of the device that asked us to pair (null = manual entry)
let dismissedPair = null;
const codeOk = (c) => c.replace(/[^A-Za-z0-9]/g, '').length >= 4;
function closePair(notify = true) {
  if (pairing && notify) window.yconnect.pairCancel(pairing.id);
  pairing = null;
  $('mPair').classList.remove('on');
}
function openEnter(pr) {
  enterFor = pr ? pr.id : null;
  $('meTitle').textContent = pr ? pr.name + ' wants to pair' : 'Enter pairing code';
  $('meSub').textContent = pr ? 'Enter the pairing code shown on ' + pr.name + '.' : 'Enter the pairing code shown on your other device.';
  $('enterCode').value = '';
  $('mEnter').classList.add('on');
  setTimeout(() => $('enterCode').focus(), 120);
}
function closeEnter(dismiss = true) {
  if (enterFor && dismiss) { dismissedPair = enterFor; window.yconnect.dismissPair(); }
  enterFor = null;
  $('mEnter').classList.remove('on');
}
$('nearby').addEventListener('click', async (e) => {
  const row = e.target.closest('.item.nearby');
  if (!row) return;
  const r = await window.yconnect.pairRequest(row.dataset.id);
  if (!r) { toast('That device is no longer visible'); return; }
  pairing = { id: row.dataset.id, name: r.name };
  $('mpTitle').textContent = 'Pair with ' + r.name;
  $('mpSub').textContent = 'Enter this pairing code on ' + r.name + ':';
  $('mpCode').textContent = r.code;
  $('mPair').classList.add('on');
});
$('mpCancel').onclick = () => closePair(true);
$('btnHaveCode').onclick = () => openEnter(null);
$('meCancel').onclick = () => closeEnter(true);
$('mePair').onclick = async () => {
  const code = $('enterCode').value.trim();
  if (!codeOk(code)) { toast('Enter the full pairing code'); return; }
  if (enterFor) await window.yconnect.dismissPair();
  dismissedPair = enterFor;
  enterFor = null;
  $('mEnter').classList.remove('on');
  $('pass').value = code;
  render(await window.yconnect.setConfig({ passphrase: code }));
  toast('Pairing code set — connecting…');
};
$('enterCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('mePair').click(); if (e.key === 'Escape') $('meCancel').click(); });
$('mPair').addEventListener('keydown', (e) => { if (e.key === 'Escape') $('mpCancel').click(); });

$('btnSave').onclick = async () => {
  render(await window.yconnect.setConfig({ name: $('myName').value, passphrase: $('pass').value }));
  toast('Saved');
};
let passShown = false;
const setPassShown = (v) => {
  passShown = v;
  $('pass').classList.toggle('masked', !v);
  $('btnShowPass').textContent = v ? 'Hide' : 'Show';
  $('btnShowPass').setAttribute('aria-pressed', String(v));
};
$('btnShowPass').onclick = () => setPassShown(!passShown);
setPassShown(false);
$('btnGen').onclick = () => {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(8));
  const s = Array.from(r, (n) => a[n % a.length]).join('');
  $('pass').value = s.slice(0, 4) + '-' + s.slice(4);
  setPassShown(true); // show the new code so it can be read out, like on Android
};
$('tClip').onchange = (e) => window.yconnect.setConfig({ clipboardSync: e.target.checked });
$('tNotif').onchange = (e) => window.yconnect.setConfig({ notifySync: e.target.checked });
$('tColors').onchange = (e) => window.yconnect.setConfig({ systemColors: e.target.checked });
document.querySelectorAll('#seg button').forEach((b) => b.addEventListener('click', () => window.yconnect.setConfig({ theme: b.dataset.theme })));
$('tFiles').onchange = (e) => window.yconnect.setConfig({ acceptFiles: e.target.checked });
$('tStart').onchange = async (e) => { render(await window.yconnect.setConfig({ launchOnStartup: e.target.checked })); };
document.querySelectorAll('#segStart button').forEach((b) => b.addEventListener('click', async () => { render(await window.yconnect.setConfig({ startHidden: b.dataset.hidden === '1' })); }));
$('tBat').onchange = (e) => window.yconnect.setConfig({ batterySync: e.target.checked });
$('tCmd').onchange = (e) => window.yconnect.setConfig({ allowCommands: e.target.checked });
$('btnSend').onclick = async () => {
  const n = await window.yconnect.sendClipboard();
  toast(n > 0 ? `Sent to ${n} device${n > 1 ? 's' : ''}` : 'Nothing sent');
};
$('btnTest').onclick = () => { window.yconnect.testNotification(); toast('Test notification sent'); };
$('btnConnect').onclick = async () => {
  const ok = await window.yconnect.connectIp($('ip').value);
  if (ok) $('ip').value = '';
  toast(ok ? 'Connecting…' : 'Invalid address');
};

// --- file transfer ---
$('btnOpenDl').onclick = () => window.yconnect.openDownloads();
$('trFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  trFilter = b.dataset.f;
  for (const x of $('trFilter').children) x.classList.toggle('on', x === b);
  lastTrSig = null;
  if (lastState) render(lastState);
});
$('btnClearTr').onclick = () => window.yconnect.clearTransfers();
$('transfers').addEventListener('click', (e) => {
  const b = e.target.closest('.cancelbtn');
  if (b) window.yconnect.cancelTransfer(Number(b.dataset.id));
  const r = e.target.closest('.resumebtn');
  if (r) window.yconnect.resumeTransfer(Number(r.dataset.id));
});
$('peers').addEventListener('click', async (e) => {
  const lb = e.target.closest('.latbar');
  if (lb) {
    const id = lb.closest('.peer').dataset.id;
    if (!lat.open.delete(id)) { lat.open.add(id); lat.fresh.add(id); }
    lat.hover.delete(id);
    paintLat(id);
    return;
  }
  const pb = e.target.closest('.pingbtn');
  if (pb) { window.yconnect.pingNow(pb.closest('.peer').dataset.id); return; }
  const b = e.target.closest('.sendbtn');
  if (b) { window.yconnect.pickAndSend(b.closest('.peer').dataset.id); return; }
  const fb = e.target.closest('.sendfolderbtn');
  if (fb) { window.yconnect.pickFolderAndSend(fb.closest('.peer').dataset.id); return; }
  const u = e.target.closest('.unpairbtn');
  if (!u) return;
  const id = u.closest('.peer').dataset.id;
  clearTimeout(armTimer);
  if (armed !== id) { // first click: ask for confirmation
    armed = id;
    armTimer = setTimeout(() => { armed = null; if (lastState) render(lastState); }, 3500);
  } else { // second click: unpair
    armed = null;
    await window.yconnect.unpair(id);
    toast('Unpaired');
  }
  if (lastState) render(lastState);
});
// graph: hover to read a single sample
$('peers').addEventListener('mousemove', (e) => {
  const c = e.target.closest('.latchart');
  if (!c) return;
  const item = c.closest('.peer'), id = item.dataset.id, l = lat.data.get(id);
  if (!l) return;
  const r = c.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const off = KEEP - l.samples.length, i = Math.round(frac * (KEEP - 1)) - off;
  const cur = c.querySelector('.cur'), tip = item.querySelector('.lattip');
  lat.hover.add(id);
  if (i < 0 || i >= l.samples.length) { cur.style.display = 'none'; tip.textContent = 'Hover the graph for details'; return; }
  const x = (off + i) * (300 / (KEEP - 1));
  cur.setAttribute('x1', x); cur.setAttribute('x2', x); cur.style.display = '';
  const ago = Math.max(0, Math.round((Date.now() - l.times[i]) / 1000));
  tip.textContent = (l.samples[i] == null ? 'Lost' : fmtMs(l.samples[i])) + ' · ' + (ago < 2 ? 'just now' : ago + ' s ago');
});
$('peers').addEventListener('mouseout', (e) => {
  const c = e.target.closest('.latchart');
  if (!c || c.contains(e.relatedTarget)) return;
  const id = c.closest('.peer').dataset.id;
  lat.hover.delete(id);
  paintLat(id);
});
$('peers').addEventListener('dragover', (e) => {
  const p = e.target.closest('.peer');
  if (!p) return;
  e.preventDefault();
  p.classList.add('drop');
});
$('peers').addEventListener('dragleave', (e) => {
  const p = e.target.closest('.peer');
  if (p && !p.contains(e.relatedTarget)) p.classList.remove('drop');
});
$('peers').addEventListener('drop', (e) => {
  const p = e.target.closest('.peer');
  if (!p) return;
  e.preventDefault();
  p.classList.remove('drop');
  const paths = Array.from(e.dataTransfer.files).map((f) => window.yconnect.pathForFile(f)).filter(Boolean);
  if (paths.length) window.yconnect.sendFiles(p.dataset.id, paths);
});
// drop files anywhere: with one connected device they go straight to it
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
const hideDrop = () => { dragDepth = 0; $('dropAll').classList.remove('on'); };
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  const ps = lastState ? lastState.peers : [];
  $('dropTo').textContent = ps.length === 1 ? 'to ' + ps[0].name : ps.length ? 'Drop onto a device in the list' : 'No device connected yet';
  $('dropAll').classList.add('on');
});
document.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) hideDrop(); });
// dropping outside a device row must not make the window navigate to the file
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  hideDrop();
  if (e.target.closest && e.target.closest('#peers .peer')) return; // handled by the row itself
  const paths = Array.from(e.dataTransfer.files).map((f) => window.yconnect.pathForFile(f)).filter(Boolean);
  const ps = lastState ? lastState.peers : [];
  if (!paths.length) return;
  if (ps.length === 1) { window.yconnect.sendFiles(ps[0].id, paths); toast('Sending to ' + ps[0].name); }
  else toast(ps.length ? 'Drop the files onto a device in the list' : 'No device connected');
});

// click a code or IP address to copy it
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Copied'); } catch { toast('Could not copy'); }
}
$('mpCode').addEventListener('click', () => copyText($('mpCode').textContent));
$('ipChips').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) copyText(c.textContent); });

document.querySelectorAll('.link-card').forEach((a) => a.addEventListener('click', () => window.yconnect.openExternal(a.dataset.url)));
// license texts load only when a section is opened (keeps the page light)
let licenses = null;
document.querySelectorAll('#p-licenses details').forEach((d) => d.addEventListener('toggle', async () => {
  if (!d.open) return;
  const pre = d.querySelector('pre');
  if (pre.dataset.done) return;
  licenses = licenses || await window.yconnect.getLicenses();
  pre.textContent = licenses[pre.dataset.key] || '';
  pre.dataset.done = '1';
}));

// --- about this device ---
async function loadDeviceInfo() {
  try {
    const info = await window.yconnect.getDeviceInfo();
    // just the basics; the full technical list is only added to the debug report
    $('devInfo').innerHTML = info.brief.map(([k, v]) => `<div class="tg"><div>${esc(k)}</div><span class="dv">${esc(v)}</span></div>`).join('');
  } catch { $('devInfo').textContent = 'Could not read device info.'; }
}
$('btnCopyDbg').onclick = async () => { await window.yconnect.copyDebugReport(); toast('Debug report copied'); };
$('btnSaveDbg').onclick = async () => { if (await window.yconnect.saveDebugReport()) toast('Debug report saved'); };

// --- updates ---
let updBusy = false;
const updAgo = (t) => (t ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
function paintUpdate(s, r) {
  const n = (r && r.ok && r.newer) ? r : (s && s.update);
  $('updTitle').textContent = n ? `Y Connect ${n.latest} is available` : `You have Y Connect ${s ? s.version : ''}`;
  $('updNew').classList.toggle('hide', !n);
  if (n) {
    $('updNewTitle').textContent = `Version ${n.latest} is out`;
    $('updNotes').textContent = n.notes || 'Open the download page to see what’s new.';
    $('btnUpdOpen').dataset.url = n.url;
  }
  let msg = 'Not checked yet';
  if (updBusy) msg = 'Checking GitHub…';
  else if (r && !r.ok) msg = r.error;
  else if (r && r.ok && !r.newer) msg = 'You’re up to date.';
  else if (n) msg = `You have ${s.version}.`;
  else if (s && s.config.lastUpdateCheck) msg = 'Last checked ' + updAgo(s.config.lastUpdateCheck);
  $('updStatus').textContent = msg;
  $('btnUpd').disabled = updBusy;
  $('btnUpd').querySelector('span').textContent = updBusy ? 'Checking…' : 'Check for updates';
}
let lastUpd = null;
$('btnUpd').onclick = async () => {
  updBusy = true; paintUpdate(lastState, lastUpd);
  lastUpd = await window.yconnect.checkUpdate();
  updBusy = false; paintUpdate(lastState, lastUpd);
};
$('btnUpdOpen').onclick = (e) => { const u = e.currentTarget.dataset.url; if (u) window.yconnect.openExternal(u); };
$('tUpd').onchange = async (e) => { render(await window.yconnect.setConfig({ autoUpdateCheck: e.target.checked })); };
loadDeviceInfo();


// --- activity filter ---
document.querySelectorAll('#logSeg button').forEach((b) => b.addEventListener('click', () => {
  logFilter = b.dataset.f;
  document.querySelectorAll('#logSeg button').forEach((x) => x.classList.toggle('on', x === b));
  if (lastState) render(lastState);
}));

// --- copy helpers ---
$('ips').addEventListener('click', () => { if (lastState && lastState.ips[0]) copyText(lastState.ips[0]); });
$('btnCopyPass').onclick = () => copyText($('pass').value);

// --- quick actions (Ctrl+K) ---
const pal = { sel: 0, items: [] };
const palCommands = () => [
  ...tabs.map((t, i) => ({ label: 'Go to ' + t.dataset.title, icon: t.dataset.page, hint: 'Ctrl+' + (i + 1), run: () => t.click() })),
  { label: 'Send clipboard now', icon: 'clipboard', run: () => $('btnSend').click() },
  { label: 'Send test notification', icon: 'bell', run: () => $('btnTest').click() },
  { label: 'Enter a pairing code', icon: 'key', run: () => openEnter(null) },
  { label: 'Open downloads folder', icon: 'folder', run: () => $('btnOpenDl').click() },
  { label: 'Copy this computer’s IP address', icon: 'copy', run: () => $('ips').click() },
  { label: 'Theme: System', icon: 'auto', run: () => window.yconnect.setConfig({ theme: 'system' }) },
  { label: 'Theme: Light', icon: 'sun', run: () => window.yconnect.setConfig({ theme: 'light' }) },
  { label: 'Theme: Dark', icon: 'moon', run: () => window.yconnect.setConfig({ theme: 'dark' }) },
];
function palPaint() {
  const q = $('palIn').value.trim().toLowerCase();
  pal.items = palCommands().filter((c) => c.label.toLowerCase().includes(q));
  pal.sel = Math.min(pal.sel, Math.max(0, pal.items.length - 1));
  $('palList').innerHTML = pal.items.length
    ? pal.items.map((c, i) => `<button class="pi${i === pal.sel ? ' sel' : ''}" data-i="${i}">${ic(c.icon)}<span>${esc(c.label)}</span>${c.hint ? `<small>${esc(c.hint)}</small>` : ''}</button>`).join('')
    : '<div class="pal-empty">No matching commands</div>';
  const el = $('palList').querySelector('.sel');
  if (el) el.scrollIntoView({ block: 'nearest' });
}
function palOpen() { $('palIn').value = ''; pal.sel = 0; palPaint(); $('mPal').classList.add('on'); setTimeout(() => $('palIn').focus(), 60); }
function palClose() { $('mPal').classList.remove('on'); }
function palRun(i) { const c = pal.items[i]; if (!c) return; palClose(); setTimeout(c.run, 80); }
$('btnPalette').onclick = palOpen;
$('palIn').addEventListener('input', () => { pal.sel = 0; palPaint(); });
$('palIn').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); pal.sel = (pal.sel + 1) % Math.max(1, pal.items.length); palPaint(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pal.sel = (pal.sel - 1 + pal.items.length) % Math.max(1, pal.items.length); palPaint(); }
  else if (e.key === 'Enter') { e.preventDefault(); palRun(pal.sel); }
  else if (e.key === 'Escape') palClose();
});
$('palList').addEventListener('click', (e) => { const b = e.target.closest('.pi'); if (b) palRun(Number(b.dataset.i)); });
$('palList').addEventListener('mousemove', (e) => { const b = e.target.closest('.pi'); if (b && Number(b.dataset.i) !== pal.sel) { pal.sel = Number(b.dataset.i); palPaint(); } });
$('mPal').addEventListener('mousedown', (e) => { if (e.target === $('mPal')) palClose(); });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if ($('mPal').classList.contains('on')) palClose();
    else if (!document.querySelector('.modal.on')) palOpen();
  }
});

// click ripple
document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest && e.target.closest('button.b,.qa,.link-card,.tab,.seg button,.kbtn');
  if (!b || b.disabled) return;
  const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2;
  const sp = document.createElement('span');
  sp.className = 'rip';
  sp.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
  b.appendChild(sp);
  setTimeout(() => sp.remove(), 650);
}, { passive: true });
// no point animating a window nobody can see
const root = document.documentElement;
const syncMotion = () => { root.classList.toggle('paused', document.hidden); root.classList.toggle('idle', !document.hasFocus()); };
document.addEventListener('visibilitychange', syncMotion);
window.addEventListener('blur', syncMotion);
window.addEventListener('focus', syncMotion);
syncMotion();

window.yconnect.onLatency((id, l) => { if (l) lat.data.set(id, l); paintLat(id); });
window.yconnect.onUpdate(render);
window.yconnect.getState().then(render);
