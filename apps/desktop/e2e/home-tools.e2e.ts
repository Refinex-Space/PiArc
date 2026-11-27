// ADR-0099: the new-session view has its tools before the first message. Reaching for one
// opens a draft session (not listed in the sidebar); the first message goes to that session and
// the open tools stay. Leaving the view discards the draft. In a worktree the tools wait for the
// first message, since the worktree is created when it is sent.
import { execFileSync } from 'node:child_process';

import type { BrowserWindow } from 'electron';

import { expect, makeWorkspace, openFolder, row, startSession, test } from './sessions.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=PiArc', '-c', 'user.email=l4@piarc.invalid', ...args], {
    cwd,
  });
}

test('the new-session view opens files and a terminal before the first message', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(120_000);
  const owner = await app.browserWindow(page);
  await owner.evaluate((win: BrowserWindow) => {
    win.setContentSize(1440, 840);
  });
  const ws = await makeWorkspace(workspaces, 'tools 工具', {
    'README.md': '# tools\n',
    'src/main.ts': 'export {};\n',
  });
  await openFolder(page, app, ws);
  await expect(page.getByTestId('home')).toBeVisible();

  // The tools are there before anything is sent, and opening one lists no session.
  await page.getByTestId('tool-files').click();
  await expect(page.getByRole('treeitem', { name: 'README.md', exact: true })).toBeVisible();
  await page.getByTestId('tool-terminal').click();
  await expect(page.getByTestId('terminal-tab')).toHaveCount(1);
  await expect(page.getByTestId('session-row')).toHaveCount(0);
  await expect(page.getByTestId('home')).toBeVisible();
  await page.screenshot({ path: info.outputPath('home-tools.png') });

  // The first message goes to the same session; the tools stay open.
  const terminal = await page.getByTestId('terminal-tab').getAttribute('data-task');
  const id = await startSession(page, 'Look around', 't18-chat#home-tools');
  await expect(page.getByTestId('agent-message')).toHaveText(/Done\./u, { timeout: 30_000 });
  await expect(row(page, id)).toBeVisible();
  await expect(page.getByTestId('tool-terminal')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('terminal-tab')).toHaveAttribute('data-task', terminal ?? '');
  await expect(page.getByTestId('tool-files')).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: info.outputPath('after-first-message.png') });

  // A new session starts without tools; a draft left for another session is not listed.
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(page.getByTestId('tool-terminal')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('tool-files').click();
  await expect(page.getByRole('treeitem', { name: 'README.md', exact: true })).toBeVisible();
  await row(page, id).getByTestId('session-title').click();
  await expect(page.getByTestId('conversation')).toHaveAttribute('data-session-id', id);
  await expect(page.getByTestId('session-row')).toHaveCount(1);
});

test('in a worktree the tools wait for the first message', async ({ app, page, workspaces }) => {
  const ws = await makeWorkspace(workspaces, 'repo 仓库', { 'README.md': '# repo\n' });
  git(ws, 'init', '-q');
  git(ws, 'add', '.');
  git(ws, 'commit', '-qm', 'initial');
  await openFolder(page, app, ws);
  const environment = page.getByTestId('home-environment');
  await environment.click();
  await page.getByTestId('menu-worktree').click();
  for (const tool of ['tool-files', 'tool-terminal', 'tool-changes', 'tool-preview']) {
    await expect(page.getByTestId(tool)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId(tool)).toHaveAttribute('data-tooltip', /worktree/u);
  }
  await page.getByTestId('tool-files').click({ force: true });
  await expect(page.getByTestId('tile-files')).toHaveCount(0);
  // Back on this computer the tools work again.
  await environment.click();
  await page.getByTestId('menu-local').click();
  await page.getByTestId('tool-files').click();
  await expect(page.getByRole('treeitem', { name: 'README.md', exact: true })).toBeVisible();
});
