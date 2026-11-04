// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
// Reads this computer's battery: { level: 0-100, charging: bool }, or null when there is no battery (desktop PC).
// Linux: /sys/class/power_supply. Windows: Win32_Battery through PowerShell (one short call a minute).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function linux() {
  const base = '/sys/class/power_supply';
  try {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d);
      try {
        if (fs.readFileSync(path.join(p, 'type'), 'utf8').trim() !== 'Battery') continue;
        // skip batteries of peripherals (wireless mouse, headset ...)
        try { if (fs.readFileSync(path.join(p, 'scope'), 'utf8').trim() === 'Device') continue; } catch {}
        const level = parseInt(fs.readFileSync(path.join(p, 'capacity'), 'utf8'), 10);
        const status = fs.readFileSync(path.join(p, 'status'), 'utf8').trim();
        if (Number.isFinite(level)) return { level: Math.max(0, Math.min(100, level)), charging: status === 'Charging' };
      } catch {}
    }
  } catch {}
  return null;
}

function windows() {
  return new Promise((resolve) => {
    const cmd = '$b = Get-CimInstance Win32_Battery | Select-Object -First 1; if ($b) { "$($b.EstimatedChargeRemaining) $($b.BatteryStatus)" }';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 10000 }, (err, out) => {
      const m = !err && /^(\d{1,3})\s+(\d+)/.exec(String(out).trim());
      if (!m) return resolve(null);
      // BatteryStatus: 1 discharging, 2 on AC, 3 full, 4 low, 5 critical, 6-9 charging, 10 undefined, 11 partially charged
      resolve({ level: Math.min(100, Number(m[1])), charging: [2, 6, 7, 8, 9].includes(Number(m[2])) });
    });
  });
}

async function read() {
  if (process.platform === 'linux') return linux();
  if (process.platform === 'win32') return windows();
  return null;
}
module.exports = { read };
