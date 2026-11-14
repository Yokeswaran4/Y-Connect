// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cap', {
  onStart: (cb) => ipcRenderer.on('capture-start', (_e, o) => cb(o)),
  frame: (data, w, h) => ipcRenderer.invoke('screen-frame', data, w, h),
  failed: (why) => ipcRenderer.send('screen-capture-failed', String(why)),
});
