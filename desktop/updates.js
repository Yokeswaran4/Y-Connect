// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
// "Check for updates": asks GitHub for the latest published release and compares it with this version.
// This is the only feature that uses the internet, so it is manual by default and the daily check is opt-in.
// It sends nothing about you or your devices (one plain GET of the public "latest release" page).
const API = 'https://api.github.com/repos/Yokeswaran4/Y-Connect/releases/latest';
const PAGE = 'https://github.com/Yokeswaran4/Y-Connect/releases';
// only links to this project's releases are ever opened from an update notice
const SAFE_URL = /^https:\/\/github\.com\/Yokeswaran4\/Y-Connect\/releases(\/[\w.\-/%]*)?$/;

/** "v1.2.0-beta" -> [1, 2, 0]. Anything that is not a number is ignored. */
function parts(v) {
  return String(v || '').trim().replace(/^v/i, '').split(/[-+]/)[0].split('.').map((x) => parseInt(String(x).replace(/\D/g, ''), 10) || 0);
}
function isNewer(latest, current) {
  const a = parts(latest), b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * @param {string} current  this app's version, e.g. "v1.1"
 * @param {(url: string, opts: object) => Promise<Response>} fetchFn  Electron's net.fetch (or any fetch)
 * @returns {Promise<{ok: boolean, current: string, latest?: string, newer?: boolean, url?: string, notes?: string, error?: string}>}
 */
async function check(current, fetchFn) {
  try {
    const res = await fetchFn(API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Y-Connect-Desktop/' + current },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return { ok: true, current, latest: current, newer: false }; // no release published yet
    if (res.status === 403 || res.status === 429) return { ok: false, current, error: 'GitHub is limiting requests right now. Try again later.' };
    if (!res.ok) return { ok: false, current, error: 'GitHub answered with error ' + res.status + '.' };
    const o = await res.json();
    const latest = String(o.tag_name || o.name || '');
    if (!latest) return { ok: false, current, error: 'The release has no version number.' };
    const newer = isNewer(latest, current);
    const url = SAFE_URL.test(String(o.html_url || '')) ? o.html_url : PAGE;
    return { ok: true, current, latest, newer, url, notes: String(o.body || '').trim().slice(0, 600) };
  } catch {
    return { ok: false, current, error: 'Couldn’t reach GitHub. Check your internet connection.' };
  }
}

module.exports = { check, isNewer, parts, SAFE_URL, PAGE };
