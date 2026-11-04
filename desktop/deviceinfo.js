// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
// "About this device" for Windows and Linux: hardware model, CPU, OS and desktop / window manager.
// Used by the Settings page and the debug report. It never includes the computer name, IP addresses,
// serial numbers or the pairing code, and the report hides clipboard / notification text from the activity log.
const { app, screen, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

/** Runs a small system command; resolves '' on any failure or after the timeout. */
const run = (cmd, args, timeout = 2000) => new Promise((resolve) => {
  try { execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, out) => resolve(err ? '' : String(out))); } catch { resolve(''); }
});
const read = (f) => { try { return fs.readFileSync(f, 'utf8').replace(/\0/g, '').trim(); } catch { return ''; } };
const JUNK = /^(to be filled by o\.?e\.?m\.?|default string|system product name|system manufacturer|system version|not specified|not applicable|none|unknown|o\.e\.m\.?|n\/a)$/i;
const clean = (s) => { s = String(s || '').trim(); return s && !JUNK.test(s) ? s : ''; };
const join = (...p) => p.filter(Boolean).join(' ');
const gb = (b) => (b / 1024 ** 3).toFixed(b >= 10 * 1024 ** 3 ? 0 : 1) + ' GB';
const rows = (title, list) => ({ title, rows: list.filter(([, v]) => v !== '' && v != null) });

function cpuInfo() {
  const cpus = os.cpus() || [];
  let model = (cpus[0] && cpus[0].model || '').replace(/\s+/g, ' ').trim();
  if ((!model || /^unknown$/i.test(model)) && process.platform === 'linux') {
    const t = read('/proc/cpuinfo');
    const m = /^(?:model name|Hardware|Model)\s*:\s*(.+)$/im.exec(t);
    if (m) model = m[1].trim();
  }
  const mhz = cpus[0] && cpus[0].speed ? ` @ ${(cpus[0].speed / 1000).toFixed(2)} GHz` : '';
  return (model || 'Unknown') + mhz + (cpus.length ? ` · ${cpus.length} threads` : '');
}

function displays() {
  try {
    return screen.getAllDisplays().map((d, i) => `${d.size.width}×${d.size.height} @ ${d.scaleFactor}x${i === 0 ? ' (primary)' : ''}`).join(', ');
  } catch { return ''; }
}

function packaging() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return 'Portable .exe';
  if (process.env.APPIMAGE) return 'AppImage';
  return app.isPackaged ? 'Installed' : 'Development checkout';
}

/** Parses the output of `reg query` into { ValueName: data }. */
function regValues(out) {
  const m = {};
  for (const line of out.split(/\r?\n/)) {
    const x = /^\s{2,}(\S+)\s+REG_\w+\s*(.*)$/.exec(line);
    if (x) m[x[1]] = x[2].trim();
  }
  return m;
}

async function windowsInfo() {
  const [biosOut, cvOut] = await Promise.all([
    run('reg', ['query', 'HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS']),
    run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion']),
  ]);
  const bios = regValues(biosOut), cv = regValues(cvOut);
  const build = parseInt(cv.CurrentBuild || String(os.release()).split('.')[2], 10) || 0;
  const ubr = cv.UBR ? parseInt(cv.UBR, 10) : NaN;
  const winName = /server/i.test(cv.ProductName || '') ? cv.ProductName : (build >= 22000 ? 'Windows 11' : (cv.ProductName || 'Windows'));
  const maker = clean(bios.SystemManufacturer), prod = clean(bios.SystemProductName), fam = clean(bios.SystemFamily);
  const model = prod && maker && prod.toLowerCase().startsWith(maker.toLowerCase()) ? prod : join(maker, prod);
  return {
    model: model || 'Not reported by this system',
    modelExtra: fam && fam !== prod ? fam : '',
    os: join(winName, cv.DisplayVersion || cv.ReleaseId || '') + (build ? ` (build ${build}${Number.isNaN(ubr) ? '' : '.' + ubr})` : ''),
    kernel: 'Windows NT ' + os.release(),
    desktop: 'Windows shell (Explorer)',
    windowManager: 'Desktop Window Manager (DWM)',
    session: '',
    virt: '',
  };
}

async function linuxInfo() {
  const env = process.env;
  const rel = read('/etc/os-release');
  const pretty = (/^PRETTY_NAME="?([^"\n]+)"?/m.exec(rel) || [])[1] || (/^NAME="?([^"\n]+)"?/m.exec(rel) || [])[1] || 'Linux';
  const dmi = (f) => clean(read('/sys/class/dmi/id/' + f));
  const vendor = dmi('sys_vendor'), prod = dmi('product_name'), ver = dmi('product_version');
  let model = prod && vendor && prod.toLowerCase().startsWith(vendor.toLowerCase()) ? prod : join(vendor, prod);
  if (ver && !model.includes(ver)) model += ` (${ver})`;
  if (!model) model = clean(read('/proc/device-tree/model')) || clean(read('/sys/firmware/devicetree/base/model'));

  const desktop = env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || '';
  const session = env.XDG_SESSION_TYPE || (env.WAYLAND_DISPLAY ? 'wayland' : env.DISPLAY ? 'x11' : '');

  // the window manager announces itself on X11 / XWayland; on a pure Wayland session the compositor is the desktop itself
  let wm = '';
  if (env.DISPLAY) {
    const root = await run('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], 1500);
    const id = (/#\s*(0x[0-9a-f]+)/i.exec(root) || [])[1];
    if (id) wm = ((/"(.*)"/.exec(await run('xprop', ['-id', id, '_NET_WM_NAME'], 1500)) || [])[1] || '').trim();
    if (!wm) wm = ((/^Name:\s*(.+)$/m.exec(await run('wmctrl', ['-m'], 1500)) || [])[1] || '').trim();
  }
  if (!wm && session === 'wayland' && desktop) wm = desktop + ' compositor (Wayland)';

  const virtOut = (await run('systemd-detect-virt', [], 1500)).trim();
  return {
    model: model || 'Not reported by this system',
    modelExtra: '',
    os: pretty,
    kernel: 'Linux ' + os.release(),
    desktop: desktop || 'Not detected',
    windowManager: wm || 'Not detected',
    session: session || 'Unknown',
    virt: virtOut && virtOut !== 'none' ? virtOut : '',
  };
}

/**
 * Gathers the device info. `extra` = { label, startup: { enabled, hidden }, tray, battery } from the main process.
 * Returns { sections, summary, brief }: `sections` = [{ title, rows: [[label, value]] }] for the debug report,
 * `summary` = one line for the Activity log, `brief` = the few [label, value] rows the Settings page shows.
 */
async function collect(extra = {}) {
  const d = process.platform === 'win32' ? await windowsInfo() : await linuxInfo();
  const startup = extra.startup || {};
  const sections = [
    rows('App', [
      ['Version', join(app.getVersion(), extra.label ? `(${extra.label})` : '')],
      ['Packaging', packaging()],
      ['Electron / Chromium / Node', `${process.versions.electron} / ${process.versions.chrome} / ${process.versions.node}`],
      ['Launch on startup', startup.enabled ? (startup.hidden ? 'On, starts hidden in the tray' : 'On, shows the window') : 'Off'],
      ['System tray', extra.tray ? 'Available' : 'Not available'],
    ]),
    rows('Hardware', [
      ['Model', d.model],
      ['Product family', d.modelExtra],
      ['CPU', cpuInfo()],
      ['Architecture', process.arch],
      ['Memory', gb(os.totalmem())],
      ['Battery', extra.battery ? 'Present' : 'None detected'],
      ['Virtual machine', d.virt],
    ]),
    rows('System', [
      ['Operating system', d.os],
      ['Kernel', d.kernel],
      ['Desktop environment', d.desktop],
      ['Window manager', d.windowManager],
      ['Session type', d.session],
      ['Displays', displays()],
      ['Color mode', nativeTheme.shouldUseDarkColors ? 'Dark' : 'Light'],
      ['Language', (app.getLocale && app.getLocale()) || ''],
    ]),
  ];
  const summary = [d.model.startsWith('Not reported') ? '' : d.model, d.os, cpuInfo().replace(/ @ .*| · \d+ threads/g, ''), join(d.desktop === 'Not detected' ? '' : d.desktop, d.session && d.session !== 'Unknown' ? `(${d.session})` : '')]
    .filter(Boolean).join(' · ');
  // the Settings page only shows these few lines; the long list above goes into the debug report
  const brief = [
    ['Device', d.model.startsWith('Not reported') ? '' : d.model],
    ['System', d.os],
    ['Y Connect', join(app.getVersion(), extra.label ? `(${extra.label})` : '')],
  ].filter(([, v]) => v);
  return { sections, summary, brief };
}

/** Plain-text report for bug reports: the device info plus the recent activity log. */
function toText(info, log = []) {
  const out = ['Y Connect debug report', 'Generated: ' + new Date().toISOString(), ''];
  for (const s of info.sections) {
    out.push('[' + s.title + ']');
    for (const [k, v] of s.rows) out.push(`${k}: ${v}`);
    out.push('');
  }
  out.push('[Recent activity, newest first. Clipboard and notification text and IP addresses are left out]');
  if (!log.length) out.push('(empty)');
  for (const l of log) {
    const hide = l.kind === 'clip' || l.kind === 'notif';
    out.push(`${new Date(l.time).toISOString()} ${l.kind} | ${l.title}${!hide && l.text ? ' | ' + l.text.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, 'x.x.x.x') : ''}${l.count > 1 ? ' x' + l.count : ''}`);
  }
  return out.join('\n') + '\n';
}

module.exports = { collect, toText };
