// Voice dictation commands (ADR-0094, ADR-0096; voice dictation addendum 4.8). The main process
// owns the operating system's microphone permission and the window a dictation belongs to:
// starting needs recent real input in a visible window and a granted permission (asked only
// after that click, never twice after a refusal); the window id comes from the sending page,
// never from its arguments; a dictation's events go to `dictation/<webContentsId>` and only that
// window may subscribe to it. The window closing, reloading or crashing releases its dictation;
// minimizing it, the system sleeping or the screen locking stops it, keeping its text.
import { BrowserWindow, powerMonitor, shell, systemPreferences } from 'electron';

import type { Translator } from '../../shared/i18n/index.js';
import { encodeIpcError } from '../../shared/ipc-error.js';
import { IPC_CHANNELS } from '../../shared/ipc.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';
import type { NativeConfirm } from './plugins-ipc.js';

/** The part of Core these commands use. */
export type DictationCore = Pick<
  CoreRuntime,
  | 'dictationStart'
  | 'dictationStop'
  | 'dictationCancel'
  | 'dictationRelease'
  | 'dictationStatus'
  | 'speechDevices'
  | 'speechModels'
  | 'speechModelAction'
>;

/** The speech models a page may act on (`piarc_speech::models`). */
const MODEL_IDS = ['x-asr-zh-en-480ms-int8', 'qwen3-asr-0.6b-int8'] as const;
const MODEL_ACTIONS = ['download', 'cancel', 'delete', 'verify'] as const;

/** `[modelId, action]` of a model action, checked against the known values. */
export function modelAction(
  modelId: unknown,
  action: unknown,
): [(typeof MODEL_IDS)[number], (typeof MODEL_ACTIONS)[number]] {
  const id = MODEL_IDS.find((known) => known === modelId);
  if (id === undefined) throw new TypeError('modelId must be a known speech model');
  const known = MODEL_ACTIONS.find((a) => a === action);
  if (known === undefined) {
    throw new TypeError("action must be 'download', 'cancel', 'delete' or 'verify'");
  }
  return [id, known];
}

/** Real input in the window within a few seconds (`TerminalOwners`). */
export interface DictationInputGuard {
  requireInput(contents: Electron.WebContents): void;
}

/** The operating system's microphone permission for this app. */
export type MicrophoneAccess = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

/** Reads and requests the microphone permission; L4 replaces it. */
export interface MicrophonePermission {
  status(): MicrophoneAccess;
  /** Shows the system's request (macOS); whether access is granted afterwards. */
  request(): Promise<boolean>;
}

/** macOS: the TCC state and request; Windows: the privacy setting (no request API). */
export const SYSTEM_MICROPHONE: MicrophonePermission = {
  status() {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return 'granted';
    return systemPreferences.getMediaAccessStatus('microphone');
  },
  request() {
    if (process.platform === 'darwin') return systemPreferences.askForMediaAccess('microphone');
    return Promise.resolve(SYSTEM_MICROPHONE.status() === 'granted');
  },
};

/** The system settings page of the microphone privacy setting (fixed, never from a page). */
export function microphoneSettingsUrl(platform: NodeJS.Platform): string | undefined {
  if (platform === 'darwin') {
    return 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
  }
  if (platform === 'win32') return 'ms-settings:privacy-microphone';
  return undefined;
}

const MAX_PATH = 4096;
const MAX_COMPOSER = 4200;
const DICTATION_ROUTE = /^dictation\/(\d{1,15})$/u;
const SESSION_ID = /^dictation-\d{1,16}$/u;

/** Whether window `windowId` may subscribe to `route`: a dictation route only its own. */
export function mayObserveDictation(windowId: number, route: string): boolean {
  const match = DICTATION_ROUTE.exec(route);
  if (match === null) return !route.startsWith('dictation/');
  return Number(match[1]) === windowId;
}

/** The route of window `windowId`'s dictation events. */
export function dictationRoute(windowId: number): string {
  return `dictation/${String(windowId)}`;
}

function hasControl(text: string): boolean {
  // eslint-disable-next-line no-control-regex -- control characters are what this rejects
  return /[\u0000-\u001f\u007f‪-‮⁦-⁩]/u.test(text);
}

/** The `{ composer, workspace?, test? }` of a start, rebuilt from known members only. */
export function startRequest(raw: unknown): {
  composer: string;
  workspace?: string;
  test: boolean;
} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('request must be an object');
  }
  const { composer, workspace, test } = raw as Record<string, unknown>;
  if (
    typeof composer !== 'string' ||
    composer.length === 0 ||
    composer.length > MAX_COMPOSER ||
    !/^(session|workspace|settings):/u.test(composer) ||
    hasControl(composer)
  ) {
    throw new TypeError('composer must be session:<id>, workspace:<path> or settings:');
  }
  if (
    workspace !== undefined &&
    (typeof workspace !== 'string' ||
      workspace.length === 0 ||
      workspace.length > MAX_PATH ||
      hasControl(workspace) ||
      !(workspace.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(workspace)))
  ) {
    throw new TypeError('workspace must be an absolute path');
  }
  if (test !== undefined && typeof test !== 'boolean') {
    throw new TypeError('test must be a boolean');
  }
  return {
    composer,
    ...(typeof workspace === 'string' ? { workspace } : {}),
    test: test === true,
  };
}

function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) {
    throw new TypeError('sessionId must be a dictation session id');
  }
  return value;
}

function stopMode(value: unknown): 'keep' | 'send' {
  if (value !== 'keep' && value !== 'send') {
    throw new TypeError("mode must be 'keep' or 'send'");
  }
  return value;
}

/** A refusal the page reads back as `speech:<code>` (`shared/speech-errors.ts`). */
function speechFailure(kind: string, code: string): Error {
  return new Error(encodeIpcError(kind, `speech:${code}`));
}

/** The speech code of a Core error (`details.speech`), written for the page. */
function forPage(error: unknown): unknown {
  if (!(error instanceof Error) || !('data' in error)) return error;
  const { data } = error;
  if (typeof data !== 'object' || data === null) return error;
  const kind = 'kind' in data && typeof data.kind === 'string' ? data.kind : 'internalError';
  const details = 'details' in data ? data.details : undefined;
  const code =
    typeof details === 'object' && details !== null && 'speech' in details
      ? details.speech
      : undefined;
  return typeof code === 'string' && /^[A-Za-z]{1,64}$/u.test(code)
    ? speechFailure(kind, code)
    : error;
}

async function guarded<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    throw forPage(error);
  }
}

/** The owner of the running dictation, from Core's status. */
function ownerOf(core: DictationCore): { window: number; session: string } | undefined {
  try {
    const status: unknown = JSON.parse(core.dictationStatus());
    if (typeof status !== 'object' || status === null) return undefined;
    const { windowId, sessionId: session } = status as Record<string, unknown>;
    return typeof windowId === 'number' && typeof session === 'string'
      ? { window: windowId, session }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Stops the running dictation of window `windowId`, keeping its text. */
function stopWindow(core: DictationCore, windowId?: number): void {
  const owner = ownerOf(core);
  if (owner === undefined || (windowId !== undefined && owner.window !== windowId)) return;
  try {
    core.dictationStop(owner.window, owner.session, 'keep');
  } catch {
    // Already ended.
  }
}

/** Watches a window's lifecycle once: gone releases, minimized stops. */
function watch(
  core: DictationCore,
  contents: Electron.WebContents,
  watched: WeakSet<object>,
): void {
  if (watched.has(contents)) return;
  watched.add(contents);
  const id = contents.id;
  const release = () => {
    core.dictationRelease(id);
  };
  contents.once('destroyed', release);
  contents.on('render-process-gone', release);
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) release();
  });
  const window = BrowserWindow.fromWebContents(contents);
  window?.on('minimize', () => {
    stopWindow(core, id);
  });
  window?.on('hide', () => {
    stopWindow(core, id);
  });
}

/** Throws `speech:noRecentInput` unless the window had real input lately. */
function requireInput(input: DictationInputGuard, contents: Electron.WebContents): void {
  try {
    input.requireInput(contents);
  } catch {
    throw speechFailure('permissionDenied', 'noRecentInput');
  }
}

/** Registers the dictation commands and the system sleep and lock hooks. */
export function registerDictationHandlers(
  registerHandler: RegisterHandler,
  core: DictationCore,
  input: DictationInputGuard,
  permission: () => MicrophonePermission,
  confirm: NativeConfirm,
  translator: () => Translator,
): void {
  const watched = new WeakSet<object>();
  powerMonitor.on('suspend', () => {
    stopWindow(core);
  });
  powerMonitor.on('lock-screen', () => {
    stopWindow(core);
  });

  registerHandler(IPC_CHANNELS.dictationStart, (event, [raw]) =>
    guarded(async () => {
      const request = startRequest(raw);
      requireInput(input, event.sender);
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window === null || !window.isVisible() || window.isMinimized()) {
        throw speechFailure('permissionDenied', 'windowHidden');
      }
      const microphone = permission();
      const state = microphone.status();
      if (state === 'denied' || state === 'restricted') {
        throw speechFailure('permissionDenied', 'microphoneDenied');
      }
      if (state !== 'granted' && !(await microphone.request())) {
        throw speechFailure('permissionDenied', 'microphoneDenied');
      }
      watch(core, event.sender, watched);
      return core.dictationStart(JSON.stringify({ ...request, windowId: event.sender.id }));
    }),
  );
  registerHandler(IPC_CHANNELS.dictationStop, (event, [id, mode]) =>
    guarded(() => {
      core.dictationStop(event.sender.id, sessionId(id), stopMode(mode));
    }),
  );
  registerHandler(IPC_CHANNELS.dictationCancel, (event, [id]) =>
    guarded(() => {
      core.dictationCancel(event.sender.id, sessionId(id));
    }),
  );
  registerHandler(IPC_CHANNELS.dictationStatus, (event) => {
    const status: unknown = JSON.parse(core.dictationStatus());
    const fields = typeof status === 'object' && status !== null ? status : {};
    return JSON.stringify({
      ...fields,
      route: dictationRoute(event.sender.id),
      mine: 'windowId' in fields && fields.windowId === event.sender.id,
      microphone: permission().status(),
    });
  });
  registerHandler(IPC_CHANNELS.speechDevices, () => guarded(() => core.speechDevices()));
  registerHandler(IPC_CHANNELS.speechModels, () => guarded(() => core.speechModels()));
  registerHandler(IPC_CHANNELS.speechModelAction, (event, [rawId, rawAction]) =>
    guarded(async () => {
      const [id, action] = modelAction(rawId, rawAction);
      if (action === 'download' || action === 'delete') requireInput(input, event.sender);
      if (action === 'delete') {
        const t = translator();
        const confirmed = await confirm.ask(
          BrowserWindow.fromWebContents(event.sender),
          {
            message: t.t('settings.voice.deleteConfirm'),
            detail: t.t('settings.voice.deleteConfirmDetail'),
          },
          [t.t('settings.voice.deleteButton'), t.t('dialog.cancel')],
        );
        if (!confirmed) return core.speechModels();
      }
      return core.speechModelAction(id, action);
    }),
  );
  registerHandler(IPC_CHANNELS.openMicrophoneSettings, async () => {
    const url = microphoneSettingsUrl(process.platform);
    if (url !== undefined) await shell.openExternal(url);
  });
  registerHandler(IPC_CHANNELS.focusDictationOwner, () => {
    const owner = ownerOf(core);
    if (owner === undefined) return;
    const window = BrowserWindow.getAllWindows().find((w) => w.webContents.id === owner.window);
    if (window !== undefined) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
}
