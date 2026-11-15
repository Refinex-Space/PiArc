// Sandboxed preload (Electron 45): only `require('electron')` is available, so this file
// imports nothing else at runtime. It exposes the `window.piarc` allowlist and never
// `ipcRenderer` itself (Electron security checklist item 20). An event API added later must
// strip Electron's event object before calling the page's callback.
import { contextBridge, ipcRenderer } from 'electron';

import { IPC_CHANNELS, type PiarcApi } from '../shared/ipc.js';

function expectString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Unexpected IPC result: expected a string');
  }
  return value;
}

function expectBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError('Unexpected IPC result: expected a boolean');
  }
  return value;
}

const api: PiarcApi = {
  getAppVersion: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getAppVersion).then((value: unknown) => expectString(value)),
  openExternal: (url: string) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.openExternal, url)
      .then((value: unknown) => expectBoolean(value)),
};

contextBridge.exposeInMainWorld('piarc', api);
