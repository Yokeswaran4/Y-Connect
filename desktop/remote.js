// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
/*
 * Remote commands requested by a paired Android phone. Removing files is not offered at all.
 *
 *   phone                                         this computer
 *   cmd-run    {rid, command, shell?, timeout?}  ------->
 *   cmd-rm     (retired: always refused)         ------->
 *   cmd-cancel {rid}                             ------->
 *                                                <-------  cmd-result {rid, ok, code, stdout, stderr, truncated, ms, error?}
 *
 * error = { kind, why, fix }: a plain-language reason and the way to resolve it, shown on the phone.
 *
 * Safety model (all of it is on this side, so a phone can never switch it off):
 *  - Commands are OFF until the user turns them on in Settings (config.allowCommands).
 *  - Only an Android peer that is already paired (encrypted with the pairing code) can ask.
 *  - Commands are never elevated: sudo / su / doas / pkexec / runas / gsudo are refused, nothing runs as admin,
 *    stdin is closed so nothing can wait for a password, and every run has a time limit.
 *  - Deleting files is never allowed from the phone: the removal request is refused and so are delete commands
 *    (rm, del, rmdir, Remove-Item, find -delete ...). There is no setting that turns this on.
 * The elevation / delete checks on a free-form command are a best-effort guard rail against mistakes,
 * not a sandbox: the real protection is that the feature is off by default and needs a paired phone.
 */
const { spawn, execFile } = require('child_process');
const os = require('os');

const IS_WIN = process.platform === 'win32';
const MAX_OUT = 48 * 1024;        // per stream
const MAX_CMD = 4000;
const DEFAULT_TIMEOUT = 30;       // seconds
const MAX_TIMEOUT = 120;
const MAX_RUNNING = 3;

let D = null;                     // { peers, sendTo, getConfig, addLog }
const running = new Map();        // rid -> { ws, child, cancelled }

function init(deps) { D = deps; }

/* ---------- guard rails ---------- */
const SEP = '(?:^|[\\s;&|(`\'"])';
const END = '(?=$|[\\s;&|)`\'"])';
const ELEVATE = new RegExp(SEP + '(sudo|su|doas|pkexec|runas|gsudo)(?:\\.exe)?' + END, 'i');
const ELEVATE_PS = /-Verb\s+['"]?RunAs/i;
const DELETE = new RegExp(SEP + '(rm|rmdir|unlink|shred|srm|rimraf|trash|trash-put|del|erase|rd|remove-item|ri|clear-recyclebin)(?:\\.exe)?' + END, 'i');
const DELETE_FIND = /\bfind\b[^\n]*\s-delete\b|\s-exec\s+(?:rm|shred)\b/i;

function findElevation(cmd) {
  const m = ELEVATE.exec(cmd);
  if (m) return m[1].toLowerCase();
  return ELEVATE_PS.test(cmd) ? 'Start-Process -Verb RunAs' : null;
}
function findDeletion(cmd) {
  const m = DELETE.exec(cmd);
  if (m) return m[1];
  return DELETE_FIND.test(cmd) ? 'find -delete' : null;
}

/* ---------- plain-language explanations ---------- */
const E = (kind, why, fix) => ({ kind, why, fix });
const me = () => D.getConfig().name || os.hostname();
const sh = () => (IS_WIN ? 'Windows' : 'Linux');

function explainExit({ code, signal, stderr, stdout, timedOut, timeout, cancelled, shell }) {
  const text = (stderr + '\n' + stdout).slice(0, 6000);
  if (cancelled) return E('cancelled', 'You cancelled the command.', 'Run it again if you still need it.');
  if (timedOut) {
    return E('timeout', `The command was still running after ${timeout} seconds, so Y Connect stopped it. Programs that never finish on their own (top, ping without a count, tail -f, editors, installers waiting for input) always end up here.`,
      IS_WIN ? 'Use a version that ends by itself (for example ping -n 4 host), or raise the time limit on the phone (max 120 s).'
        : 'Use a version that ends by itself (for example ping -c 4 host, or top -b -n 1), or raise the time limit on the phone (max 120 s).');
  }
  if (/password is required|a terminal is required|must be run from a terminal|no tty present|askpass/i.test(text)) {
    return E('needs-terminal', 'The command wanted a password or an interactive terminal. Y Connect has neither: it never elevates and nothing can be typed while a command runs.',
      'Use a command that does not need admin rights, or run this one directly on the computer.');
  }
  if (/permission denied|operation not permitted|access is denied|EACCES|EPERM|requires elevation|requested operation requires/i.test(text)) {
    return IS_WIN
      ? E('permission', 'Windows refused: the command touched something that needs administrator rights, or a file/folder you do not own. Y Connect never runs as administrator.',
        'Use a path inside your own user folder (C:\\Users\\<you>\\...), or run this one directly on the computer as administrator.')
      : E('permission', 'Linux refused: the command touched something only root (or another user) may use. Y Connect never uses sudo.',
        'Use a path you own (your home folder), or check it with: ls -l <path>. If it is your own file, fix it on the computer with chmod / chown.');
  }
  if (code === 127 || /command not found|: not found|is not recognized as (?:an internal|the name)|cannot find the (?:file|path) specified|CommandNotFoundException|ENOENT.*spawn/i.test(text) || code === 9009) {
    return E('not-found', `The program does not exist on ${me()} or is not on the PATH that Y Connect sees (apps started from the tray or an AppImage get a shorter PATH than a terminal).`,
      IS_WIN ? 'Check the spelling, install the program, or type its full path, e.g. "C:\\Program Files\\App\\app.exe". Try: where <name>'
        : 'Check the spelling, install the program (apt/dnf/pacman), or type its full path, e.g. /usr/bin/<name>. Try: which <name>');
  }
  if (/no such file or directory|the system cannot find the (?:file|path)|cannot find path|does not exist/i.test(text)) {
    return E('no-such-path', 'A file or folder named in the command does not exist. Relative paths start in the home folder of this computer, not where you might expect.',
      IS_WIN ? 'Use a full path such as C:\\Users\\<you>\\Downloads\\file.txt, or check with: dir <folder>'
        : 'Use a full path such as /home/<you>/Downloads/file.txt, or check with: ls <folder>');
  }
  if (/syntax error|unexpected token|unexpected EOF|unterminated|the syntax of the command is incorrect|ParserError|missing terminator/i.test(text)) {
    return E('syntax', 'The shell could not understand the command. Usually a quote, bracket or special character is not closed or not escaped.',
      shell === 'powershell' ? 'Check quotes and brackets. In PowerShell use single quotes for literal text.'
        : IS_WIN ? 'Check quotes. In cmd use double quotes around paths with spaces; or choose PowerShell as the shell.'
          : 'Check that every quote and bracket is closed, and put paths with spaces in quotes.');
  }
  if (/could not resolve host|name or service not known|temporary failure in name resolution|getaddrinfo|no such host is known/i.test(text)) {
    return E('dns', `${me()} could not look up that web address, so it is probably offline or has a DNS problem.`, 'Check the computer\'s internet connection, then try again; or use the IP address instead of the name.');
  }
  if (/connection refused|actively refused/i.test(text)) {
    return E('refused', 'The program reached the machine but nothing is listening on that port: the service is not running (or a firewall blocks it).', 'Start the service first, or check the port number.');
  }
  if (/no space left on device|not enough space on the disk|disk full/i.test(text)) {
    return E('disk-full', 'The disk is full.', 'Free some space on the computer and try again.');
  }
  if (/read-only file system/i.test(text)) {
    return E('read-only', 'The target location is mounted read-only.', 'Pick a different folder, or remount it writable on the computer.');
  }
  if (signal) {
    return E('killed', `The command was ended by the system (${signal}). That happens when it crashes or runs out of memory.`, 'Run it again; if it keeps happening, try a smaller task or check memory on the computer.');
  }
  return E('exit-code', `The command ran but finished with exit code ${code}. That is the program's own way of saying something went wrong; the meaning of the number depends on the program.`,
    'Read the error output above (stderr) for the exact reason, fix the command, and run it again.');
}

/* ---------- results ---------- */
function reply(ws, rid, o) { D.sendTo(ws, Object.assign({ type: 'cmd-result', rid }, o)); }
function fail(ws, rid, error, extra) { reply(ws, rid, Object.assign({ ok: false, code: -1, stdout: '', stderr: '', truncated: false, ms: 0, error }, extra)); }
const preview = (t) => String(t).replace(/\s+/g, ' ').slice(0, 70);

function senderOk(ws) {
  for (const p of D.peers.values()) if (p.ws === ws) return p.info.platform === 'android' ? p.info : null;
  return null;
}

/* ---------- run a command ---------- */
function killTree(child) {
  try {
    if (IS_WIN) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch {} }
}

function runCommand(ws, who, msg) {
  const rid = String(msg.rid || '').slice(0, 64);
  if (!rid) return;
  const cfg = D.getConfig();
  const cmd = typeof msg.command === 'string' ? msg.command.trim() : '';
  const shell = msg.shell === 'powershell' && IS_WIN ? 'powershell' : 'default';
  const timeout = Math.max(1, Math.min(MAX_TIMEOUT, Number(msg.timeout) || DEFAULT_TIMEOUT));

  if (!cfg.allowCommands) {
    D.addLog('warn', 'Command refused', `${who.name} tried to run a command but remote commands are off`);
    return fail(ws, rid, E('disabled', `Remote commands are turned off on ${me()}. This is the default, so nothing runs unless you allow it.`,
      `On ${me()}: open Y Connect > Sync > "Allow commands from phone" and switch it on, then try again.`));
  }
  if (!cmd) return fail(ws, rid, E('empty', 'The command is empty.', 'Type a command and try again.'));
  if (cmd.length > MAX_CMD) return fail(ws, rid, E('too-long', `The command is longer than ${MAX_CMD} characters.`, 'Put it in a script file on the computer and run that instead.'));
  if (/\0/.test(cmd)) return fail(ws, rid, E('bad-command', 'The command contains an invalid character.', 'Retype the command.'));
  const elev = findElevation(cmd);
  if (elev) {
    D.addLog('warn', 'Command refused', `Needs elevation (${elev}): ${preview(cmd)}`);
    return fail(ws, rid, E('elevation', `"${elev}" asks for administrator / root rights. Y Connect only runs commands that do not need sudo or admin, because nobody can type a password remotely and an elevated remote shell is dangerous.`,
      'Remove the elevation part and run it as a normal user, or run this command directly on the computer.'));
  }
  const del = findDeletion(cmd);
  if (del) {
    D.addLog('warn', 'Command refused', `Delete command (${del}): ${preview(cmd)}`);
    return fail(ws, rid, E('removal-blocked', `The command contains "${del}", which deletes files. Deleting files from the phone is not allowed on ${me()}.`,
      'Delete files directly on the computer, or run a command that does not remove anything.'));
  }
  if (running.size >= MAX_RUNNING) return fail(ws, rid, E('busy', `${MAX_RUNNING} commands are already running on ${me()}.`, 'Wait for one to finish (or cancel it) and try again.'));

  let file, args, opts = { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { TERM: 'dumb', NO_COLOR: '1' }) };
  delete opts.env.SUDO_ASKPASS;
  delete opts.env.SSH_ASKPASS;
  if (IS_WIN) {
    opts.windowsHide = true;
    if (shell === 'powershell') {
      file = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + cmd];
    } else {
      file = process.env.ComSpec || 'cmd.exe';
      args = ['/d', '/s', '/c', 'chcp 65001>nul & ' + cmd];
      opts.windowsVerbatimArguments = true;
    }
  } else {
    file = '/bin/sh';
    args = ['-c', cmd];
    opts.detached = true; // own process group so a timeout can end the whole tree
  }

  const started = Date.now();
  D.addLog('cmd', `Command from ${who.name}`, preview(cmd));
  let child;
  try { child = spawn(file, args, opts); }
  catch (e) { return fail(ws, rid, explainSpawn(e, file)); }
  const job = { ws, child, cancelled: false };
  running.set(rid, job);

  const out = { stdout: [], stderr: [] }, size = { stdout: 0, stderr: 0 };
  let truncated = false, timedOut = false, done = false;
  const take = (k) => (d) => {
    if (size[k] >= MAX_OUT) { truncated = true; return; }
    const room = MAX_OUT - size[k];
    const part = d.length > room ? d.subarray(0, room) : d;
    if (part.length < d.length) truncated = true;
    out[k].push(part); size[k] += part.length;
  };
  child.stdout.on('data', take('stdout'));
  child.stderr.on('data', take('stderr'));
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout * 1000);

  const finish = (code, signal, spawnErr) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    running.delete(rid);
    const stdout = Buffer.concat(out.stdout).toString('utf8');
    const stderr = Buffer.concat(out.stderr).toString('utf8');
    const ms = Date.now() - started;
    let error = null;
    if (spawnErr) error = explainSpawn(spawnErr, file);
    else if (job.cancelled || timedOut || code !== 0) error = explainExit({ code, signal, stderr, stdout, timedOut, timeout, cancelled: job.cancelled, shell });
    const ok = !error;
    D.addLog(ok ? 'cmd' : 'warn', ok ? 'Command finished' : 'Command failed', `${preview(cmd)}${ok ? '' : ' — ' + error.kind}`);
    reply(ws, rid, { ok, code: code == null ? -1 : code, signal: signal || '', stdout, stderr, truncated, ms, error });
  };
  child.on('error', (e) => finish(-1, '', e));
  child.on('close', (code, signal) => finish(code, signal));
}

function explainSpawn(e, file) {
  if (e && e.code === 'ENOENT') return E('no-shell', `The shell (${file}) could not be started on ${me()}.`, IS_WIN ? 'Check that cmd.exe / powershell.exe exist and are not blocked by security software.' : 'Check that /bin/sh exists. On a very minimal system install a shell package (dash or bash).');
  if (e && (e.code === 'EACCES' || e.code === 'EPERM')) return E('permission', `Not allowed to start the shell (${file}).`, 'Security software or a sandbox is blocking Y Connect from starting programs. Allow it there.');
  return E('spawn-failed', `The command could not be started: ${(e && e.message) || 'unknown error'}.`, 'Try again; if it keeps failing, restart Y Connect on the computer.');
}

/* ---------- entry points ---------- */
function onMessage(ws, msg) {
  const who = senderOk(ws);
  const rid = String(msg.rid || '').slice(0, 64);
  if (msg.type === 'cmd-result') return; // only phones receive results
  if (!who) {
    if (rid) fail(ws, rid, E('sender', 'Only a paired Android phone may send commands to a computer.', 'Pair the phone with this computer first (Devices tab).'));
    return;
  }
  if (msg.type === 'cmd-run') runCommand(ws, who, msg);
  else if (msg.type === 'cmd-rm') {
    // retired: an older phone may still send it, so answer instead of leaving it waiting
    D.addLog('warn', 'Removal refused', `${who.name} tried to remove a file; removing files from the phone is not allowed`);
    if (rid) fail(ws, rid, E('removal-blocked', `Removing files from the phone is not allowed on ${me()}.`, 'Delete the file directly on the computer. Update Y Connect on the phone to remove this option.'));
  }
  else if (msg.type === 'cmd-cancel') {
    const j = running.get(rid);
    if (j && j.ws === ws) { j.cancelled = true; killTree(j.child); }
  }
}

/** When the phone disconnects its commands are stopped, so nothing keeps running unseen. */
function onDisconnected(ws) {
  for (const [rid, j] of running) if (j.ws === ws) { j.cancelled = true; killTree(j.child); }
}

module.exports = { init, onMessage, onDisconnected, findElevation, findDeletion };
