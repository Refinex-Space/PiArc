// The session, workspace, trust and composer commands of `window.piarc` (T18, T19): each
// validates its arguments (they come from the renderer) and calls Core. Results are Core's JSON text, passed
// through unread (the renderer validates them). Deleting a session is irreversible, so the
// main process asks the user in a native dialog before it calls Core (architecture section
// 10.3): a page cannot delete a session without the user's click in that dialog.
import path from 'node:path';

import { BrowserWindow, dialog } from 'electron';

import {
  IPC_CHANNELS,
  MAX_ATTACHMENT_IPC_BYTES,
  MAX_PROMPT_LENGTH,
  isSessionId,
} from '../../shared/ipc.js';
import type { Translator } from '../../shared/i18n/index.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';

/** The part of Core these commands use. */
export type SessionCore = Pick<
  CoreRuntime,
  | 'openWorkspace'
  | 'createSession'
  | 'resumeSession'
  | 'closeSession'
  | 'prompt'
  | 'promptInput'
  | 'steer'
  | 'steerInput'
  | 'followUp'
  | 'followUpInput'
  | 'abort'
  | 'compact'
  | 'editQueueItem'
  | 'deleteQueueItem'
  | 'storeAttachment'
  | 'searchFiles'
  | 'cancelFileSearch'
  | 'composerInfo'
  | 'markSessionRead'
  | 'renameSession'
  | 'setSessionPinned'
  | 'setSessionArchived'
  | 'deleteSession'
  | 'transcriptWindow'
  | 'resendSnapshots'
  | 'projectTrust'
  | 'decideProjectTrust'
>;

/**
 * Failures a test asks for (development builds' test hooks only): the next call on a channel
 * fails with the given message instead of reaching Core (T18-A07).
 */
export class FaultInjector {
  private readonly pending = new Map<string, string>();

  failNext(channel: string, message: string): void {
    this.pending.set(channel, message);
  }

  /** Throws the failure planned for `channel`, if any. */
  check(channel: string): void {
    const message = this.pending.get(channel);
    if (message !== undefined) {
      this.pending.delete(channel);
      throw new Error(message);
    }
  }
}

/** Longest session title, in characters (Core's limit). */
const MAX_TITLE = 200;

function sessionId(value: unknown): string {
  if (!isSessionId(value)) {
    throw new TypeError('sessionId must be a session id');
  }
  return value;
}

function absolutePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    !path.isAbsolute(value)
  ) {
    throw new TypeError('path must be an absolute path');
  }
  return value;
}

function flag(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name} must be a boolean`);
  }
  return value;
}

function title(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || Array.from(value).length > MAX_TITLE) {
    throw new TypeError(
      `title must be a string of at most ${String(MAX_TITLE)} characters, or null`,
    );
  }
  return value;
}

/** Ids the renderer chooses (request keys, queue items, searches): Core's key alphabet. */
function token(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
    throw new TypeError(`${name} must be 1 to 128 letters, digits, '.', '_', ':' or '-'`);
  }
  return value;
}

function text(value: unknown, name: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > MAX_PROMPT_LENGTH
  ) {
    throw new TypeError(`${name} must be a string of at most ${String(MAX_PROMPT_LENGTH)} units`);
  }
  return value;
}

function list(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new TypeError(`${name} must be an array of at most ${String(max)} entries`);
  }
  return value;
}

/**
 * The composer's input as JSON for Core: the shape is checked here (types and sizes), the
 * meaning (spans inside the text, attachments of this session) by Core.
 */
function input(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('input must be an object');
  }
  const fields = value as Record<string, unknown>;
  const message = {
    requestId: token(fields.requestId, 'requestId'),
    text: text(fields.text, 'text', true),
    mentions: list(fields.mentions, 'mentions', 100),
    attachments: list(fields.attachments, 'attachments', 10),
  };
  if (message.text.trim() === '' && message.attachments.length === 0) {
    throw new TypeError('input must have text or attachments');
  }
  return JSON.stringify(message);
}

/** Registers the session, workspace and trust commands. */
export function registerSessionHandlers(
  registerHandler: RegisterHandler,
  core: SessionCore,
  translator: () => Translator,
  faults: FaultInjector,
): void {
  registerHandler(IPC_CHANNELS.folderDialog, async (event) => {
    const t = translator();
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: t.t('dialog.openFolder.title'),
      buttonLabel: t.t('dialog.openFolder.button'),
      properties: ['openDirectory', 'createDirectory'],
    };
    const result =
      window === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  registerHandler(IPC_CHANNELS.workspaceOpen, (_event, [dir]) =>
    core.openWorkspace(absolutePath(dir)),
  );
  registerHandler(IPC_CHANNELS.sessionCreate, (_event, [workspace]) => {
    const dir = absolutePath(workspace);
    faults.check(IPC_CHANNELS.sessionCreate);
    return core.createSession(dir, null);
  });
  registerHandler(IPC_CHANNELS.sessionResume, (_event, [id]) => core.resumeSession(sessionId(id)));
  registerHandler(IPC_CHANNELS.sessionClose, (_event, [id]) => core.closeSession(sessionId(id)));
  registerHandler(IPC_CHANNELS.sessionPrompt, (_event, [id, message]) => {
    faults.check(IPC_CHANNELS.sessionPrompt);
    return typeof message === 'string'
      ? core.prompt(sessionId(id), text(message, 'text'))
      : core.promptInput(sessionId(id), input(message));
  });
  registerHandler(IPC_CHANNELS.sessionSteer, (_event, [id, message]) =>
    typeof message === 'string'
      ? core.steer(sessionId(id), text(message, 'text'))
      : core.steerInput(sessionId(id), input(message)),
  );
  registerHandler(IPC_CHANNELS.sessionFollowUp, (_event, [id, message]) =>
    typeof message === 'string'
      ? core.followUp(sessionId(id), text(message, 'text'))
      : core.followUpInput(sessionId(id), input(message)),
  );
  registerHandler(IPC_CHANNELS.sessionAbort, (_event, [id]) => core.abort(sessionId(id)));
  registerHandler(IPC_CHANNELS.sessionCompact, (_event, [id]) => core.compact(sessionId(id)));
  registerHandler(IPC_CHANNELS.queueEdit, (_event, [id, itemId, value]) =>
    core.editQueueItem(sessionId(id), token(itemId, 'itemId'), text(value, 'text')),
  );
  registerHandler(IPC_CHANNELS.queueDelete, (_event, [id, itemId]) =>
    core.deleteQueueItem(sessionId(id), token(itemId, 'itemId')),
  );
  registerHandler(IPC_CHANNELS.attachmentStore, (_event, [id, name, mimeType, data]) => {
    if (typeof name !== 'string' || name.length > 1024) {
      throw new TypeError('name must be a string of at most 1024 characters');
    }
    if (typeof mimeType !== 'string' || mimeType.length > 128) {
      throw new TypeError('mimeType must be a media type');
    }
    if (!(data instanceof Uint8Array) || data.byteLength > MAX_ATTACHMENT_IPC_BYTES) {
      throw new TypeError(
        `data must be at most ${String(MAX_ATTACHMENT_IPC_BYTES)} bytes in a Uint8Array`,
      );
    }
    return core.storeAttachment(sessionId(id), name, mimeType, data);
  });
  registerHandler(IPC_CHANNELS.filesSearch, (_event, [searchId, root, query, limit]) => {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError('limit must be an integer from 1 to 1000');
    }
    if (typeof query !== 'string' || query.length > 256) {
      throw new TypeError('query must be a string of at most 256 characters');
    }
    return core.searchFiles(token(searchId, 'searchId'), absolutePath(root), query, limit);
  });
  registerHandler(IPC_CHANNELS.filesCancel, (_event, [searchId]) => {
    core.cancelFileSearch(token(searchId, 'searchId'));
  });
  registerHandler(IPC_CHANNELS.composerInfo, () => core.composerInfo());
  registerHandler(IPC_CHANNELS.sessionMarkRead, async (_event, [id]) => {
    await core.markSessionRead(sessionId(id));
  });
  registerHandler(IPC_CHANNELS.sessionRename, async (_event, [id, value]) => {
    await core.renameSession(sessionId(id), title(value));
  });
  registerHandler(IPC_CHANNELS.sessionSetPinned, async (_event, [id, pinned]) => {
    await core.setSessionPinned(sessionId(id), flag(pinned, 'pinned'));
  });
  registerHandler(IPC_CHANNELS.sessionSetArchived, async (_event, [id, archived]) => {
    await core.setSessionArchived(sessionId(id), flag(archived, 'archived'));
  });
  registerHandler(IPC_CHANNELS.sessionDelete, async (event, [id, shown]) => {
    const target = sessionId(id);
    const name = title(shown) ?? target;
    const t = translator();
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      message: t.t('dialog.delete.message', { title: name }),
      detail: t.t('dialog.delete.detail'),
      buttons: [t.t('dialog.delete.confirm'), t.t('dialog.cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const { response } =
      window === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(window, options);
    if (response !== 0) {
      return false;
    }
    await core.deleteSession(target);
    return true;
  });
  registerHandler(IPC_CHANNELS.sessionTranscript, (_event, [id, start, limit]) => {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError('limit must be an integer from 1 to 1000');
    }
    if (start !== null && (typeof start !== 'number' || !Number.isInteger(start) || start < 0)) {
      throw new TypeError('start must be a non-negative integer or null');
    }
    return core.transcriptWindow(sessionId(id), start, limit);
  });
  registerHandler(IPC_CHANNELS.snapshotsResend, () => {
    core.resendSnapshots();
  });
  registerHandler(IPC_CHANNELS.trustGet, (_event, [dir]) => core.projectTrust(absolutePath(dir)));
  registerHandler(IPC_CHANNELS.trustDecide, (_event, [dir, trusted]) =>
    core.decideProjectTrust(absolutePath(dir), flag(trusted, 'trusted')),
  );
}
