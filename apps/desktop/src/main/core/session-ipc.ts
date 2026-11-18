// The session, workspace and trust commands of `window.piarc` (T18): each validates its
// arguments (they come from the renderer) and calls Core. Results are Core's JSON text, passed
// through unread (the renderer validates them). Deleting a session is irreversible, so the
// main process asks the user in a native dialog before it calls Core (architecture section
// 10.3): a page cannot delete a session without the user's click in that dialog.
import path from 'node:path';

import { BrowserWindow, dialog } from 'electron';

import { IPC_CHANNELS, MAX_PROMPT_LENGTH, isSessionId } from '../../shared/ipc.js';
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
  | 'markSessionRead'
  | 'renameSession'
  | 'setSessionPinned'
  | 'setSessionArchived'
  | 'deleteSession'
  | 'resendSnapshots'
  | 'projectTrust'
  | 'decideProjectTrust'
>;

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

/** Registers the session, workspace and trust commands. */
export function registerSessionHandlers(
  registerHandler: RegisterHandler,
  core: SessionCore,
  translator: () => Translator,
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
  registerHandler(IPC_CHANNELS.sessionCreate, (_event, [workspace]) =>
    core.createSession(absolutePath(workspace), null),
  );
  registerHandler(IPC_CHANNELS.sessionResume, (_event, [id]) => core.resumeSession(sessionId(id)));
  registerHandler(IPC_CHANNELS.sessionClose, (_event, [id]) => core.closeSession(sessionId(id)));
  registerHandler(IPC_CHANNELS.sessionPrompt, (_event, [id, text]) => {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_PROMPT_LENGTH) {
      throw new TypeError('text must be a non-empty string');
    }
    return core.prompt(sessionId(id), text);
  });
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
  registerHandler(IPC_CHANNELS.snapshotsResend, () => {
    core.resendSnapshots();
  });
  registerHandler(IPC_CHANNELS.trustGet, (_event, [dir]) => core.projectTrust(absolutePath(dir)));
  registerHandler(IPC_CHANNELS.trustDecide, (_event, [dir, trusted]) =>
    core.decideProjectTrust(absolutePath(dir), flag(trusted, 'trusted')),
  );
}
