// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('viewer', {
  onFrame: (cb) => ipcRenderer.on('viewer-frame', (_e, jpeg) => cb(jpeg)),
  onControl: (cb) => ipcRenderer.on('viewer-ctl', (_e, on) => cb(!!on)),
  onInfo: (cb) => ipcRenderer.on('viewer-info', (_e, i) => cb(i || {})),
  onAdbEnded: (cb) => ipcRenderer.on('adb-ended', () => cb()),
  input: (ev) => ipcRenderer.send('viewer-input', ev),
  dims: (w, h) => ipcRenderer.send('viewer-dims', w, h),
  adbStart: () => ipcRenderer.invoke('adb-start'),
  adbStop: () => ipcRenderer.invoke('adb-stop'),
  adbPair: (hostPort, code) => ipcRenderer.invoke('adb-pair', hostPort, code),
  adbConnect: (hostPort) => ipcRenderer.invoke('adb-connect', hostPort),
  adbDiscover: () => ipcRenderer.invoke('adb-discover'),
});
