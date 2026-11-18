// Sandboxed preload (Electron 45): only `require('electron')` is available, so this file
// imports nothing else at runtime. It exposes the `window.piarc` allowlist and never
// `ipcRenderer` itself (Electron security checklist item 20). Event listeners receive the
// batch only, never an Electron event object.
import { contextBridge, ipcRenderer } from 'electron';

import {
  APP_EVENT_CHANNEL,
  EVENTS_PORT_CHANNEL,
  IPC_CHANNELS,
  type AppEvent,
  type AppState,
  type EventBatch,
  type EventListener,
  type PiarcApi,
} from '../shared/ipc.js';
import type { Preferences } from '../shared/preferences.js';

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

function expectStringOrNull(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') {
    throw new TypeError('Unexpected IPC result: expected a string or null');
  }
  return value;
}

/** The main process builds these objects itself; the renderer validates what it reads. */
function expectAppState(value: unknown): AppState {
  if (typeof value !== 'object' || value === null || !('preferences' in value)) {
    throw new TypeError('Unexpected IPC result: expected the app state');
  }
  return value as AppState;
}

function expectPreferences(value: unknown): Preferences {
  if (typeof value !== 'object' || value === null || !('appearance' in value)) {
    throw new TypeError('Unexpected IPC result: expected preferences');
  }
  return value as Preferences;
}

const appListeners = new Set<(event: AppEvent) => void>();
let appChannelOpen = false;

function onAppEvent(listener: (event: AppEvent) => void): () => void {
  if (typeof listener !== 'function') {
    throw new TypeError('listener must be a function');
  }
  if (!appChannelOpen) {
    appChannelOpen = true;
    // The Electron event object is dropped: pages get the message only.
    ipcRenderer.on(APP_EVENT_CHANNEL, (_event, message: unknown) => {
      if (typeof message !== 'object' || message === null || !('type' in message)) {
        console.error('[piarc] ignored a malformed app event');
        return;
      }
      for (const each of appListeners) {
        try {
          each(message as AppEvent);
        } catch (error) {
          console.error('[piarc] app event listener threw', error);
        }
      }
    });
  }
  appListeners.add(listener);
  return () => {
    appListeners.delete(listener);
  };
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
  createTerminal: (size) =>
    ipcRenderer.invoke(IPC_CHANNELS.terminalCreate, size).then((value: unknown) => {
      if (typeof value !== 'number') {
        throw new TypeError('Unexpected IPC result: expected a terminal id');
      }
      return value;
    }),
  closeTerminal: async (id) => {
    await ipcRenderer.invoke(IPC_CHANNELS.terminalClose, id);
  },
  terminalInput: async (id, text) => {
    await ipcRenderer.invoke(IPC_CHANNELS.terminalInput, id, text);
  },
  terminalKey: async (id, key) => {
    await ipcRenderer.invoke(IPC_CHANNELS.terminalKey, id, key);
  },
  terminalResize: async (id, size) => {
    await ipcRenderer.invoke(IPC_CHANNELS.terminalResize, id, size);
  },
  requestTerminalFrame: (id, full) =>
    ipcRenderer.invoke(IPC_CHANNELS.terminalRequestFrame, id, full).then((value: unknown) => {
      if (!(value instanceof Uint8Array)) {
        throw new TypeError('Unexpected IPC result: expected the frame bytes');
      }
      return value;
    }),
  getAppState: () =>
    ipcRenderer.invoke(IPC_CHANNELS.appState).then((value: unknown) => expectAppState(value)),
  setPreference: (change) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.preferencesSet, change)
      .then((value: unknown) => expectPreferences(value)),
  onAppEvent,
  openSettings: async (page) => {
    await ipcRenderer.invoke(IPC_CHANNELS.settingsOpen, page);
  },
  chooseFolder: () =>
    ipcRenderer
      .invoke(IPC_CHANNELS.folderDialog)
      .then((value: unknown) => expectStringOrNull(value)),
  openWorkspace: (path) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.workspaceOpen, path)
      .then((value: unknown) => expectString(value)),
  createSession: (workspace) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionCreate, workspace)
      .then((value: unknown) => expectString(value)),
  resumeSession: (id) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionResume, id)
      .then((value: unknown) => expectString(value)),
  closeSession: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.sessionClose, id).then((value: unknown) => expectString(value)),
  prompt: (id, input) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionPrompt, id, input)
      .then((value: unknown) => expectString(value)),
  steer: (id, input) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionSteer, id, input)
      .then((value: unknown) => expectString(value)),
  followUp: (id, input) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionFollowUp, id, input)
      .then((value: unknown) => expectString(value)),
  abort: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.sessionAbort, id).then((value: unknown) => expectString(value)),
  setPermissionMode: async (id, mode) => {
    await ipcRenderer.invoke(IPC_CHANNELS.sessionPermissionMode, id, mode);
  },
  answerApproval: (answer) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.approvalAnswer, answer)
      .then((value: unknown) => expectString(value)),
  compact: (id) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionCompact, id)
      .then((value: unknown) => expectString(value)),
  editQueueItem: (id, itemId, text) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.queueEdit, id, itemId, text)
      .then((value: unknown) => expectString(value)),
  deleteQueueItem: (id, itemId) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.queueDelete, id, itemId)
      .then((value: unknown) => expectString(value)),
  storeAttachment: (id, name, mimeType, data) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.attachmentStore, id, name, mimeType, data)
      .then((value: unknown) => expectString(value)),
  searchFiles: (searchId, root, query, limit) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.filesSearch, searchId, root, query, limit)
      .then((value: unknown) => expectString(value)),
  cancelFileSearch: async (searchId) => {
    await ipcRenderer.invoke(IPC_CHANNELS.filesCancel, searchId);
  },
  composerInfo: () =>
    ipcRenderer.invoke(IPC_CHANNELS.composerInfo).then((value: unknown) => expectString(value)),
  markSessionRead: async (id) => {
    await ipcRenderer.invoke(IPC_CHANNELS.sessionMarkRead, id);
  },
  renameSession: async (id, title) => {
    await ipcRenderer.invoke(IPC_CHANNELS.sessionRename, id, title);
  },
  setSessionPinned: async (id, pinned) => {
    await ipcRenderer.invoke(IPC_CHANNELS.sessionSetPinned, id, pinned);
  },
  setSessionArchived: async (id, archived) => {
    await ipcRenderer.invoke(IPC_CHANNELS.sessionSetArchived, id, archived);
  },
  deleteSession: (id, title) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionDelete, id, title)
      .then((value: unknown) => expectBoolean(value)),
  transcriptWindow: (id, start, limit) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionTranscript, id, start, limit)
      .then((value: unknown) => expectString(value)),
  resendSnapshots: async () => {
    await ipcRenderer.invoke(IPC_CHANNELS.snapshotsResend);
  },
  projectTrust: (path) =>
    ipcRenderer.invoke(IPC_CHANNELS.trustGet, path).then((value: unknown) => expectString(value)),
  decideProjectTrust: (path, trusted) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.trustDecide, path, trusted)
      .then((value: unknown) => expectString(value)),
  notifyAttention: async (notice) => {
    await ipcRenderer.invoke(IPC_CHANNELS.attentionNotify, notice);
  },
  setAttentionCount: async (count) => {
    await ipcRenderer.invoke(IPC_CHANNELS.attentionCount, count);
  },
};

contextBridge.exposeInMainWorld('piarc', api);
