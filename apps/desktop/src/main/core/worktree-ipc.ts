// Worktree, search and window commands of `window.piarc` (T35). Archiving a session whose
// worktree has uncommitted changes, and removing a worktree the cleanup found changed, throw
// work away: the main process asks the user in a native dialog first, so a page cannot discard
// changes without the user's click there (architecture section 10.3).
import path from 'node:path';

import { BrowserWindow, dialog } from 'electron';

import { IPC_CHANNELS, isSessionId } from '../../shared/ipc.js';
import type { Translator } from '../../shared/i18n/index.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';

/** The part of Core these commands use. */
export type WorktreeCore = Pick<
  CoreRuntime,
  | 'setSessionArchived'
  | 'sessionWorktreeStatus'
  | 'removeSessionWorktree'
  | 'keepSessionWorktree'
  | 'worktreeBranches'
  | 'ignoreWorktrees'
  | 'searchSessions'
>;

/** Longest search query passed to Core (characters). */
export const MAX_SEARCH_QUERY = 200;

function sessionId(value: unknown): string {
  if (!isSessionId(value)) throw new TypeError('sessionId must be a session id');
  return value;
}

function workspace(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    !path.isAbsolute(value)
  ) {
    throw new TypeError('workspace must be an absolute path');
  }
  return value;
}

/** The worktree status Core reported, or `undefined` for a session without a worktree. */
export function worktreeChanges(
  text: string,
): { path: string; changes: number | null } | undefined {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null) return undefined;
  const status = value as Record<string, unknown>;
  return typeof status.path === 'string' &&
    (typeof status.changes === 'number' || status.changes === null)
    ? { path: status.path, changes: status.changes }
    : undefined;
}

async function ask(
  window: BrowserWindow | null,
  options: Electron.MessageBoxOptions,
): Promise<number> {
  const { response } =
    window === null
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(window, options);
  return response;
}

/**
 * Archives session `id` (or restores it). A worktree with uncommitted changes is asked about
 * first: keep it and archive, discard the changes and remove it, or cancel. Resolves whether
 * the session was archived (false: cancelled).
 */
async function archive(
  core: WorktreeCore,
  t: Translator,
  window: BrowserWindow | null,
  id: string,
): Promise<boolean> {
  let status: { path: string; changes: number | null } | undefined;
  try {
    status = worktreeChanges(await core.sessionWorktreeStatus(id));
  } catch {
    // No worktree (or none Core knows yet): nothing to ask.
    status = undefined;
  }
  let discard = false;
  if (status !== undefined && (status.changes === null || status.changes > 0)) {
    const response = await ask(window, {
      type: 'warning',
      message:
        status.changes === null
          ? t.t('dialog.archiveWorktree.uninspected')
          : t.t('dialog.archiveWorktree.message', { count: String(status.changes) }),
      detail: [status.path, t.t('dialog.archiveWorktree.detail')].join('\n'),
      buttons: [
        t.t('dialog.archiveWorktree.keep'),
        t.t('dialog.archiveWorktree.discard'),
        t.t('dialog.cancel'),
      ],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 2) return false;
    discard = response === 1;
  }
  await core.setSessionArchived(id, true);
  if (discard) await core.removeSessionWorktree(id, true);
  return true;
}

export function registerWorktreeHandlers(
  registerHandler: RegisterHandler,
  core: WorktreeCore,
  translator: () => Translator,
  openSessionWindow: (id: string) => void,
): void {
  registerHandler(IPC_CHANNELS.sessionSetArchived, async (event, [id, archived]) => {
    if (typeof archived !== 'boolean') throw new TypeError('archived must be a boolean');
    const target = sessionId(id);
    if (!archived) {
      await core.setSessionArchived(target, false);
      return true;
    }
    return archive(core, translator(), BrowserWindow.fromWebContents(event.sender), target);
  });
  registerHandler(IPC_CHANNELS.worktreeBranches, (_event, [dir]) =>
    core.worktreeBranches(workspace(dir)),
  );
  registerHandler(IPC_CHANNELS.worktreeIgnore, (_event, [dir]) =>
    core.ignoreWorktrees(workspace(dir)),
  );
  // The cleanup found uncommitted changes in an archived session's worktree: removing it
  // throws them away, so the user confirms here.
  registerHandler(IPC_CHANNELS.worktreeRemove, async (event, [id]) => {
    const target = sessionId(id);
    const status = worktreeChanges(await core.sessionWorktreeStatus(target));
    const t = translator();
    const response = await ask(BrowserWindow.fromWebContents(event.sender), {
      type: 'warning',
      message: t.t('dialog.removeWorktree.message'),
      detail: [status?.path ?? '', t.t('dialog.removeWorktree.detail')].filter(Boolean).join('\n'),
      buttons: [t.t('dialog.removeWorktree.confirm'), t.t('dialog.cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return false;
    await core.removeSessionWorktree(target, true);
    return true;
  });
  registerHandler(IPC_CHANNELS.worktreeKeep, async (_event, [id]) => {
    await core.keepSessionWorktree(sessionId(id));
  });
  registerHandler(IPC_CHANNELS.sessionSearch, (_event, [query]) => {
    if (typeof query !== 'string' || query.length === 0 || query.length > MAX_SEARCH_QUERY) {
      throw new TypeError(`query must be 1 to ${String(MAX_SEARCH_QUERY)} characters`);
    }
    return core.searchSessions(query);
  });
  registerHandler(IPC_CHANNELS.sessionOpenWindow, (_event, [id]) => {
    openSessionWindow(sessionId(id));
  });
}
