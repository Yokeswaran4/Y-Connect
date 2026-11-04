// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
// "Launch on startup" for Windows and Linux. By default the app starts hidden in the tray (--hidden);
// the user can choose to show the window at login instead.
//  Windows: Electron's login item (registry Run key). Linux: an XDG autostart entry (~/.config/autostart).
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const supported = process.platform === 'win32' || process.platform === 'linux';

/** What to launch at login: portable .exe / AppImage / installed app / dev checkout. */
function target(hidden = true) {
  const flag = hidden ? ['--hidden'] : [];
  if (process.env.PORTABLE_EXECUTABLE_FILE) return { path: process.env.PORTABLE_EXECUTABLE_FILE, args: flag }; // Windows portable build
  if (process.platform === 'linux' && process.env.APPIMAGE) return { path: process.env.APPIMAGE, args: flag };
  if (app.isPackaged) return { path: process.execPath, args: flag };
  return { path: process.execPath, args: [app.getAppPath(), ...flag] };
}
const desktopFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'y-connect.desktop');
const quote = (s) => '"' + String(s).replace(/(["`$\\])/g, '\\$1') + '"'; // .desktop Exec quoting

function isEnabled() {
  try {
    if (process.platform === 'win32') {
      // the entry may have been saved with or without --hidden: either one counts as enabled
      return [true, false].some((h) => {
        const t = target(h);
        const s = app.getLoginItemSettings({ path: t.path, args: t.args });
        return !!s.openAtLogin && s.executableWillLaunchAtLogin !== false;
      });
    }
    if (process.platform === 'linux') {
      const f = desktopFile();
      return fs.existsSync(f) && !/^Hidden=true$/mi.test(fs.readFileSync(f, 'utf8'));
    }
  } catch {}
  return false;
}

/** `hidden`: start in the tray (true) or show the window (false). Returns { ok: true } or { ok: false, why, fix }. */
function set(on, hidden = true) {
  const t = target(hidden);
  try {
    if (process.platform === 'win32') {
      // drop an entry saved with the other mode first, so only one startup entry remains
      for (const h of [true, false]) { const o = target(h); app.setLoginItemSettings({ openAtLogin: false, path: o.path, args: o.args }); }
      if (on) app.setLoginItemSettings({ openAtLogin: true, path: t.path, args: t.args });
      if (on) {
        const s = app.getLoginItemSettings({ path: t.path, args: t.args });
        if (!s.openAtLogin) return { ok: false, why: 'Windows did not accept the startup entry (security software or a company policy may block it).', fix: 'Add Y Connect in Settings > Apps > Startup yourself, or allow it in your security software and try again.' };
        if (s.executableWillLaunchAtLogin === false) return { ok: false, why: 'Startup for Y Connect is switched off in Windows (Task Manager > Startup apps), which overrides this setting.', fix: 'Open Task Manager > Startup apps, right-click Y Connect and choose Enable, then turn this on again.' };
      }
      return { ok: true };
    }
    if (process.platform === 'linux') {
      const f = desktopFile();
      if (!on) { try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; } return { ok: true }; }
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const exec = [t.path, ...t.args].map(quote).join(' ');
      fs.writeFileSync(f, ['[Desktop Entry]', 'Type=Application', 'Name=Y Connect', 'Comment=Notifications, clipboard and files between your devices',
        'Exec=' + exec, 'Terminal=false', 'X-GNOME-Autostart-enabled=true', 'StartupNotify=false', ''].join('\n'));
      return { ok: true };
    }
  } catch (e) {
    const c = e && e.code;
    if (c === 'EACCES' || c === 'EPERM') return { ok: false, why: `Not allowed to write the startup entry (${process.platform === 'linux' ? desktopFile() : 'registry'}).`, fix: process.platform === 'linux' ? 'Make ~/.config/autostart writable for your user: chmod u+w ~/.config ~/.config/autostart' : 'Run Y Connect as your normal user and check that security software is not blocking it.' };
    if (c === 'EROFS') return { ok: false, why: 'The folder for startup entries is read-only.', fix: 'Remount your home folder writable, or add Y Connect to your desktop\'s startup apps yourself.' };
    if (c === 'ENOSPC') return { ok: false, why: 'The disk is full, so the startup entry could not be saved.', fix: 'Free some disk space and try again.' };
    return { ok: false, why: 'The startup entry could not be changed: ' + ((e && e.message) || 'unknown error') + '.', fix: 'Try again; if it keeps failing, add Y Connect to your system\'s startup apps manually.' };
  }
  return { ok: false, why: 'Launch on startup is only available on Windows and Linux.', fix: 'Start Y Connect manually on this system.' };
}
module.exports = { supported, isEnabled, set };
