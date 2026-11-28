// Settings › Data management with the real Core: the archived sessions (grouped by project,
// searched, filtered, restored, deleted per project), archiving and deleting every session
// behind the main process's native confirmation, and the data export: a ZIP written only where
// the user picked, holding each conversation as Markdown and its original records.
// Screenshots go to tmp/evidence/<task>/ with PIARC_EVIDENCE_TASK set.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ElectronApplication, Page } from '@playwright/test';

import { closeSettings, openSettings } from './settings-panel.js';
import {
  expect,
  makeWorkspace,
  openFolder,
  row,
  startSession,
  stubMessageBox,
  test,
} from './sessions.js';
import { idle, prefer } from './t19.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function messageBoxes(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as { __piarcMessageBoxes?: string[] }).__piarcMessageBoxes ?? [],
  );
}

async function archive(page: Page, id: string): Promise<void> {
  await row(page, id).click({ button: 'right' });
  await page.getByTestId('menu-archive').click();
  await expect(row(page, id)).toHaveCount(0);
}

test('archived sessions, archive all, delete per project and all, and the export', async ({
  app,
  page,
  workspaces,
  userDataDir,
}, info) => {
  test.setTimeout(180_000);
  await prefer(page, { key: 'language', value: 'en' });
  const alpha = await makeWorkspace(workspaces, 'alpha 项目');
  const beta = await makeWorkspace(workspaces, 'beta');
  await openFolder(page, app, alpha);
  const first = await startSession(page, 'Plan the lighthouse', 't18-chat#data-1');
  await idle(page);
  await page.keyboard.press(`${MOD}+KeyN`);
  const second = await startSession(page, 'Sketch the harbour', 't18-chat#data-2', 'none');
  await idle(page);
  await openFolder(page, app, beta);
  const third = await startSession(page, 'Count the boats', 't18-chat#data-3');
  await idle(page);
  await archive(page, first);

  // The page: one archived, the rows with their actions; the sidebar has no "More" left.
  await expect(page.getByTestId('sidebar-more')).toHaveCount(0);
  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-data').click();
  await expect(settings.getByTestId('data-open-archived')).toContainText('1');
  await settings.screenshot({ path: info.outputPath('data-page.png') });

  // Archived sessions: grouped by project, searchable, filtered, restored.
  await settings.getByTestId('data-open-archived').click();
  await expect(settings).toHaveURL(/#\/settings\/data\?view=archived$/u);
  const sessionRow = (id: string) =>
    settings.locator(`[data-testid="archived-session"][data-session-id="${id}"]`);
  await expect(sessionRow(first)).toBeVisible();
  await expect(settings.getByTestId('archived-group')).toHaveCount(1);
  await settings.getByTestId('archived-search').fill('nothing like it');
  await expect(settings.getByTestId('archived-empty')).toBeVisible();
  await settings.getByTestId('archived-search').fill('lighthouse');
  await expect(sessionRow(first)).toBeVisible();
  await settings.getByTestId('archived-search').fill('');
  await sessionRow(first).getByTestId('archived-restore').click();
  await expect(settings.getByTestId('archived-empty')).toBeVisible();
  await settings.getByTestId('data-back').click();

  // Archive all: the native dialog names the sessions; cancelled, nothing moves.
  await stubMessageBox(app, 1);
  await settings.getByTestId('data-archive-all-button').click();
  await expect.poll(() => messageBoxes(app)).toEqual(['Archive 3 sessions?']);
  await expect(settings.getByTestId('data-open-archived')).toContainText('0');
  await stubMessageBox(app, 0);
  await settings.getByTestId('data-archive-all-button').click();
  await expect(settings.getByTestId('data-note-archive')).toContainText('Archived 3 sessions');
  await expect(settings.getByTestId('data-open-archived')).toContainText('3');
  await settings.getByTestId('data-open-archived').click();
  await expect(settings.getByTestId('archived-group')).toHaveCount(2);
  await expect(settings.getByTestId('archived-session')).toHaveCount(3);
  await settings.screenshot({ path: info.outputPath('archived-sessions.png') });
  // The project filter is the app's own menu.
  await settings.getByTestId('archived-project-filter').click();
  await settings.getByRole('menuitem', { name: /^beta/u }).click();
  await expect(settings.getByTestId('archived-session')).toHaveCount(1);
  await expect(sessionRow(third)).toBeVisible();
  // Deleting a project's sessions confirms once, then they are gone for good.
  await stubMessageBox(app, 0);
  await settings
    .locator('[data-testid="archived-group"]')
    .getByTestId('archived-group-menu')
    .click();
  await settings.getByTestId('archived-delete-all').click();
  await expect.poll(() => messageBoxes(app)).toEqual(['Permanently delete 1 session?']);
  await expect(settings.getByTestId('archived-empty')).toBeVisible();
  await settings.getByTestId('archived-project-filter').click();
  await settings.getByRole('menuitem', { name: 'All projects' }).click();
  await expect(settings.getByTestId('archived-session')).toHaveCount(2);
  await settings.getByTestId('data-back').click();

  // Export: written where the save dialog says, with the index, Markdown and raw records.
  const target = path.join(workspaces, 'export 导出.zip');
  await app.evaluate(({ dialog, shell }, file) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: file });
    const revealed: string[] = [];
    (globalThis as { __piarcRevealed?: string[] }).__piarcRevealed = revealed;
    shell.showItemInFolder = (item: string) => {
      revealed.push(item);
    };
  }, target);
  await settings.getByTestId('data-export-button').click();
  await expect(settings.getByTestId('data-note-export')).toContainText('Exported 2 sessions');
  const zip = await readFile(target);
  const has = (needle: string) => zip.includes(Buffer.from(needle));
  expect(has('sessions.json')).toBe(true);
  expect(has(`raw/${first}.jsonl`)).toBe(true);
  expect(has(`raw/${second}.jsonl`)).toBe(true);
  expect(has(`raw/${third}.jsonl`)).toBe(false);
  expect(has('markdown/alpha 项目/')).toBe(true);
  expect(has('Plan the lighthouse')).toBe(true);
  // No credentials or data directory paths.
  expect(has(userDataDir)).toBe(false);
  await settings.getByTestId('data-export-reveal').click();
  await expect
    .poll(() =>
      app.evaluate(() => (globalThis as { __piarcRevealed?: string[] }).__piarcRevealed ?? []),
    )
    .toEqual([target]);
  await settings.screenshot({ path: info.outputPath('exported.png') });

  // Delete all: confirmed in the native dialog; the sessions and their files go.
  await stubMessageBox(app, 0);
  await settings.getByTestId('data-delete-all-button').click();
  await expect.poll(() => messageBoxes(app)).toEqual(['Permanently delete 2 sessions?']);
  await expect(settings.getByTestId('data-note-delete')).toContainText('Deleted 2 sessions');
  await expect(settings.getByTestId('data-delete-all-button')).toBeDisabled();
  await closeSettings(settings);
  await expect(page.getByTestId('session-row')).toHaveCount(0);
});
