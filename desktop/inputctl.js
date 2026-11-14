// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
/*
 * Remote control of THIS computer while it shares its screen: turns the events a viewer sends (screen-input) into
 * real mouse and keyboard input.
 *
 *   Windows        a hidden PowerShell that calls SendInput (nothing to install)
 *   Linux, X11     xdotool
 *   Linux Wayland  ydotool (needs its ydotoold daemon running); xdotool is the fallback for XWayland windows
 *
 * Event format (all coordinates are 0..1 of the shared picture, so resolution and scaling never matter):
 *   { k:'move', x, y }                         pointer moved
 *   { k:'down'|'up', x, y, b }                 b: 0 = left button, 2 = right button
 *   { k:'wheel', x, y, dx, dy }                scroll notches, dy > 0 = down
 *   { k:'key', code, d }                       a key went down (d: true) or up (d: false); code = KeyboardEvent.code
 *   { k:'text', s }                            type this text (phone keyboard)
 *   { k:'release' }                           let go of every key still held
 *   { k:'nav', a }                             back | home | recents - meant for phones, ignored here
 * Everything is validated first; unknown or malformed events are dropped.
 */
const { execFile, spawn } = require('child_process');

const MAX_TEXT = 256;
const MAX_NOTCH = 20;
const MAX_QUEUE = 200;

/* ---------- key tables, indexed by KeyboardEvent.code ---------- */
const T = {}; // code -> { sym: xdotool keysym, ev: linux evdev code, vk: windows virtual key, ext: windows extended key }
const add = (code, sym, ev, vk, ext) => { T[code] = { sym, ev, vk, ext: !!ext }; };
'qwertyuiop'.split('').forEach((c, i) => add('Key' + c.toUpperCase(), c, 16 + i, c.toUpperCase().charCodeAt(0)));
'asdfghjkl'.split('').forEach((c, i) => add('Key' + c.toUpperCase(), c, 30 + i, c.toUpperCase().charCodeAt(0)));
'zxcvbnm'.split('').forEach((c, i) => add('Key' + c.toUpperCase(), c, 44 + i, c.toUpperCase().charCodeAt(0)));
'1234567890'.split('').forEach((c, i) => add('Digit' + c, c, 2 + i, 0x30 + Number(c)));
for (let i = 1; i <= 10; i++) add('F' + i, 'F' + i, 58 + i, 0x6f + i);
add('F11', 'F11', 87, 0x7a); add('F12', 'F12', 88, 0x7b);
[
  ['Escape', 'Escape', 1, 0x1b], ['Minus', 'minus', 12, 0xbd], ['Equal', 'equal', 13, 0xbb], ['Backspace', 'BackSpace', 14, 0x08],
  ['Tab', 'Tab', 15, 0x09], ['BracketLeft', 'bracketleft', 26, 0xdb], ['BracketRight', 'bracketright', 27, 0xdd], ['Enter', 'Return', 28, 0x0d],
  ['ControlLeft', 'Control_L', 29, 0xa2], ['Semicolon', 'semicolon', 39, 0xba], ['Quote', 'apostrophe', 40, 0xde], ['Backquote', 'grave', 41, 0xc0],
  ['ShiftLeft', 'Shift_L', 42, 0xa0], ['Backslash', 'backslash', 43, 0xdc], ['Comma', 'comma', 51, 0xbc], ['Period', 'period', 52, 0xbe],
  ['Slash', 'slash', 53, 0xbf], ['ShiftRight', 'Shift_R', 54, 0xa1], ['AltLeft', 'Alt_L', 56, 0xa4], ['Space', 'space', 57, 0x20],
  ['CapsLock', 'Caps_Lock', 58, 0x14], ['MetaLeft', 'Super_L', 125, 0x5b], ['MetaRight', 'Super_R', 126, 0x5c],
].forEach(([c, s, e, v]) => add(c, s, e, v));
[
  ['ControlRight', 'Control_R', 97, 0xa3], ['AltRight', 'Alt_R', 100, 0xa5], ['Home', 'Home', 102, 0x24], ['ArrowUp', 'Up', 103, 0x26],
  ['PageUp', 'Prior', 104, 0x21], ['ArrowLeft', 'Left', 105, 0x25], ['ArrowRight', 'Right', 106, 0x27], ['End', 'End', 107, 0x23],
  ['ArrowDown', 'Down', 108, 0x28], ['PageDown', 'Next', 109, 0x22], ['Insert', 'Insert', 110, 0x2d], ['Delete', 'Delete', 111, 0x2e],
].forEach(([c, s, e, v]) => add(c, s, e, v, true));
const KNOWN = new Set(Object.keys(T));

/* ---------- validation ---------- */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const c01 = (v) => Math.min(1, Math.max(0, v));

/** Returns a clean event or null. Nothing a viewer sends reaches the system without passing through here. */
function sanitize(m) {
  if (!m || typeof m !== 'object') return null;
  switch (m.k) {
    case 'move': case 'down': case 'up': case 'wheel': {
      const x = num(m.x), y = num(m.y);
      if (x === null || y === null) return null;
      const e = { k: m.k, x: c01(x), y: c01(y) };
      if (m.k === 'down' || m.k === 'up') e.b = m.b === 2 ? 2 : 0;
      if (m.k === 'wheel') {
        const dx = num(m.dx) || 0, dy = num(m.dy) || 0;
        e.dx = Math.max(-MAX_NOTCH, Math.min(MAX_NOTCH, Math.round(dx)));
        e.dy = Math.max(-MAX_NOTCH, Math.min(MAX_NOTCH, Math.round(dy)));
        if (!e.dx && !e.dy) return null;
      }
      return e;
    }
    case 'key':
      if (typeof m.code !== 'string' || !KNOWN.has(m.code)) return null;
      return { k: 'key', code: m.code, d: m.d === true };
    case 'text': {
      if (typeof m.s !== 'string') return null;
      const s = m.s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, MAX_TEXT);
      return s ? { k: 'text', s } : null;
    }
    case 'release': return { k: 'release' };
    case 'nav': return ['back', 'home', 'recents'].includes(m.a) ? { k: 'nav', a: m.a } : null;
    default: return null;
  }
}

/* ---------- translating an event for each tool ---------- */
const BTN_X = { 0: '1', 2: '3' };
const pxOf = (e, g) => [Math.round((g.x + e.x * g.width) * g.scale), Math.round((g.y + e.y * g.height) * g.scale)];

/** xdotool command lines (each an argument list). g = { x, y, width, height, scale } of the shared display. */
function xdotoolJobs(e, g) {
  switch (e.k) {
    case 'move': { const [px, py] = pxOf(e, g); return [['mousemove', px, py]]; }
    case 'down': { const [px, py] = pxOf(e, g); return [['mousemove', px, py, 'mousedown', BTN_X[e.b]]]; }
    case 'up': { const [px, py] = pxOf(e, g); return [['mousemove', px, py, 'mouseup', BTN_X[e.b]]]; }
    case 'wheel': {
      const [px, py] = pxOf(e, g);
      const out = [['mousemove', px, py]];
      if (e.dy) out.push(['click', '--repeat', String(Math.abs(e.dy)), e.dy > 0 ? '5' : '4']);
      if (e.dx) out.push(['click', '--repeat', String(Math.abs(e.dx)), e.dx > 0 ? '7' : '6']);
      return out;
    }
    case 'key': return [[e.d ? 'keydown' : 'keyup', T[e.code].sym]];
    case 'text': return [['type', '--delay', '4', '--', e.s]];
    default: return [];
  }
}
/** ydotool command lines. */
function ydotoolJobs(e, g) {
  const abs = (x, y) => ['mousemove', '--absolute', '-x', String(x), '-y', String(y)];
  switch (e.k) {
    case 'move': return [abs(...pxOf(e, g))];
    case 'down': return [abs(...pxOf(e, g)), ['click', e.b === 2 ? '0x41' : '0x40']];
    case 'up': return [abs(...pxOf(e, g)), ['click', e.b === 2 ? '0x81' : '0x80']];
    case 'wheel': return [abs(...pxOf(e, g)), ['mousemove', '--wheel', '-x', String(e.dx), '-y', String(-e.dy)]];
    case 'key': return [['key', `${T[e.code].ev}:${e.d ? 1 : 0}`]];
    case 'text': return [['type', '--', e.s]];
    default: return [];
  }
}
/** Lines for the Windows helper (see WIN_SCRIPT). Coordinates are sent as 0..1 and mapped by SendInput itself. */
function winLines(e) {
  const f = (v) => v.toFixed(5);
  switch (e.k) {
    case 'move': return [`m ${f(e.x)} ${f(e.y)}`];
    case 'down': return [`m ${f(e.x)} ${f(e.y)}`, `d ${e.b}`];
    case 'up': return [`m ${f(e.x)} ${f(e.y)}`, `u ${e.b}`];
    case 'wheel': return [`m ${f(e.x)} ${f(e.y)}`, ...(e.dy ? [`w ${-e.dy}`] : []), ...(e.dx ? [`h ${e.dx}`] : [])];
    case 'key': return [`k ${T[e.code].vk} ${e.d ? 1 : 0} ${T[e.code].ext ? 1 : 0}`];
    case 'text': return [`t ${Buffer.from(e.s, 'utf8').toString('base64')}`];
    default: return [];
  }
}

const WIN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class YC {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct U { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public U u; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] i, int size);
  static void Send(INPUT i) { SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  static void Mouse(uint flags, int dx, int dy, uint data) {
    INPUT i = new INPUT(); i.type = 0; i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags; Send(i);
  }
  static void Key(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; Send(i);
  }
  public static void Do(string line) {
    string[] p = line.Split(' ');
    switch (p[0]) {
      case "m": Mouse(0x8001, (int)(double.Parse(p[1], System.Globalization.CultureInfo.InvariantCulture) * 65535), (int)(double.Parse(p[2], System.Globalization.CultureInfo.InvariantCulture) * 65535), 0); break;
      case "d": Mouse(p[1] == "2" ? 0x8u : 0x2u, 0, 0, 0); break;
      case "u": Mouse(p[1] == "2" ? 0x10u : 0x4u, 0, 0, 0); break;
      case "w": Mouse(0x800, 0, 0, (uint)(int.Parse(p[1]) * 120)); break;
      case "h": Mouse(0x1000, 0, 0, (uint)(int.Parse(p[1]) * 120)); break;
      case "k": Key(ushort.Parse(p[1]), 0, (p[2] == "1" ? 0u : 2u) | (p[3] == "1" ? 1u : 0u)); break;
      case "t":
        foreach (char c in Encoding.UTF8.GetString(Convert.FromBase64String(p[1]))) { Key(0, (ushort)c, 4); Key(0, (ushort)c, 6); }
        break;
    }
  }
}
"@
while (($l = [Console]::In.ReadLine()) -ne $null) { try { [YC]::Do($l) } catch { } }
`;

/* ---------- the controller ---------- */
function which(cmd, env = process.env) {
  const fs = require('fs'), path = require('path');
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try { fs.accessSync(path.join(dir, cmd), fs.constants.X_OK); return true; } catch {}
  }
  return false;
}

/**
 * opts: { platform, env, getGeometry() -> {x,y,width,height,scale}, has(cmd), run(cmd,args,cb), startHelper(cmd,args) }
 * (the last three exist so tests can run without real tools)
 */
function createController(opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const has = opts.has || ((c) => which(c, env));
  const run = opts.run || ((cmd, args, cb) => execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err) => cb(err)));
  const startHelper = opts.startHelper || ((cmd, args) => spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }));
  const geo = opts.getGeometry || (() => ({ x: 0, y: 0, width: 1920, height: 1080, scale: 1 }));
  const pressed = new Set();
  let tool = null, helper = null, queue = [], busy = false, failed = false;

  function detect() {
    if (platform === 'win32') return { ok: true, tool: 'sendinput' };
    if (platform === 'linux') {
      const wayland = env.XDG_SESSION_TYPE === 'wayland' || (!!env.WAYLAND_DISPLAY && env.XDG_SESSION_TYPE !== 'x11');
      const order = wayland ? ['ydotool', 'xdotool'] : ['xdotool', 'ydotool'];
      const t = order.find(has);
      if (t) return { ok: true, tool: t };
      return {
        ok: false,
        hint: wayland
          ? 'Remote control on Wayland needs ydotool (install it and start the ydotoold service).'
          : 'Remote control needs xdotool (install the xdotool package).',
      };
    }
    return { ok: false, hint: 'Remote control is only available on Linux and Windows.' };
  }
  const available = () => { const d = detect(); if (d.ok) tool = d.tool; return d; };

  function ensureHelper() {
    if (helper && !helper.killed && helper.exitCode === null) return helper;
    const enc = Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64');
    helper = startHelper('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc]);
    if (helper.on) { helper.on('error', () => { failed = true; helper = null; }); helper.on('exit', () => { helper = null; }); }
    if (helper.stdin && helper.stdin.on) helper.stdin.on('error', () => {});
    return helper;
  }
  function pump() {
    if (busy) return;
    const job = queue.shift();
    if (!job) return;
    busy = true;
    let args = job.args;
    // xdotool can chain commands ("mousemove 1 2 mousedown 1 keydown a"): everything that piled up while the last process
    // was starting goes into ONE process, because starting a process per event is what makes control feel laggy
    if (job.cmd === 'xdotool' && job.args[0] !== 'type') {
      args = job.args.slice();
      while (queue.length && queue[0].cmd === 'xdotool' && queue[0].args[0] !== 'type' && args.length < 400) args.push(...queue.shift().args);
    }
    run(job.cmd, args, () => { busy = false; pump(); });
  }
  function enqueue(cmd, args, isMove) {
    if (isMove && queue.length && queue[queue.length - 1].move) queue.pop();     // only the newest pointer position matters
    if (queue.length >= MAX_QUEUE) { const i = queue.findIndex((j) => j.move); queue.splice(i >= 0 ? i : 0, 1); }
    queue.push({ cmd, args, move: isMove });
    pump();
  }

  function handle(raw) {
    const e = sanitize(raw);
    if (e && e.k === 'release') { releaseAll(); return true; }
    if (!e || e.k === 'nav') return false;
    if (!tool && !available().ok) return false;
    if (e.k === 'key') { if (e.d) pressed.add(e.code); else pressed.delete(e.code); }
    if (tool === 'sendinput') {
      const h = ensureHelper();
      if (failed || !h || !h.stdin || !h.stdin.writable) return false;
      for (const l of winLines(e)) h.stdin.write(l + '\n');
      return true;
    }
    const jobs = tool === 'ydotool' ? ydotoolJobs(e, geo()) : xdotoolJobs(e, geo());
    jobs.forEach((a, i) => enqueue(tool, a, e.k === 'move' && i === 0));
    return true;
  }
  /** Lets go of every key the viewer still holds down (sharing stopped, connection lost, control revoked). */
  function releaseAll() {
    for (const code of [...pressed]) handle({ k: 'key', code, d: false });
    pressed.clear();
  }
  function close() {
    releaseAll();
    queue = [];
    if (helper) { try { helper.stdin.end(); helper.kill(); } catch {} helper = null; }
  }
  return { available, handle, releaseAll, close, _queue: () => queue };
}

module.exports = { sanitize, xdotoolJobs, ydotoolJobs, winLines, createController, KEYS: T, WIN_SCRIPT, MAX_TEXT };
