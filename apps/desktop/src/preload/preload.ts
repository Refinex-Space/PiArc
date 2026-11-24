// Sandboxed preload (Electron 45): only `require('electron')` is available, so this file
// imports nothing else at runtime. It exposes the `window.piarc` allowlist and never
// `ipcRenderer` itself (Electron security checklist item 20). Event listeners receive the
// batch only, never an Electron event object.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

import {
  APP_EVENT_CHANNEL,
  EVENTS_PORT_CHANNEL,
  IPC_CHANNELS,
  type AppEvent,
  type AppState,
  type EventBatch,
  type EventListener,
  type LaunchTarget,
  type PiarcApi,
} from '../shared/ipc.js';
import type { Preferences } from '../shared/preferences.js';
import {
  isPasteOutcome,
  terminalInfoOf,
  terminalLinkOf,
  terminalMatchesOf,
  terminalOpenedOf,
} from '../shared/terminal-results.js';

/** `value` checked by `check`, or a TypeError naming `what`. */
function expectShape<T>(value: unknown, check: (value: unknown) => T | undefined, what: string): T {
  const checked = check(value);
  if (checked === undefined) {
    throw new TypeError(`Unexpected IPC result: expected ${what}`);
  }
  return checked;
}

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

function launchTargetsOf(value: unknown): LaunchTarget[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const targets: LaunchTarget[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) return undefined;
    const target = item as Record<string, unknown>;
    if (target.kind === 'workspace' && typeof target.path === 'string') {
      targets.push({ kind: 'workspace', path: target.path });
    } else if (
      target.kind === 'draft' &&
      typeof target.path === 'string' &&
      typeof target.text === 'string'
    ) {
      targets.push({ kind: 'draft', path: target.path, text: target.text });
    } else if (
      target.kind === 'settings' &&
      (target.page === undefined || typeof target.page === 'string')
    ) {
      targets.push(
        target.page === undefined ? { kind: 'settings' } : { kind: 'settings', page: target.page },
      );
    } else if (target.kind === 'newSession' || target.kind === 'chooseFolder') {
      targets.push({ kind: target.kind });
    } else if (target.kind === 'session' && typeof target.sessionId === 'string') {
      targets.push({ kind: 'session', sessionId: target.sessionId });
    } else {
      return undefined;
    }
  }
  return targets;
}

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
  prepareToolWindow: (sessionId, panelId) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.toolWindowPrepare, sessionId, panelId)
      .then((value: unknown) => expectString(value)),
  pinToolWindow: async (ticket, pinned) => {
    await ipcRenderer.invoke(IPC_CHANNELS.toolWindowPin, ticket, pinned);
  },
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
  openSessionTerminal: (sessionId, size) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.terminalOpenSession, sessionId, size)
      .then((value: unknown) => expectShape(value, terminalOpenedOf, 'an opened terminal')),
  shareTerminal: (id, shared) =>
    ipcRenderer.invoke(IPC_CHANNELS.terminalShare, id, shared).then(expectBoolean),
  closeTerminal: async (id) => {
    await ipcRenderer.invoke(IPC_CHANNELS.terminalClose, id);
  },
  terminalInput: async (id, text) => {
    await ipcRenderer.invoke(IPC_CHANNELS.terminalInput, id, text);
  },
  terminalKey: async (id, key) => {
    await ipcRenderer.invoke(IPC_CHANNELS.terminalKey, id, key);
  },
  terminalMouse: async (id, event) => {
    await ipcRenderer.invoke(IPC_CHANNELS.terminalMouse, id, event);
  },
  terminalFocus: async (id, gained) => {
    await ipcRenderer.invoke(IPC_CHANNELS.terminalFocus, id, gained);
  },
  terminalPaste: (id, text, allowUnsafe) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.terminalPaste, id, text, allowUnsafe)
      .then((value: unknown) =>
        expectShape(value, (v) => (isPasteOutcome(v) ? v : undefined), 'a paste outcome'),
      ),
  terminalResize: async (id, size) => {
    await ipcRenderer.invoke(IPC_CHANNELS.terminalResize, id, size);
  },
  requestTerminalFrame: (id, full, park) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.terminalRequestFrame, id, full, park === true)
      .then((value: unknown) => {
        if (!(value instanceof Uint8Array)) {
          throw new TypeError('Unexpected IPC result: expected the frame bytes');
        }
        return value;
      }),
  terminalScroll: async (id, to) => {
    await ipcRenderer.invoke(IPC_CHANNELS.terminalScroll, id, to);
  },
  terminalColors: async (id, colors) => {
    await ipcRenderer.invoke(IPC_CHANNELS.terminalColors, id, colors);
  },
  terminalClearSelection: async (id) => {
    await ipcRenderer.invoke(IPC_CHANNELS.terminalClearSelection, id);
  },
  terminalSelectionText: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.terminalSelectionText, id).then(expectString),
  terminalLinkAt: (id, col, row) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.terminalLinkAt, id, col, row)
      .then((value: unknown) => expectShape(value, terminalLinkOf, 'a terminal link')),
  terminalSearch: (id, query) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.terminalSearch, id, query)
      .then((value: unknown) => expectShape(value, terminalMatchesOf, 'search matches')),
  terminalScreenText: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.terminalScreenText, id).then(expectString),
  terminalInfo: (id) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.terminalInfo, id)
      .then((value: unknown) => expectShape(value, terminalInfoOf, 'terminal information')),
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
  createSession: (workspace, model, worktree) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionCreate, workspace, model, worktree)
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
  askSideChat: (session, panel, question) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sideChatAsk, session, panel, question)
      .then((value: unknown) => expectString(value)),
  controlSideChat: async (session, panel, close) => {
    await ipcRenderer.invoke(IPC_CHANNELS.sideChatControl, session, panel, close);
  },
  setPermissionMode: async (id, mode) => {
    await ipcRenderer.invoke(IPC_CHANNELS.sessionPermissionMode, id, mode);
  },
  answerApproval: (answer) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.approvalAnswer, answer)
      .then((value: unknown) => expectString(value)),
  compact: (id, instructions) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionCompact, id, instructions)
      .then((value: unknown) => expectString(value)),
  contextUsage: (id) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionContextUsage, id)
      .then((value: unknown) => expectString(value)),
  rewindPreview: (id, turnId) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionRewindPreview, id, turnId)
      .then((value: unknown) => expectString(value)),
  rewind: (id, request) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionRewind, id, request)
      .then((value: unknown) => expectString(value)),
  undoRewind: (id, restoreId) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionUndoRewind, id, restoreId)
      .then((value: unknown) => expectString(value)),
  sessionChanges: (id, path) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionChanges, id, path)
      .then((value: unknown) => expectString(value)),
  discardChange: (id, request) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionDiscardChange, id, request)
      .then((value: unknown) => expectString(value)),
  switchBranch: (id, entryId) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionSwitchBranch, id, entryId)
      .then((value: unknown) => expectString(value)),
  forkSession: (id, beforeTurn) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionFork, id, beforeTurn)
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
  permissionRules: (workspace) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.permissionRules, workspace)
      .then((v: unknown) => expectString(v)),
  checkPermissionRule: (rule, behavior) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.permissionCheck, rule, behavior)
      .then((v: unknown) => expectString(v)),
  updatePermissionRule: (change) =>
    ipcRenderer.invoke(IPC_CHANNELS.permissionUpdate, change).then((v: unknown) => expectString(v)),
  auditEvents: (query) =>
    ipcRenderer.invoke(IPC_CHANNELS.auditEvents, query).then((v: unknown) => expectString(v)),
  sandboxSettings: (workspace) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sandboxSettings, workspace)
      .then((v: unknown) => expectString(v)),
  setSandboxSettings: (workspace, change) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sandboxUpdate, workspace, change)
      .then((v: unknown) => expectString(v)),
  configDiagnostics: (workspace) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.configDiagnostics, workspace)
      .then((v: unknown) => expectString(v)),
  prepareDiagnostics: (workspace) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.diagnosticsPrepare, workspace)
      .then((v: unknown) => expectString(v)),
  exportDiagnostics: (id) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.diagnosticsExport, id)
      .then((v: unknown) => expectStringOrNull(v)),
  providerSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.providerSettings).then((v: unknown) => expectString(v)),
  saveProvider: (config, secret) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.saveProvider, config, secret)
      .then((v: unknown) => expectString(v)),
  deleteProvider: (id) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.deleteProvider, id)
      .then((v: unknown) => (v === null ? null : expectString(v))),
  setCatalogRefresh: (enabled) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.setCatalogRefresh, enabled)
      .then((v: unknown) => expectString(v)),
  setModelPreferences: (preferences) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.setModelPreferences, preferences)
      .then((v: unknown) => expectString(v)),
  startLogin: (provider) =>
    ipcRenderer.invoke(IPC_CHANNELS.startLogin, provider).then((v: unknown) => expectString(v)),
  answerLogin: (loginId, value) =>
    ipcRenderer.invoke(IPC_CHANNELS.answerLogin, loginId, value).then(() => undefined),
  logoutProvider: (provider) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.logoutProvider, provider)
      .then((v: unknown) => (v === null ? null : expectString(v))),
  workspaceModels: (workspace) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.workspaceModels, workspace)
      .then((v: unknown) => expectString(v)),
  sessionModels: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.sessionModels, id).then((v: unknown) => expectString(v)),
  previewModelSwitch: (id, provider, model) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.previewModelSwitch, id, provider, model)
      .then((v: unknown) => expectString(v)),
  setSessionModel: (id, provider, model, effort) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.setSessionModel, id, provider, model, effort)
      .then((v: unknown) => expectString(v)),
  setSessionEffort: (id, effort) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.setSessionEffort, id, effort)
      .then((v: unknown) => expectString(v)),
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
  setSessionArchived: (id, archived) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionSetArchived, id, archived)
      .then((value: unknown) => expectBoolean(value)),
  deleteSession: (id, title) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionDelete, id, title)
      .then((value: unknown) => expectBoolean(value)),
  transcriptWindow: (id, start, limit) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionTranscript, id, start, limit)
      .then((value: unknown) => expectString(value)),
  subagentTranscript: (parent, child, start, limit) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.subagentTranscript, parent, child, start, limit)
      .then((value: unknown) => expectString(value)),
  stopSubagent: (parent, child) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.subagentStop, parent, child)
      .then((value: unknown) => expectString(value)),
  stopTask: (taskId) =>
    ipcRenderer.invoke(IPC_CHANNELS.taskStop, taskId).then((value: unknown) => expectString(value)),
  readTaskOutput: (taskId, offset, length) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.taskOutput, taskId, offset, length)
      .then((value: unknown) => expectString(value)),
  mcpStatus: (workspace) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.mcpStatus, workspace)
      .then((value: unknown) => expectString(value)),
  mcpReconnect: (workspace, name) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.mcpReconnect, workspace, name)
      .then((value: unknown) => expectString(value)),
  mcpSetEnabled: (workspace, name, enabled) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.mcpSetEnabled, workspace, name, enabled)
      .then((value: unknown) => expectString(value)),
  mcpLogin: (workspace, name) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.mcpLogin, workspace, name)
      .then((value: unknown) => expectString(value)),
  listAgents: (workspace) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.agentsList, workspace)
      .then((value: unknown) => expectString(value)),
  listCommands: (workspace, cwd) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.commandsList, workspace, cwd)
      .then((value: unknown) => expectString(value)),
  listSkills: (workspace) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.skillsList, workspace)
      .then((value: unknown) => expectString(value)),
  listPackages: (workspace) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.packagesList, workspace)
      .then((value: unknown) => expectString(value)),
  installPackage: (input) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.packageInstall, input)
      .then((value: unknown) => expectString(value)),
  updatePackage: (id, workspace) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.packageUpdate, id, workspace)
      .then((value: unknown) => expectString(value)),
  setPackageEnabled: (id, enabled, scope, workspace) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.packageEnable, id, enabled, scope, workspace)
      .then((value: unknown) => expectString(value)),
  confirmPackage: (id, workspace) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.packageConfirm, id, workspace)
      .then((value: unknown) => expectString(value)),
  uninstallPackage: (id, workspace) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.packageUninstall, id, workspace)
      .then((value: unknown) => expectString(value)),
  setOutputStyle: async (workspace, name) => {
    await ipcRenderer.invoke(IPC_CHANNELS.outputStyleSet, workspace, name);
  },
  usageReport: (workspace) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.usageReport, workspace)
      .then((value: unknown) => expectString(value)),
  sessionUsage: (sessionId) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionUsage, sessionId)
      .then((value: unknown) => expectString(value)),
  setModelPrice: async (provider, model, price) => {
    await ipcRenderer.invoke(IPC_CHANNELS.modelPriceSet, provider, model, price);
  },
  webSearchSettings: () =>
    ipcRenderer
      .invoke(IPC_CHANNELS.webSearchSettings)
      .then((value: unknown) => expectString(value)),
  setWebSearchBackend: async (backend) => {
    await ipcRenderer.invoke(IPC_CHANNELS.webSearchBackendSet, backend);
  },
  setWebSearchKey: async (backend, key) => {
    await ipcRenderer.invoke(IPC_CHANNELS.webSearchKeySet, backend, key);
  },
  managedSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.managedSettings).then((value: unknown) => expectString(value)),
  memoryView: (workspace) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.memoryView, workspace)
      .then((value: unknown) => expectString(value)),
  memoryEdit: (workspace, edit) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.memoryEdit, workspace, edit)
      .then((value: unknown) => expectString(value)),
  revealMemory: async (workspace) => {
    await ipcRenderer.invoke(IPC_CHANNELS.memoryReveal, workspace);
  },
  resendSnapshots: async () => {
    await ipcRenderer.invoke(IPC_CHANNELS.snapshotsResend);
  },
  projectTrust: (path) =>
    ipcRenderer.invoke(IPC_CHANNELS.trustGet, path).then((value: unknown) => expectString(value)),
  decideProjectTrust: (path, trusted, version) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.trustDecide, path, trusted, version)
      .then((value: unknown) => expectString(value)),
  worktreeBranches: (workspace) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.worktreeBranches, workspace)
      .then((value: unknown) => expectString(value)),
  ignoreWorktrees: (workspace) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.worktreeIgnore, workspace)
      .then((value: unknown) => expectString(value)),
  removeSessionWorktree: (id) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.worktreeRemove, id)
      .then((value: unknown) => expectBoolean(value)),
  keepSessionWorktree: async (id) => {
    await ipcRenderer.invoke(IPC_CHANNELS.worktreeKeep, id);
  },
  searchSessions: (query) =>
    ipcRenderer
      .invoke(IPC_CHANNELS.sessionSearch, query)
      .then((value: unknown) => expectString(value)),
  openSessionWindow: async (id) => {
    await ipcRenderer.invoke(IPC_CHANNELS.sessionOpenWindow, id);
  },
  takeLaunchTargets: () =>
    ipcRenderer
      .invoke(IPC_CHANNELS.launchTargets)
      .then((value: unknown) => expectShape(value, launchTargetsOf, 'launch targets')),
  // A file or folder dropped on the page: its path, for opening a dropped folder (T35).
  pathForFile: (file) =>
    webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]),
  notifyAttention: async (notice) => {
    await ipcRenderer.invoke(IPC_CHANNELS.attentionNotify, notice);
  },
  setAttentionCount: async (count) => {
    await ipcRenderer.invoke(IPC_CHANNELS.attentionCount, count);
  },
};

contextBridge.exposeInMainWorld('piarc', api);
