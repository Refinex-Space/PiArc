// Sandboxed preload (Electron 45): only `require('electron')` is available, so this file
// imports nothing else at runtime. It exposes the `window.piarc` allowlist and never
// `ipcRenderer` itself (Electron security checklist item 20). Event listeners receive the
// batch only, never an Electron event object.
import { contextBridge, ipcRenderer } from 'electron';

import {
  EVENTS_PORT_CHANNEL,
  IPC_CHANNELS,
  type EventBatch,
  type EventListener,
  type PiarcApi,
} from '../shared/ipc.js';

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

/**
 * The part of the DOM `MessagePort` this file uses. The preload project has neither DOM nor
 * Node types, so Electron's `IpcRendererEvent.ports` cannot be typed here.
 */
interface IncomingPort {
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  start(): void;
}

function isIncomingPort(value: unknown): value is IncomingPort {
  return (
    typeof value === 'object' &&
    value !== null &&
    'addEventListener' in value &&
    typeof value.addEventListener === 'function' &&
    'start' in value &&
    typeof value.start === 'function'
  );
}

/** One listener per route key, called for each batch the main process posts. */
const listeners = new Map<string, EventListener>();
let connection: Promise<void> | undefined;

function isEventBatch(value: unknown): value is EventBatch {
  return (
    typeof value === 'object' &&
    value !== null &&
    'route' in value &&
    typeof value.route === 'string' &&
    'seq' in value &&
    typeof value.seq === 'number' &&
    'payload' in value &&
    value.payload instanceof Uint8Array
  );
}

function dispatch(message: unknown): void {
  const batches: unknown =
    typeof message === 'object' && message !== null && 'batches' in message
      ? message.batches
      : undefined;
  if (!Array.isArray(batches)) {
    console.error('[piarc] ignored a malformed event message');
    return;
  }
  for (const batch of batches) {
    if (!isEventBatch(batch)) {
      console.error('[piarc] ignored a malformed event batch');
      continue;
    }
    const listener = listeners.get(batch.route);
    if (listener === undefined) {
      continue;
    }
    try {
      listener(batch);
    } catch (error) {
      console.error(`[piarc] event listener for ${batch.route} threw`, error);
    }
  }
}

/** Asks the main process for this page's event port once and starts dispatching from it. */
function connectEvents(): Promise<void> {
  connection ??= new Promise<void>((resolve, reject) => {
    ipcRenderer.once(EVENTS_PORT_CHANNEL, (event) => {
      const ports: unknown = event.ports;
      const port: unknown = Array.isArray(ports) ? ports[0] : undefined;
      if (!isIncomingPort(port)) {
        reject(new Error('The main process sent no event port'));
        return;
      }
      port.addEventListener('message', (message) => {
        dispatch(message.data);
      });
      port.start();
      resolve();
    });
    ipcRenderer.invoke(IPC_CHANNELS.eventsConnect).catch((error: unknown) => {
      ipcRenderer.removeAllListeners(EVENTS_PORT_CHANNEL);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  }).catch((error: unknown) => {
    connection = undefined;
    throw error;
  });
  return connection;
}

const api: PiarcApi = {
  getAppVersion: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getAppVersion).then((value: unknown) => expectString(value)),
  openExternal: (url: string) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.openExternal, url)
      .then((value: unknown) => expectBoolean(value)),
  subscribeEvents: async (route: string, listener: EventListener) => {
    if (typeof listener !== 'function') {
      throw new TypeError('listener must be a function');
    }
    await connectEvents();
    const previous = listeners.get(route);
    listeners.set(route, listener);
    try {
      await ipcRenderer.invoke(IPC_CHANNELS.eventsSubscribe, route);
    } catch (error) {
      if (previous === undefined) {
        listeners.delete(route);
      } else {
        listeners.set(route, previous);
      }
      throw error;
    }
  },
  unsubscribeEvents: async (route: string) => {
    listeners.delete(route);
    await ipcRenderer.invoke(IPC_CHANNELS.eventsUnsubscribe, route);
  },
};

contextBridge.exposeInMainWorld('piarc', api);
