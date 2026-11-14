// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
/*
 * Controls an Android phone from this computer through ADB (USB or Wi-Fi "Wireless debugging"), while the phone's
 * screen is shown in the viewer window. Nothing here goes through the phone's Y Connect app: the phone owner allows
 * control by pairing the computer in Developer options > Wireless debugging (or by authorising USB debugging).
 *
 * Input goes through the control channel of scrcpy-server (Apache-2.0, bundled in vendor/): real multi-touch,
 * scroll, key and text events with very little delay. It is started with video and audio switched off, so it only
 * injects input. Without video the server uses positions as raw pixels of the current screen, so this module
 * converts the viewer's 0..1 positions to pixels itself.
 *
 *   adb push vendor/scrcpy-server  ->  /data/local/tmp/yc-scrcpy-server.jar
 *   adb forward tcp:<free> localabstract:scrcpy_<scid>
 *   adb shell CLASSPATH=... app_process / com.genymobile.scrcpy.Server <version> scid=<scid> video=false audio=false control=true tunnel_forward=true ...
 *   connect to the forwarded port, read the dummy byte, then write control messages (see the Msg helpers below)
 *
 * Fallback when the server can not be started: plain `adb shell input` (tap / swipe / key / text, one gesture at a
 * time). It is slower and has no live dragging, but works on every phone with debugging on.
 *
 * Event format is the same one inputctl.js documents ({k:'move'|'down'|'up'|'wheel'|'key'|'text'|'nav'|'release'}).
 */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SERVER_VERSION = '3.3.3';
const SERVER_FILE = 'scrcpy-server-v' + SERVER_VERSION;
const REMOTE_JAR = '/data/local/tmp/yc-scrcpy-server.jar';

/* ---------- Android key codes ---------- */
const AK = {
  HOME: 3, BACK: 4, ENTER: 66, DEL: 67, TAB: 61, SPACE: 62, ESC: 111, FORWARD_DEL: 112, MOVE_HOME: 122, MOVE_END: 123,
  PAGE_UP: 92, PAGE_DOWN: 93, DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22, APP_SWITCH: 187, INSERT: 124,
  SHIFT_L: 59, SHIFT_R: 60, CTRL_L: 113, CTRL_R: 114, ALT_L: 57, ALT_R: 58, CAPS: 115,
  MINUS: 69, EQUAL: 70, LBRACKET: 71, RBRACKET: 72, BACKSLASH: 73, SEMICOLON: 74, APOSTROPHE: 75, SLASH: 76, GRAVE: 68, COMMA: 55, PERIOD: 56,
  A: 29, NUM0: 7, F1: 131,
};
/** KeyboardEvent.code -> Android key code. */
function keyOf(code) {
  if (/^Key[A-Z]$/.test(code)) return AK.A + code.charCodeAt(3) - 65;
  if (/^Digit[0-9]$/.test(code)) return AK.NUM0 + Number(code[5]);
  const f = /^F([0-9]{1,2})$/.exec(code);
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 12) return AK.F1 + Number(f[1]) - 1;
  return ({
    Enter: AK.ENTER, NumpadEnter: AK.ENTER, Backspace: AK.DEL, Delete: AK.FORWARD_DEL, Tab: AK.TAB, Space: AK.SPACE, Escape: AK.BACK,
    Home: AK.MOVE_HOME, End: AK.MOVE_END, PageUp: AK.PAGE_UP, PageDown: AK.PAGE_DOWN, Insert: AK.INSERT,
    ArrowUp: AK.DPAD_UP, ArrowDown: AK.DPAD_DOWN, ArrowLeft: AK.DPAD_LEFT, ArrowRight: AK.DPAD_RIGHT,
    ShiftLeft: AK.SHIFT_L, ShiftRight: AK.SHIFT_R, ControlLeft: AK.CTRL_L, ControlRight: AK.CTRL_R, AltLeft: AK.ALT_L, AltRight: AK.ALT_R, CapsLock: AK.CAPS,
    Minus: AK.MINUS, Equal: AK.EQUAL, BracketLeft: AK.LBRACKET, BracketRight: AK.RBRACKET, Backslash: AK.BACKSLASH,
    Semicolon: AK.SEMICOLON, Quote: AK.APOSTROPHE, Slash: AK.SLASH, Backquote: AK.GRAVE, Comma: AK.COMMA, Period: AK.PERIOD,
    MetaLeft: AK.HOME, MetaRight: AK.HOME,
  })[code] || 0;
}
/** Android meta state bits for the modifier keys, so Ctrl+C, Shift+Tab ... reach the phone as combinations. */
const META = { ShiftLeft: 0x41, ShiftRight: 0x81, ControlLeft: 0x3000, ControlRight: 0x5000, AltLeft: 0x12, AltRight: 0x22 };
const NAV_KEY = { back: AK.BACK, home: AK.HOME, recents: AK.APP_SWITCH };

/* ---------- scrcpy control messages ---------- */
const ACTION_DOWN = 0, ACTION_UP = 1, ACTION_MOVE = 2;
const KEY_DOWN = 0, KEY_UP = 1;
const T_KEYCODE = 0, T_TEXT = 1, T_TOUCH = 2, T_SCROLL = 3, T_BACK_OR_SCREEN_ON = 4;
const BUTTON_PRIMARY = 1, BUTTON_SECONDARY = 2;
const POINTER_FINGER = 0xfffffffffffffffen; // scrcpy's "generic finger" pointer id (-2): a touch, not a mouse pointer (-1 would be a mouse)

function i16fixed(v) { return Math.max(-32768, Math.min(32767, Math.round(Math.max(-1, Math.min(1, v)) * 32768))); }
function u16fixed(v) { return Math.min(0xffff, Math.round(Math.max(0, Math.min(1, v)) * 0x10000)); }

const Msg = {
  /** action: 0 down, 1 up, 2 move. x, y are device pixels; w, h the screen size they refer to. */
  touch(action, pointerId, x, y, w, h, pressure, buttons) {
    const b = Buffer.alloc(32);
    b.writeUInt8(T_TOUCH, 0);
    b.writeUInt8(action, 1);
    b.writeBigUInt64BE(BigInt.asUintN(64, BigInt(pointerId)), 2);
    b.writeInt32BE(x, 10); b.writeInt32BE(y, 14); b.writeUInt16BE(w & 0xffff, 18); b.writeUInt16BE(h & 0xffff, 20);
    b.writeUInt16BE(u16fixed(pressure), 22);
    b.writeInt32BE(action === ACTION_UP ? 0 : buttons, 24); // action button
    b.writeInt32BE(action === ACTION_UP ? 0 : buttons, 28); // buttons held
    return b;
  },
  scroll(x, y, w, h, hs, vs) {
    const b = Buffer.alloc(21);
    b.writeUInt8(T_SCROLL, 0);
    b.writeInt32BE(x, 1); b.writeInt32BE(y, 5); b.writeUInt16BE(w & 0xffff, 9); b.writeUInt16BE(h & 0xffff, 11);
    b.writeInt16BE(i16fixed(hs), 13); b.writeInt16BE(i16fixed(vs), 15); // -1..1 = one notch (the server uses it as is)
    b.writeInt32BE(0, 17);
    return b;
  },
  key(action, keycode, repeat = 0, meta = 0) {
    const b = Buffer.alloc(14);
    b.writeUInt8(T_KEYCODE, 0); b.writeUInt8(action, 1);
    b.writeInt32BE(keycode, 2); b.writeInt32BE(repeat, 6); b.writeInt32BE(meta, 10);
    return b;
  },
  text(s) {
    const t = Buffer.from(s, 'utf8').subarray(0, 300);
    const b = Buffer.alloc(5 + t.length);
    b.writeUInt8(T_TEXT, 0); b.writeUInt32BE(t.length, 1); t.copy(b, 5);
    return b;
  },
  backOrScreenOn() { return Buffer.from([T_BACK_OR_SCREEN_ON, KEY_DOWN]); },
};

/* ---------- finding adb ---------- */
const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
function candidates(custom) {
  const out = [];
  if (custom) out.push(custom);
  if (process.env.YCONNECT_ADB) out.push(process.env.YCONNECT_ADB);
  for (const v of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) if (process.env[v]) out.push(path.join(process.env[v], 'platform-tools', exe));
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) if (dir) out.push(path.join(dir, exe));
  const home = os.homedir();
  if (process.platform === 'win32') {
    const la = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    out.push(path.join(la, 'Android', 'Sdk', 'platform-tools', exe), 'C:\\platform-tools\\adb.exe', 'C:\\adb\\adb.exe');
    const pf = process.env.ProgramFiles; if (pf) out.push(path.join(pf, 'scrcpy', exe));
    const lp = process.env.LOCALAPPDATA; if (lp) out.push(path.join(lp, 'Microsoft', 'WinGet', 'Links', exe));
  } else {
    out.push(path.join(home, 'Android', 'Sdk', 'platform-tools', exe), path.join(home, 'platform-tools', exe), '/opt/android-sdk/platform-tools/adb', '/usr/lib/android-sdk/platform-tools/adb', '/usr/bin/adb', '/usr/local/bin/adb');
  }
  return [...new Set(out)];
}
function findAdb(custom) {
  for (const c of candidates(custom)) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
  return null;
}
/** Where the bundled scrcpy-server is: next to this file (dev) or in app.asar.unpacked (packaged). */
function findServerJar(extra) {
  const dirs = [path.join(__dirname, 'vendor'), path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'vendor')];
  if (extra) dirs.unshift(extra);
  for (const d of dirs) { const f = path.join(d, SERVER_FILE); try { if (fs.statSync(f).isFile()) return f; } catch {} }
  return null;
}

/* ---------- running adb ---------- */
function run(adb, args, o = {}) {
  return new Promise((resolve) => {
    execFile(adb, args, { timeout: o.timeout || 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() });
    });
  });
}

/** `adb devices -l` -> [{ serial, state, model }] */
function parseDevices(text) {
  const list = [];
  for (const line of String(text).split(/\r?\n/).slice(1)) {
    const m = /^(\S+)\s+(device|unauthorized|offline|authorizing|no permissions)\b(.*)$/.exec(line.trim());
    if (!m) continue;
    const model = /model:(\S+)/.exec(m[3]);
    list.push({ serial: m[1], state: m[2], model: model ? model[1].replace(/_/g, ' ') : '' });
  }
  return list;
}
/** `adb mdns services` -> [{ name, type: 'connect'|'pair', host, port }] */
function parseMdns(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(\S+)\s+_adb-tls-(connect|pairing)\._tcp\.?\s+(\[?[0-9a-fA-F:.]+\]?):(\d+)\s*$/.exec(line.trim());
    if (m) out.push({ name: m[1], type: m[2] === 'pairing' ? 'pair' : 'connect', host: m[3].replace(/^\[|\]$/g, ''), port: Number(m[4]) });
  }
  return out;
}
const stripV4 = (h) => String(h || '').replace(/^::ffff:/, '');
const hostOf = (serial) => { const m = /^(\[?[0-9a-fA-F:.]+\]?):(\d+)$/.exec(serial); return m ? m[1].replace(/^\[|\]$/g, '') : null; };
const validHostPort = (s) => /^[A-Za-z0-9.\-:[\]]{1,80}:\d{2,5}$/.test(String(s));

/**
 * The adb side: finding the phone, pairing, connecting. `settings()` returns { adbPath }.
 * Every public method resolves to { ok, ... } and never throws.
 */
function createAdb(settings = () => ({}), runner = run) {
  const adb = () => findAdb((settings() || {}).adbPath);
  const NEED = { ok: false, needAdb: true, error: 'adb was not found. Install Android platform-tools (or scrcpy) and make sure "adb" is in your PATH, or set its location in Settings.' };

  async function devices() {
    const a = adb(); if (!a) return NEED;
    await runner(a, ['start-server'], { timeout: 20000 });
    const r = await runner(a, ['devices', '-l']);
    if (!r.ok) return { ok: false, error: 'adb failed: ' + (r.err || r.out) };
    return { ok: true, devices: parseDevices(r.out), adb: a };
  }
  async function mdns() {
    const a = adb(); if (!a) return [];
    const r = await runner(a, ['mdns', 'services'], { timeout: 8000 });
    return r.ok ? parseMdns(r.out) : [];
  }
  /** The usable adb device for the phone at `ip`: already connected by its IP, or the only device. */
  function choose(list, ip) {
    const ready = list.filter((d) => d.state === 'device');
    const byIp = ready.find((d) => hostOf(d.serial) === ip);
    if (byIp) return byIp;
    const usb = ready.filter((d) => !hostOf(d.serial) && !/^adb-.*_adb-tls-connect/.test(d.serial));
    const tls = ready.filter((d) => /_adb-tls-connect/.test(d.serial));
    if (ready.length === 1) return ready[0];
    if (usb.length === 1 && tls.length === 0) return usb[0];
    return null;
  }
  /** Finds or makes an adb connection to the phone at ip. Resolves { ok, serial } or { ok:false, error, needPair?, state? } */
  async function ensure(ip) {
    const d = await devices(); if (!d.ok) return d;
    ip = stripV4(ip);
    const found = choose(d.devices, ip);
    if (found) return { ok: true, serial: found.serial, model: found.model, adb: d.adb };
    const bad = d.devices.find((x) => hostOf(x.serial) === ip && x.state !== 'device');
    if (bad && bad.state === 'unauthorized') return { ok: false, needPair: true, error: 'The phone has not authorised this computer. Accept the "Allow USB debugging" prompt on the phone, or pair it again.' };
    // Wireless debugging: the connect port is announced over mDNS and changes every time it is switched on
    for (const s of await mdns()) {
      if (s.type !== 'connect' || stripV4(s.host) !== ip) continue;
      const r = await runner(d.adb, ['connect', `${s.host}:${s.port}`], { timeout: 12000 });
      if (/connected to|already connected/i.test(r.out)) {
        const again = await devices();
        const f = again.ok && choose(again.devices, ip);
        if (f) return { ok: true, serial: f.serial, model: f.model, adb: d.adb };
      }
      if (/failed to authenticate|unauthorized|protocol fault|certificate/i.test(r.out + r.err)) return { ok: false, needPair: true, error: 'This computer is not paired with the phone yet.' };
    }
    return { ok: false, needPair: true, error: 'No adb connection to this phone yet. Turn on Wireless debugging on the phone (Settings > Developer options), then pair or connect.' };
  }
  /** What the pairing / connect panel needs to show: the announced ports of the phone at ip. */
  async function discover(ip) {
    ip = stripV4(ip);
    const s = (await mdns()).filter((x) => stripV4(x.host) === ip);
    return { ok: true, pair: s.find((x) => x.type === 'pair') || null, connect: s.find((x) => x.type === 'connect') || null };
  }
  async function pair(hostPort, code) {
    const a = adb(); if (!a) return NEED;
    if (!validHostPort(hostPort)) return { ok: false, error: 'Enter the pairing address as ip:port, for example 192.168.1.20:37123' };
    if (!/^\d{6}$/.test(String(code))) return { ok: false, error: 'The pairing code is 6 digits.' };
    const r = await runner(a, ['pair', hostPort, String(code)], { timeout: 20000 });
    if (/successfully paired/i.test(r.out)) return { ok: true };
    return { ok: false, error: (r.out + ' ' + r.err).trim() || 'Pairing failed' };
  }
  async function connect(hostPort) {
    const a = adb(); if (!a) return NEED;
    if (!validHostPort(hostPort)) return { ok: false, error: 'Enter the address as ip:port' };
    const r = await runner(a, ['connect', hostPort], { timeout: 15000 });
    if (/connected to|already connected/i.test(r.out)) return { ok: true };
    return { ok: false, error: (r.out + ' ' + r.err).trim() || 'Could not connect' };
  }
  return { devices, ensure, discover, pair, connect, adb, mdns };
}

/* ---------- the control session ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Real screen size in the CURRENT orientation. `landscape` comes from the viewer's picture. */
async function screenSize(adb, serial, landscape, runner = run) {
  const r = await runner(adb, ['-s', serial, 'shell', 'wm', 'size']);
  // "Physical size: 1080x2400" and, if the user changed it, "Override size: 720x1600"
  const all = [...String(r.out).matchAll(/(Physical|Override) size:\s*(\d+)x(\d+)/g)];
  const pick = all.find((m) => m[1] === 'Override') || all[0];
  if (!pick) return null;
  let w = Number(pick[2]), h = Number(pick[3]);
  if (landscape !== (w > h)) [w, h] = [h, w];
  return { w, h };
}

/**
 * Opens a control session to `serial`. opts: { adb, serial, jar, onClosed(why), getLandscape() }
 * Resolves { ok, session } where session = { handle(ev), release(), close(), mode }.
 */
async function openSession(opts) {
  const { adb, serial } = opts;
  const landscapeNow = () => (opts.getLandscape ? !!opts.getLandscape() : false);
  let size = await screenSize(adb, serial, landscapeNow());
  if (!size) return { ok: false, error: 'Could not read the phone screen size over adb.' };
  let lastLand = landscapeNow();
  const sz = () => { // re-read now and then, so rotation is followed
    const l = landscapeNow();
    if (l !== lastLand) { lastLand = l; size = { w: size.h, h: size.w }; }
    return size;
  };

  let session = null;
  if (opts.jar) {
    try { session = await startServer(opts, sz); } catch (e) { session = null; opts.log && opts.log('scrcpy-server failed: ' + (e && e.message)); }
  }
  if (!session) session = startShellInput(opts, sz);
  return { ok: true, session };
}

function startServer(opts, sz) {
  const { adb, serial } = opts;
  const scid = crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff;
  const scidHex = scid.toString(16).padStart(8, '0');
  const sock = 'scrcpy_' + scidHex;
  return (async () => {
    const push = await run(adb, ['-s', serial, 'push', opts.jar, REMOTE_JAR], { timeout: 30000 });
    if (!push.ok) throw new Error('push failed: ' + push.err);
    const fw = await run(adb, ['-s', serial, 'forward', 'tcp:0', 'localabstract:' + sock]);
    const port = Number(String(fw.out).split(/\s+/).pop());
    if (!fw.ok || !(port > 0)) throw new Error('forward failed: ' + (fw.err || fw.out));
    const args = ['-s', serial, 'shell', `CLASSPATH=${REMOTE_JAR}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', SERVER_VERSION,
      `scid=${scidHex}`, 'log_level=warn', 'video=false', 'audio=false', 'control=true', 'tunnel_forward=true', 'send_device_meta=false', 'cleanup=false', 'clipboard_autosync=false'];
    const proc = spawn(adb, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let serverLog = '';
    proc.stdout.on('data', (d) => { serverLog += d; if (serverLog.length > 4000) serverLog = serverLog.slice(-4000); });
    proc.stderr.on('data', (d) => { serverLog += d; if (serverLog.length > 4000) serverLog = serverLog.slice(-4000); });
    let exited = false;
    proc.on('exit', () => { exited = true; });
    const removeForward = () => run(adb, ['-s', serial, 'forward', '--remove', 'tcp:' + port]).catch(() => {});

    // the server needs a moment to start listening: connect until the dummy byte arrives
    let socket = null;
    for (let i = 0; i < 40 && !socket && !exited; i++) {
      socket = await new Promise((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port });
        let done = false;
        const fin = (v) => { if (done) return; done = true; s.removeAllListeners(); if (!v) s.destroy(); resolve(v); };
        s.setNoDelay(true);
        s.once('data', (d) => (d.length >= 1 ? fin(s) : fin(null)));
        s.once('error', () => fin(null));
        s.once('close', () => fin(null));
        setTimeout(() => fin(null), 1500);
      });
      if (!socket) await sleep(150);
    }
    if (!socket) { try { proc.kill(); } catch {} await removeForward(); throw new Error('the server did not start' + (serverLog ? ': ' + serverLog.trim().split('\n').pop() : '')); }

    let closed = false;
    const close = (why) => {
      if (closed) return;
      closed = true;
      try { socket.destroy(); } catch {}
      try { proc.kill(); } catch {}
      removeForward();
      if (opts.onClosed) opts.onClosed(why || 'closed');
    };
    socket.on('error', () => close('connection lost'));
    socket.on('close', () => close('connection lost'));
    socket.on('data', () => {}); // the server only sends replies we did not ask for (clipboard); ignore them
    proc.on('exit', () => close('the phone stopped the control server'));

    const send = (b) => { if (!closed && socket.writable) socket.write(b); };
    const state = { down: false, pos: null, held: new Set(), mods: new Set() };
    const metaNow = () => { let m = 0; for (const c of state.mods) m |= META[c]; return m; };
    const px = (e) => { const s = sz(); return [Math.min(s.w - 1, Math.round(e.x * (s.w - 1))), Math.min(s.h - 1, Math.round(e.y * (s.h - 1))), s]; };

    function handle(e) {
      switch (e.k) {
        case 'down': {
          const [x, y, s] = px(e);
          if (e.b === 2) { send(Msg.backOrScreenOn()); return; } // right click = Back
          if (state.down) send(Msg.touch(ACTION_UP, POINTER_FINGER, state.pos[0], state.pos[1], s.w, s.h, 0, 0));
          state.down = true; state.pos = [x, y];
          send(Msg.touch(ACTION_DOWN, POINTER_FINGER, x, y, s.w, s.h, 1, BUTTON_PRIMARY));
          break;
        }
        case 'move': {
          if (!state.down) return;
          const [x, y, s] = px(e);
          if (x === state.pos[0] && y === state.pos[1]) return;
          state.pos = [x, y];
          send(Msg.touch(ACTION_MOVE, POINTER_FINGER, x, y, s.w, s.h, 1, BUTTON_PRIMARY));
          break;
        }
        case 'up': {
          if (e.b === 2 || !state.down) return;
          const [x, y, s] = px(e);
          state.down = false;
          send(Msg.touch(ACTION_UP, POINTER_FINGER, x, y, s.w, s.h, 0, 0));
          break;
        }
        case 'wheel': {
          const [x, y, s] = px(e);
          // one message per notch; positive dy in the viewer = scroll down = negative vscroll on Android
          for (let i = 0, n = Math.max(Math.abs(e.dx), Math.abs(e.dy)); i < n; i++) send(Msg.scroll(x, y, s.w, s.h, -Math.sign(e.dx) * (i < Math.abs(e.dx) ? 1 : 0), -Math.sign(e.dy) * (i < Math.abs(e.dy) ? 1 : 0)));
          break;
        }
        case 'key': {
          const kc = keyOf(e.code);
          if (!kc) return;
          if (META[e.code]) { if (e.d) state.mods.add(e.code); else state.mods.delete(e.code); }
          if (e.d) state.held.add(kc); else state.held.delete(kc);
          send(Msg.key(e.d ? KEY_DOWN : KEY_UP, kc, 0, metaNow()));
          break;
        }
        case 'text': send(Msg.text(e.s)); break;
        case 'nav': {
          const kc = NAV_KEY[e.a];
          if (kc) { send(Msg.key(KEY_DOWN, kc)); send(Msg.key(KEY_UP, kc)); }
          break;
        }
        default: break;
      }
    }
    function release() {
      if (state.down) { const s = sz(); send(Msg.touch(ACTION_UP, POINTER_FINGER, state.pos[0], state.pos[1], s.w, s.h, 0, 0)); state.down = false; }
      for (const kc of state.held) send(Msg.key(KEY_UP, kc));
      state.held.clear(); state.mods.clear();
    }
    return { mode: 'scrcpy', handle, release, close: () => { release(); close('stopped'); } };
  })();
}

/** Fallback: `adb shell input ...`. One gesture is sent when the button is released. */
function startShellInput(opts, sz) {
  const { adb, serial } = opts;
  const queue = [];
  let busy = false, closed = false;
  const st = { down: null, last: null, t0: 0, moved: false };
  const sh = (...a) => new Promise((res) => { execFile(adb, ['-s', serial, 'shell', ...a], { timeout: 8000, windowsHide: true }, () => res()); });
  async function pump() {
    if (busy) return; busy = true;
    while (queue.length && !closed) { const job = queue.shift(); try { await job(); } catch {} }
    busy = false;
  }
  const enqueue = (job) => { if (queue.length > 20) queue.shift(); queue.push(job); pump(); };
  const pos = (e) => { const s = sz(); return [Math.round(e.x * (s.w - 1)), Math.round(e.y * (s.h - 1))]; };
  const shellQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  function handle(e) {
    switch (e.k) {
      case 'down': if (e.b === 2) { enqueue(() => sh('input', 'keyevent', '4')); return; } st.down = pos(e); st.last = st.down; st.t0 = Date.now(); st.moved = false; break;
      case 'move': if (st.down) { st.last = pos(e); if (Math.abs(st.last[0] - st.down[0]) + Math.abs(st.last[1] - st.down[1]) > 12) st.moved = true; } break;
      case 'up': {
        if (!st.down || e.b === 2) return;
        const a = st.down, b = pos(e), ms = Math.max(50, Math.min(3000, Date.now() - st.t0));
        st.down = null;
        if (!st.moved) enqueue(() => (ms > 500 ? sh('input', 'swipe', a[0], a[1], a[0], a[1], ms) : sh('input', 'tap', a[0], a[1])));
        else enqueue(() => sh('input', 'swipe', a[0], a[1], b[0], b[1], Math.min(ms, 800)));
        break;
      }
      case 'wheel': {
        const [x, y] = pos(e), s = sz(), dy = Math.round(-e.dy * s.h * 0.08), dx = Math.round(-e.dx * s.w * 0.08);
        enqueue(() => sh('input', 'swipe', x, y, Math.max(0, Math.min(s.w - 1, x + dx)), Math.max(0, Math.min(s.h - 1, y + dy)), 120));
        break;
      }
      case 'key': {
        if (!e.d) return;
        const kc = keyOf(e.code);
        if (kc) enqueue(() => sh('input', 'keyevent', String(kc)));
        break;
      }
      case 'text': enqueue(() => sh('input', 'text', shellQuote(e.s.replace(/ /g, '%s')))); break;
      case 'nav': { const kc = NAV_KEY[e.a]; if (kc) enqueue(() => sh('input', 'keyevent', String(kc))); break; }
      default: break;
    }
  }
  return { mode: 'shell', handle, release: () => { st.down = null; }, close: () => { closed = true; queue.length = 0; if (opts.onClosed) opts.onClosed('stopped'); } };
}

module.exports = { META, createAdb, openSession, findAdb, findServerJar, parseDevices, parseMdns, keyOf, Msg, SERVER_VERSION, SERVER_FILE, validHostPort, screenSize };
