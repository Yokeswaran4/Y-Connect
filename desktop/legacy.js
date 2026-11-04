// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
// This app was released under a different name. Menu entries, startup entries and icons that the old app wrote
// stay behind after an update, so docks and launchers keep showing the old name and icon.
// This removes only the files the old app itself created in the user's own folders, then refreshes the icon caches.
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const isOld = (s) => String(s).replace(/[\s_-]/g, '').toLowerCase().includes('mikuconnect');

function removeOldDesktopEntries(dir) {
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const f of names) {
    if (!f.endsWith('.desktop')) continue;
    const file = path.join(dir, f);
    try {
      const txt = fs.readFileSync(file, 'utf8');
      const nm = /^Name=(.*)$/m.exec(txt);
      if (isOld(f) || (nm && isOld(nm[1]))) { fs.unlinkSync(file); removed++; }
    } catch {}
  }
  return removed;
}

function removeOldIcons(iconRoot) {
  let removed = 0;
  let sizes = [];
  try { sizes = fs.readdirSync(iconRoot); } catch { return 0; }
  for (const sz of sizes) {
    const d = path.join(iconRoot, sz, 'apps');
    let files = [];
    try { files = fs.readdirSync(d); } catch { continue; }
    for (const f of files) { if (isOld(f)) { try { fs.unlinkSync(path.join(d, f)); removed++; } catch {} } }
  }
  return removed;
}

/** Linux: remove old menu / autostart entries and icons. Returns how many files were removed. */
function cleanLinux() {
  const home = os.homedir();
  const data = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const conf = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  let n = 0;
  n += removeOldDesktopEntries(path.join(data, 'applications'));
  n += removeOldDesktopEntries(path.join(conf, 'autostart'));
  n += removeOldIcons(path.join(data, 'icons', 'hicolor'));
  return n;
}

/** Ask the desktop to forget cached icons and menu entries (best effort; each tool may be missing). */
function refreshCaches() {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const run = (cmd, args) => { try { execFile(cmd, args, { timeout: 15000 }, () => {}); } catch {} };
  run('update-desktop-database', [path.join(data, 'applications')]);
  run('gtk-update-icon-cache', ['-f', '-t', path.join(data, 'icons', 'hicolor')]);
}

/** Windows: remove a launch-on-startup entry that the old app registered. */
function cleanWindows() {
  for (const name of ['Miku Connect', 'MikuConnect', 'com.yokeswaran.mikuconnect']) {
    try { app.setLoginItemSettings({ openAtLogin: false, name }); } catch {}
  }
}

/** Run once per start; returns the number of leftover files removed. */
function run() {
  let n = 0;
  try {
    if (process.platform === 'linux') n = cleanLinux();
    else if (process.platform === 'win32') cleanWindows();
  } catch {}
  if (n > 0) refreshCaches();
  return n;
}

module.exports = { run, refreshCaches };
