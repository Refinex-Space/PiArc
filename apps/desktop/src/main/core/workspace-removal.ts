// Removing a project from the sidebar. Core keeps the folder and the sessions; it stops the
// project's running sessions and background tasks, so when it has some the user confirms in a
// native dialog first (the page cannot answer it).
import type { Translator } from '../../shared/i18n/index.js';
import { parseRunningWork } from '../platform/quit.js';
import type { CoreRuntime } from './native/piarc-core.js';

/** The part of Core this uses. */
export type WorkspaceRemovalCore = Pick<CoreRuntime, 'workspaceWork' | 'removeWorkspace'>;

/** Shows a native message box; resolves with the index of the button pressed. */
export type AskPort = (options: Electron.MessageBoxOptions) => Promise<number>;

/** The project's name as the sidebar shows it: the last path segment. */
export function projectName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? path;
}

/**
 * Removes workspace `path` from the list; resolves `false` when the user kept it. Its running
 * sessions and background tasks are listed in a native confirmation first.
 */
export async function removeWorkspace(
  core: WorkspaceRemovalCore,
  t: Translator,
  ask: AskPort,
  path: string,
): Promise<boolean> {
  const work = parseRunningWork(await core.workspaceWork(path));
  if (work.sessions + work.tasks > 0) {
    const response = await ask({
      type: 'warning',
      message: t.t('dialog.removeWorkspace.message', { name: projectName(path) }),
      detail: [
        path,
        t.t('dialog.removeWorkspace.detail', {
          sessions: String(work.sessions),
          tasks: String(work.tasks),
        }),
      ].join('\n'),
      buttons: [t.t('dialog.removeWorkspace.confirm'), t.t('dialog.cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return false;
  }
  await core.removeWorkspace(path);
  return true;
}
