// T35 L4: a session in its own worktree (new-session form, environment bar, the `.gitignore`
// notice, the archive question about uncommitted changes) and full-text search that opens a
// session at the message it found. Screenshots go to tmp/evidence/T35/ with
// PIARC_EVIDENCE_TASK=T35.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { closeSettings, openSettings } from './settings-panel.js';

import type { ElectronApplication, Page } from '@playwright/test';

import {
  expect,
  focusMain,
  makeWorkspace,
  openFolder,
  row,
  startSession,
  stubMessageBox,
  test,
} from './sessions.js';
import { idle, openSession, prefer, screenshots, send } from './t19.js';

/** Runs git with a configuration that does not depend on the machine's. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=PiArc L4',
      '-c',
      'user.email=l4@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

async function messageBoxes(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as { __piarcMessageBoxes?: string[] }).__piarcMessageBoxes ?? [],
  );
}

async function sessionMenu(page: Page, id: string, item: string): Promise<void> {
  // The actions button shows on hover for rows that are not selected.
  await row(page, id).hover();
  await row(page, id).getByTestId('session-actions').click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

test('starts a session in its own worktree and asks before archiving its changes', async ({
  app,
  page,
  workspaces,
}, info) => {
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'repo 仓库', { 'README.md': '# repo\n' });
  git(ws, 'init', '-q');
  git(ws, 'add', '.');
  git(ws, 'commit', '-qm', 'initial');
  git(ws, 'branch', 'release-1');
  await openFolder(page, app, ws);

  // The card names the chosen environment: this computer until the worktree is chosen.
  const environment = page.getByTestId('home-environment');
  await expect(environment).toHaveText('This computer');
  await page.getByTestId('home').screenshot({ path: info.outputPath('environment-local.png') });
  await environment.click();
  await page.getByTestId('menu-worktree').click();
  await expect(page.getByTestId('home-worktree-fields')).toBeVisible();
  await expect(environment).toHaveText('Worktree');
  await page.getByTestId('home').screenshot({ path: info.outputPath('environment-worktree.png') });
  const base = page.getByTestId('home-worktree-base');
  await expect(base).toBeEnabled();
  await expect(base.locator('option')).toHaveText(['Current commit (main)', 'release-1']);
  await page.getByTestId('home-worktree-name').fill('bad name');
  await page.getByTestId('home-input').fill('nothing yet');
  await page.getByTestId('home-start').click();
  await expect(page.getByTestId('home-error')).toContainText('1 to 64 letters');
  await page.getByTestId('home-worktree-name').fill('feature-l4');
  await base.selectOption('release-1');
  await screenshots(page, info, 'new-session-worktree');
  const id = await startSession(page, 'Write a draft', 't35-tree');
  await focusMain(app);

  const chip = page.getByTestId('env-worktree');
  await expect(chip).toContainText('feature-l4');
  await expect(chip).toContainText('piarc/feature-l4');
  const card = page.getByTestId('approval-card');
  await card.getByRole('button', { name: 'Allow once', exact: true }).click();
  await idle(page);
  const tree = path.join(ws, '.piarc', 'worktrees', 'feature-l4');
  expect(await readFile(path.join(tree, 'draft.txt'), 'utf8')).toBe('work in progress');
  expect(existsSync(path.join(ws, 'draft.txt'))).toBe(false);
  expect(git(ws, 'branch', '--list', 'piarc/*')).toContain('piarc/feature-l4');

  // The repository does not ignore .piarc/worktrees/ yet: the notice adds the line.
  const notice = page.getByTestId('notice-gitignore');
  await expect(notice).toBeVisible();
  // At the narrowest window the notice's long path wraps and its button stays inside the main
  // column (on a 1024-pixel screen it went under the side panels, I210).
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.setSize(960, 640);
  });
  await expect
    .poll(async () => {
      const button = await notice.boundingBox();
      const main = await page.getByTestId('shell-main').boundingBox();
      return button !== null && main !== null && button.x + button.width <= main.x + main.width;
    })
    .toBe(true);
  await screenshots(page, info, 'worktree-session');
  await notice.click();
  await expect(notice).toHaveCount(0);
  expect(await readFile(path.join(ws, '.gitignore'), 'utf8')).toContain('.piarc/worktrees/');

  // Uncommitted changes: cancelling keeps the session where it is.
  await stubMessageBox(app, 2);
  await sessionMenu(page, id, 'Archive');
  await expect.poll(() => messageBoxes(app)).toHaveLength(1);
  expect((await messageBoxes(app))[0]).toContain('1 uncommitted change.');
  await expect(row(page, id)).toBeVisible();
  await expect(page.getByTestId('conversation')).toBeVisible();

  // Keeping the worktree archives the session and leaves the changes in place.
  await stubMessageBox(app, 0);
  await sessionMenu(page, id, 'Archive');
  await expect(row(page, id)).toHaveCount(0);
  expect(existsSync(path.join(tree, 'draft.txt'))).toBe(true);

  // Restored and archived again, discarding: the worktree goes, its branch stays.
  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-data').click();
  await settings.getByTestId('data-open-archived').click();
  await settings
    .locator(`[data-testid="archived-session"][data-session-id="${id}"]`)
    .getByTestId('archived-restore')
    .click();
  await closeSettings(settings);
  await expect(row(page, id)).toBeVisible();
  await stubMessageBox(app, 1);
  await sessionMenu(page, id, 'Archive');
  await expect.poll(() => existsSync(tree)).toBe(false);
  expect(git(ws, 'branch', '--list', 'piarc/*')).toContain('piarc/feature-l4');
});

test('finds a message by its words and opens its session at that message', async ({
  app,
  page,
  workspaces,
}, info) => {
  const { id } = await openSession(
    app,
    page,
    workspaces,
    'search 搜索',
    't35-search',
    'Find the 灯塔 lighthouse note',
  );
  await idle(page);
  for (let i = 0; i < 6; i += 1) {
    await send(page, `Next part ${String(i)}`);
    await idle(page);
  }
  const marker = page.locator('.transcript-row', { hasText: 'Find the 灯塔' });
  await expect(marker).toHaveCount(0);

  // Mixed Chinese and English terms; the snippet marks both.
  await page.getByTestId('open-search').click();
  await page.getByTestId('global-search-input').fill('灯塔 lighthouse');
  const results = page.getByTestId('message-search');
  const hit = results.getByTestId('search-hit').first();
  await expect(hit).toBeVisible();
  await expect(hit.locator('mark')).toHaveText(['灯塔', 'lighthouse']);
  await expect(results.locator(`[data-session="${id}"]`)).toBeVisible();
  await page
    .getByTestId('global-search')
    .screenshot({ path: info.outputPath('search-results.png') });

  // Two characters: below a trigram, still found.
  await page.getByTestId('global-search-input').fill('灯塔');
  await expect(results.getByTestId('search-hit').first().locator('mark')).toHaveText('灯塔');
  await results.getByTestId('search-hit').first().click();
  const located = page.locator('.transcript-row[data-located]');
  await expect(located).toBeVisible();
  await expect(located).toContainText('灯塔');
  await expect(page.getByTestId('transcript')).toHaveAttribute('data-following', 'false');
  await screenshots(page, info, 'search-located');
});
