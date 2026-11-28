// Quitting from the menu or the tray (T35): background tasks and running sessions end with
// PiArc (T32), so when Core reports running work the user confirms first. Other quits (the
// system logging out, a test harness) are not asked about.
import { BrowserWindow, app, dialog } from 'electron';

import type { Translator } from '../../shared/i18n/index.js';

/** Core's running work: `{ sessions, tasks }`. */
export function parseRunningWork(text: string): { sessions: number; tasks: number } {
  const value: unknown = JSON.parse(text);
  const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
  if (typeof value !== 'object' || value === null) return { sessions: 0, tasks: 0 };
  const work = value as Record<string, unknown>;
  return { sessions: n(work.sessions), tasks: n(work.tasks) };
}

let asking = false;

/** Quits, after the user confirms when sessions or background tasks are running. */
export async function confirmQuit(
  core: { runningWork(): string },
  translator: () => Translator,
): Promise<void> {
  if (asking) return;
  let work: { sessions: number; tasks: number };
  try {
    work = parseRunningWork(core.runningWork());
  } catch (error) {
    console.warn('[app] cannot read the running work; asking anyway', error);
    work = { sessions: 1, tasks: 0 };
  }
  if (work.sessions + work.tasks === 0) {
    app.quit();
    return;
  }
  const t = translator();
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    message: t.t('dialog.quit.message'),
    detail: t.t('dialog.quit.detail', {
      sessions: String(work.sessions),
      tasks: String(work.tasks),
    }),
    buttons: [t.t('dialog.quit.confirm'), t.t('dialog.cancel')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  asking = true;
  try {
    const window = BrowserWindow.getFocusedWindow();
    const { response } =
      window === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(window, options);
    if (response === 0) app.quit();
  } finally {
    asking = false;
  }
}
