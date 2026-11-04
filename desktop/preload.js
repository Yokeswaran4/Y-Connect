// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Yokeswaran N
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('yconnect', {
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getDeviceInfo: () => ipcRenderer.invoke('device-info'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  copyDebugReport: () => ipcRenderer.invoke('copy-debug-report'),
  saveDebugReport: () => ipcRenderer.invoke('save-debug-report'),
  pingNow: (id) => ipcRenderer.invoke('ping-now', id),
  onLatency: (cb) => ipcRenderer.on('latency', (_e, id, l) => cb(id, l)),
  getLicenses: () => ipcRenderer.invoke('get-licenses'),
  getState: () => ipcRenderer.invoke('state'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  unpair: (id) => ipcRenderer.invoke('unpair', id),
  pairRequest: (id) => ipcRenderer.invoke('pair-request', id),
  pairCancel: (id) => ipcRenderer.invoke('pair-cancel', id),
  dismissPair: () => ipcRenderer.invoke('dismiss-pair'),
  connectIp: (host) => ipcRenderer.invoke('connect-ip', host),
  sendClipboard: () => ipcRenderer.invoke('send-clipboard'),
  testNotification: () => ipcRenderer.invoke('test-notification'),
  pickAndSend: (peerId) => ipcRenderer.invoke('pick-and-send', peerId),
  pickFolderAndSend: (peerId) => ipcRenderer.invoke('pick-folder-and-send', peerId),
  resumeTransfer: (id) => ipcRenderer.invoke('resume-transfer', id),
  sendFiles: (peerId, paths) => ipcRenderer.invoke('send-files', peerId, paths),
  cancelTransfer: (id) => ipcRenderer.invoke('cancel-transfer', id),
  clearTransfers: () => ipcRenderer.invoke('clear-transfers'),
  openDownloads: () => ipcRenderer.invoke('open-downloads'),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  onUpdate: (cb) => ipcRenderer.on('update', (_e, s) => cb(s)),
});
