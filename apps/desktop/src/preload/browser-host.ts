// Preload of the agent's script host (ADR-0089 rule 3): a sandboxed page in its own partition
// with no network. It exposes `window.piarcBrowserHost` and nothing else: one invoke channel
// for the SDK's bindings (the main process answers only the host of the run in progress) and
// two listeners. Listeners receive plain values, never an Electron event object.
import { contextBridge, ipcRenderer } from 'electron';

import {
  BROWSER_HOST_CDP_CHANNEL,
  BROWSER_HOST_CHANNEL,
  BROWSER_HOST_RUN_CHANNEL,
  type BrowserHostApi,
  type BrowserHostRequest,
  type BrowserHostResult,
  type BrowserHostRun,
} from '../shared/browser-host.js';

let cdpListener: ((message: string) => void) | undefined;
let runListener: ((run: BrowserHostRun) => void) | undefined;

ipcRenderer.on(BROWSER_HOST_CDP_CHANNEL, (_event, message: unknown) => {
  if (typeof message === 'string') cdpListener?.(message);
});
ipcRenderer.on(BROWSER_HOST_RUN_CHANNEL, (_event, run: unknown) => {
  // The main process builds the run; the page checks its fields before using them.
  if (typeof run === 'object' && run !== null) runListener?.(run as BrowserHostRun);
});

const api: BrowserHostApi = {
  call: (request: BrowserHostRequest) => ipcRenderer.invoke(BROWSER_HOST_CHANNEL, request),
  onCdp: (listener) => {
    cdpListener = listener;
  },
  onRun: (listener) => {
    runListener = listener;
  },
  finish: (result: BrowserHostResult) => {
    void ipcRenderer.invoke(BROWSER_HOST_CHANNEL, { op: 'finish', result });
  },
};

contextBridge.exposeInMainWorld('piarcBrowserHost', api);
