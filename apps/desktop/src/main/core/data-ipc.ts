// Data management (settings): archiving, restoring or deleting many sessions at once, and the
// data export. Archiving and deleting confirm in a native dialog that lists the sessions from
// Core's index, so a page cannot discard history without the user's click there; the export is
// written only to the place the user picked in the native save dialog, and only that file can
// be revealed afterwards (architecture section 10.3).
import path from 'node:path';

import { app, BrowserWindow, dialog, shell, type WebContents } from 'electron';

import { IPC_CHANNELS, isSessionId } from '../../shared/ipc.js';
import type { Translator } from '../../shared/i18n/index.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';

/** The part of Core these commands use. */
export type DataCore = Pick<
  CoreRuntime,
  'setSessionArchived' | 'deleteSession' | 'sessionDeletionTarget' | 'exportSessions'
>;

export type BulkOp = 'archive' | 'unarchive' | 'delete';

/** Most sessions one bulk command takes. */
export const MAX_BULK = 10_000;
/** Titles the confirmation lists before "and N more". */
const LISTED = 8;

/** The native dialogs these commands show; replaced in tests. */
export interface DataDialogs {
  /** The button the user chose (`buttons` index). */
  ask(sender: WebContents, options: Electron.MessageBoxOptions): Promise<number>;
  /** The path the user chose for the export (offered as `fileName` in Downloads), or null. */
  savePath(sender: WebContents, title: string, fileName: string): Promise<string | null>;
  /** Shows `file` in the system's file manager. */
  reveal(file: string): void;
}

export const electronDataDialogs: DataDialogs = {
  async ask(sender, options) {
    const window = BrowserWindow.fromWebContents(sender);
    const { response } =
      window === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(window, options);
    return response;
  },
  async savePath(sender, title, fileName) {
    const window = BrowserWindow.fromWebContents(sender);
    const options = {
      title,
      defaultPath: path.join(app.getPath('downloads'), fileName),
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    };
    const result =
      window === null
        ? await dialog.showSaveDialog(options)
        : await dialog.showSaveDialog(window, options);
    return result.canceled || result.filePath === '' ? null : result.filePath;
  },
  reveal(file) {
    shell.showItemInFolder(file);
  },
};

export function bulkOp(value: unknown): BulkOp {
  if (value !== 'archive' && value !== 'unarchive' && value !== 'delete') {
    throw new TypeError('op must be archive, unarchive or delete');
  }
  return value;
}

export function sessionIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BULK) {
    throw new TypeError(`ids must be 1 to ${String(MAX_BULK)} session ids`);
  }
  const ids = value.map((id) => {
    if (!isSessionId(id)) throw new TypeError('ids must be session ids');
    return id;
  });
  return [...new Set(ids)];
}

/** `piarc-export-YYYYMMDD-HHMM.zip` at the local time `now`. */
export function exportFileName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `piarc-export-${stamp}.zip`;
}

/** The Markdown's words in the interface language, and the local clock's offset. */
export function exportLabels(t: Translator, now: Date): string {
  return JSON.stringify({
    user: t.t('export.label.user'),
    assistant: t.t('export.label.assistant'),
    tool: t.t('export.label.tool'),
    summary: t.t('export.label.summary'),
    project: t.t('export.label.project'),
    created: t.t('export.label.created'),
    updated: t.t('export.label.updated'),
    archived: t.t('export.label.archived'),
    untitled: t.t('session.untitled'),
    offsetMinutes: -now.getTimezoneOffset(),
  });
}

/** The confirmation's list: the recorded titles of the first sessions, then how many more. */
async function listed(core: DataCore, t: Translator, ids: readonly string[]): Promise<string> {
  const lines = await Promise.all(
    ids.slice(0, LISTED).map(async (id) => {
      try {
        const details: unknown = JSON.parse(await core.sessionDeletionTarget(id));
        const title =
          typeof details === 'object' &&
          details !== null &&
          'title' in details &&
          typeof details.title === 'string'
            ? details.title
            : '';
        return `• ${title || t.t('session.untitled')}`;
      } catch {
        return `• ${id}`;
      }
    }),
  );
  if (ids.length > LISTED) {
    lines.push(t.t('dialog.bulk.more', { count: ids.length - LISTED }));
  }
  return lines.join('\n');
}

async function confirm(
  core: DataCore,
  t: Translator,
  dialogs: DataDialogs,
  sender: WebContents,
  op: BulkOp,
  ids: readonly string[],
): Promise<boolean> {
  if (op === 'unarchive') return true;
  const deleting = op === 'delete';
  const response = await dialogs.ask(sender, {
    type: deleting ? 'warning' : 'question',
    message: t.t(deleting ? 'dialog.bulkDelete.message' : 'dialog.bulkArchive.message', {
      count: ids.length,
    }),
    detail: [
      await listed(core, t, ids),
      '',
      t.t(deleting ? 'dialog.bulkDelete.detail' : 'dialog.bulkArchive.detail'),
    ].join('\n'),
    buttons: [
      t.t(deleting ? 'dialog.bulkDelete.confirm' : 'dialog.bulkArchive.confirm'),
      t.t('dialog.cancel'),
    ],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
}

/** Registers the data management commands. */
export function registerDataHandlers(
  registerHandler: RegisterHandler,
  core: DataCore,
  translator: () => Translator,
  dialogs: DataDialogs = electronDataDialogs,
): void {
  let exported: string | null = null;
  registerHandler(IPC_CHANNELS.sessionsBulk, async (event, [opArg, idsArg]) => {
    const op = bulkOp(opArg);
    const ids = sessionIds(idsArg);
    const t = translator();
    if (!(await confirm(core, t, dialogs, event.sender, op, ids))) return null;
    let done = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        if (op === 'delete') await core.deleteSession(id);
        else await core.setSessionArchived(id, op === 'archive');
        done++;
      } catch (error) {
        failed++;
        console.warn(`[data] ${op} of a session failed`, error);
      }
    }
    return { done, failed };
  });
  registerHandler(IPC_CHANNELS.dataExport, async (event) => {
    const t = translator();
    const now = new Date();
    const target = await dialogs.savePath(
      event.sender,
      t.t('dialog.export.title'),
      exportFileName(now),
    );
    if (target === null) return null;
    const answer = await core.exportSessions(target, exportLabels(t, now));
    exported = target;
    return answer;
  });
  registerHandler(IPC_CHANNELS.dataExportReveal, () => {
    if (exported === null) return false;
    dialogs.reveal(exported);
    return true;
  });
}
