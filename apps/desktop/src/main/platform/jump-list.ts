// Windows shell shortcuts use the same argv parser on cold start and in second-instance.
// Workspace snapshots are already in most-recently-opened order (Core's workspace table).
import path from 'node:path';
import { app, type JumpListCategory, type JumpListItem } from 'electron';

import type { Translator } from '../../shared/i18n/index.js';
import type { EventRouter } from '../core/router.js';
import { CHOOSE_FOLDER_ARGUMENT, NEW_SESSION_ARGUMENT } from '../launch.js';

interface RecentWorkspace {
  readonly path: string;
  readonly displayName: string;
}

/** Windows paths cannot contain a quote. Double trailing backslashes before a closing quote
 * so that CommandLineToArgvW receives the original path, including a drive root. */
function folderArgument(folder: string): string {
  return '"' + folder.replace(/(\\+)$/u, '$1$1') + '"';
}

export function jumpList(
  program: string,
  recent: readonly RecentWorkspace[],
  removed: readonly JumpListItem[],
  t: Translator,
): JumpListCategory[] {
  const task = (title: string, args: string): JumpListItem => ({
    type: 'task',
    program,
    args,
    iconPath: program,
    iconIndex: 0,
    title,
  });
  const removedArgs = new Set(removed.map((item) => item.args));
  const items: JumpListItem[] = [];
  for (const workspace of recent) {
    const args = folderArgument(workspace.path);
    if (!removedArgs.has(args)) items.push(task(workspace.displayName, args));
    if (items.length === 10) break;
  }
  const categories: JumpListCategory[] = [];
  if (items.length > 0) {
    categories.push({ type: 'custom', name: t.t('jumpList.recentWorkspaces'), items });
  }
  categories.push({
    type: 'tasks',
    items: [
      task(t.t('command.session.new'), NEW_SESSION_ARGUMENT),
      task(t.t('dialog.openFolder.title'), CHOOSE_FOLDER_ARGUMENT),
    ],
  });
  return categories;
}

/** Empty arrays clear removed workspaces. Malformed snapshots leave the last list intact. */
export function recentWorkspaces(payload: Uint8Array): RecentWorkspace[] | undefined {
  const events: unknown = JSON.parse(new TextDecoder().decode(payload));
  const last: unknown = Array.isArray(events) ? events.at(-1) : undefined;
  if (
    !last ||
    typeof last !== 'object' ||
    !('workspaces' in last) ||
    !Array.isArray(last.workspaces)
  ) {
    return undefined;
  }
  const rows: RecentWorkspace[] = [];
  for (const row of last.workspaces as unknown[]) {
    if (
      row &&
      typeof row === 'object' &&
      'path' in row &&
      typeof row.path === 'string' &&
      path.win32.isAbsolute(row.path) &&
      !row.path.includes('"') &&
      'displayName' in row &&
      typeof row.displayName === 'string'
    )
      rows.push({ path: row.path, displayName: row.displayName });
  }
  return rows;
}

/** Only packaged Windows builds claim the installed shortcut's list. */
export function connectJumpList(
  router: EventRouter,
  t: () => Translator,
  onLanguage: (refresh: () => void) => void,
): void {
  // The installer shortcut always opens the default profile. An isolated test or
  // alternate user-data directory must not publish its folders to that shared shortcut.
  if (
    process.platform !== 'win32' ||
    !app.isPackaged ||
    process.argv.some((arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='))
  )
    return;
  let recent: RecentWorkspace[] = [];
  let previous: string | undefined;
  function refresh(): void {
    const translator = t();
    const signature = JSON.stringify([translator.locale, recent]);
    if (previous === signature) return;
    const categories = jumpList(
      process.execPath,
      recent,
      app.getJumpListSettings().removedItems,
      translator,
    );
    const result = app.setJumpList(categories);
    if (result === 'ok') previous = signature;
    else if (result === 'customCategoryAccessDeniedError') {
      // A privacy setting may turn off recent items. Keep the two common tasks available.
      const tasks = categories.filter((category) => category.type === 'tasks');
      if (app.setJumpList(tasks) === 'ok') previous = signature;
      else console.warn('[jump-list] Windows declined the tasks');
    } else console.warn('[jump-list] Windows declined the update:', result);
  }
  router.listen('core/workspaces', (batch) => {
    const workspaces = recentWorkspaces(batch.payload);
    if (workspaces !== undefined) {
      recent = workspaces;
      refresh();
    }
  });
  onLanguage(refresh);
}
