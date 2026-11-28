// T18-A05, A06, A07: the session list driven through the window — the optimistic message and
// its rollback when creating fails; rename, pin, filter, archive and delete with the files
// gone afterwards; the result kept across a restart; status badges from Core's snapshot.
import { existsSync } from 'node:fs';
import path from 'node:path';

import { closeSettings, openSettings } from './settings-panel.js';

import type { Page } from '@playwright/test';

import { IPC_CHANNELS } from '../src/shared/ipc.js';
import { expectTestHooks } from './core.js';
import {
  expect,
  filesNamed,
  focusMain,
  makeWorkspace,
  openFolder,
  optimisticSeen,
  relaunch,
  row,
  startSession,
  stubMessageBox,
  test,
  watchOptimistic,
} from './sessions.js';

// Core lists a folder being opened before opening finishes, and the home view shows it then:
// text typed in that time stays when opening finishes (CI lost the rolled-back draft below).
test('text typed while the folder opens stays in the input', async ({ app, page, workspaces }) => {
  await expectTestHooks(app);
  const ws = await makeWorkspace(workspaces, 'typing 输入');
  // The answer reaches the window 1.5 s after Core opened the folder.
  await app.evaluate((_electron, channel) => {
    globalThis.__piarcTestHooks?.holdNext(channel, 1500);
  }, IPC_CHANNELS.workspaceOpen);
  await openFolder(page, app, ws);
  const input = page.getByTestId('home-input');
  await input.fill('Typed while the folder opens');
  // Longer than the hold: the answer has arrived and been handled.
  await page.waitForTimeout(2500);
  await expect(input).toHaveText('Typed while the folder opens');
  await expect(page.getByTestId('home-workspace')).toHaveAttribute('value', ws);
});

test('the new message shows at once; a failed create rolls it back into the input', async ({
  app,
  page,
  workspaces,
}, testInfo) => {
  await expectTestHooks(app);
  const ws = await makeWorkspace(workspaces, 'roll back 回滚');
  await openFolder(page, app, ws);

  // Creating fails (injected in the main process before Core is called).
  await app.evaluate((_electron, channel) => {
    globalThis.__piarcTestHooks?.failNext(channel, 'injected create failure');
  }, IPC_CHANNELS.sessionCreate);
  await watchOptimistic(page);
  const text = 'Plan the refactor 计划 [[piarc-scenario:t18-chat#rollback]]';
  await page.getByTestId('home-input').fill(text);
  await page.getByTestId('home-start').click();
  await page.getByTestId('trust-accept').click();
  await expect(page.getByTestId('home-error')).toContainText('injected create failure');
  await expect(page.getByTestId('home-input')).toHaveText(text);
  await expect(page.getByTestId('optimistic-message')).toHaveCount(0);
  const seen = await optimisticSeen(page);
  expect(seen.appeared).toBeGreaterThan(0);
  expect(seen.text).toContain('Plan the refactor 计划');
  await expect(page.getByTestId('session-row')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('rolled-back.png') });

  // The same text starts the session once creating works. While the session starts (held here),
  // the message sits where the conversation will show it, under it the working line, and the
  // input shows its placeholder instead of the same text again.
  await watchOptimistic(page);
  await app.evaluate((_electron, channel) => {
    globalThis.__piarcTestHooks?.holdNext(channel, 2000);
  }, IPC_CHANNELS.sessionCreate);
  await page.getByTestId('home-start').click();
  const pending = page.getByTestId('optimistic-message');
  await expect(page.getByTestId('home-starting')).toBeVisible();
  await expect(pending).toContainText('Plan the refactor 计划');
  const stage = await page.getByTestId('home').boundingBox();
  const bubble = await pending.boundingBox();
  // At the top of the stage and on the column's right, not centred.
  expect(bubble !== null && stage !== null && bubble.y - stage.y < 60).toBe(true);
  await expect(page.locator('.home .composer-editor')).toHaveCSS('opacity', '0');
  await page.screenshot({ path: testInfo.outputPath('starting.png') });
  const conversation = page.getByTestId('conversation');
  await expect(conversation).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('agent-message')).toHaveText(/Done\./, { timeout: 30_000 });
  // Core's user message replaced the echo: one user message, no optimistic row left.
  await expect(page.getByTestId('user-message')).toHaveCount(1);
  await expect(page.getByTestId('optimistic-message')).toHaveCount(0);
  expect((await optimisticSeen(page)).appeared).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('started.png') });
});

test('rename, pin, filter, archive and delete sessions; the result survives a restart', async ({
  app,
  page,
  appForm,
  userDataDir,
  workspaces,
}, testInfo) => {
  test.setTimeout(150_000);
  const ws = await makeWorkspace(workspaces, 'manage 管理');
  await openFolder(page, app, ws);
  const ids: string[] = [];
  for (const [n, title] of ['Alpha task', 'Beta task', 'Gamma task'].entries()) {
    await page.getByTestId('new-session').click();
    ids.push(
      await startSession(page, title, `t18-chat#manage-${String(n)}`, n === 0 ? 'trust' : 'none'),
    );
    await expect(page.getByTestId('agent-message')).toHaveText(/Done\./, { timeout: 30_000 });
  }
  const [alpha, beta, gamma] = ids as [string, string, string];
  await expect(page.getByTestId('session-row')).toHaveCount(3);

  // Rename through the row's menu.
  await row(page, alpha).hover();
  await row(page, alpha).getByTestId('session-actions').click();
  await page.getByTestId('menu-rename').click();
  await page.getByTestId('rename-input').fill('重命名的会话 Renamed');
  await page.getByTestId('rename-input').press('Enter');
  await expect(row(page, alpha).getByTestId('session-title')).toHaveText('重命名的会话 Renamed');

  // Pin: the pinned session goes first in its group.
  await row(page, beta).click({ button: 'right' });
  await page.getByTestId('menu-pin').click();
  await expect(row(page, beta).getByTestId('pin-mark')).toBeVisible();
  await expect(page.getByTestId('session-row').first()).toHaveAttribute('data-session-id', beta);

  // Search session titles without leaving the conversation.
  await page.getByTestId('open-search').click();
  await page.getByTestId('global-search-input').fill('gamma');
  const titles = page.getByTestId('global-search').getByTestId('search-title');
  await expect(titles).toHaveCount(1);
  await expect(titles).toHaveAttribute('data-session-id', gamma);
  await page.getByTestId('global-search-input').fill('');
  await expect(titles).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('open-search')).toBeFocused();

  // Archive: it leaves the sidebar and is listed in Settings › Data management › Archived
  // sessions; its temporary directory is removed.
  const temp = path.join(userDataDir, 'sessions', gamma);
  expect(existsSync(temp)).toBe(true);
  await row(page, gamma).click({ button: 'right' });
  await page.getByTestId('menu-archive').click();
  await expect(row(page, gamma)).toHaveCount(0);
  await expect.poll(() => existsSync(temp)).toBe(false);
  const archived = async (on: Page) => {
    const settings = await openSettings(on);
    await settings.getByTestId('settings-nav-data').click();
    await settings.getByTestId('data-open-archived').click();
    await expect(
      settings.locator(`[data-testid="archived-session"][data-session-id="${gamma}"]`),
    ).toBeVisible();
    await closeSettings(settings);
  };
  await archived(page);

  // Delete: the main process asks (stubbed native dialog), then the Pi file and the temporary
  // directory are gone.
  const betaFiles = await filesNamed(path.join(userDataDir, 'pi', 'sessions'), beta);
  expect(betaFiles).toHaveLength(1);
  await stubMessageBox(app, 0);
  await row(page, beta).click({ button: 'right' });
  await page.getByTestId('menu-delete').click();
  await expect(row(page, beta)).toHaveCount(0);
  const asked = await app.evaluate(
    () => (globalThis as { __piarcMessageBoxes?: string[] }).__piarcMessageBoxes ?? [],
  );
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain(beta);
  expect(asked[0]).toContain('Beta task');
  expect(betaFiles.every((file) => !existsSync(file))).toBe(true);
  expect(existsSync(path.join(userDataDir, 'sessions', beta))).toBe(false);
  // Cancelling the dialog keeps the session.
  await stubMessageBox(app, 1);
  await row(page, alpha).click({ button: 'right' });
  await page.getByTestId('menu-delete').click();
  await expect(row(page, alpha)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('managed.png') });

  // After a restart: renamed, archived, deleted as before.
  await app.close();
  const again = await relaunch(appForm, userDataDir);
  try {
    const { page: next } = again;
    await expect(row(next, alpha).getByTestId('session-title')).toHaveText('重命名的会话 Renamed');
    await expect(row(next, beta)).toHaveCount(0);
    await expect(row(next, gamma)).toHaveCount(0);
    await archived(next);
    await next.screenshot({ path: testInfo.outputPath('after-restart.png') });
  } finally {
    await again.app.close();
  }
});

test('status badges follow Core: running, unread, error', async ({
  app,
  page,
  workspaces,
}, testInfo) => {
  test.setTimeout(120_000);
  const ws = await makeWorkspace(workspaces, 'badges 徽标');
  await openFolder(page, app, ws);
  const failed = await startSession(page, 'This one fails', 't18-fail#badges');
  await expect(row(page, failed)).toHaveAttribute('data-badge', 'error', { timeout: 60_000 });
  await page.getByTestId('new-session').click();
  const running = await startSession(page, 'This one keeps running', 't18-stall#badges', 'none');
  await expect(row(page, running)).toHaveAttribute('data-badge', 'running', { timeout: 30_000 });
  // A turn that completes while another session is shown is unread.
  await page.getByTestId('new-session').click();
  const done = await startSession(page, 'This one finishes', 't18-chat#badges', 'none');
  await expect(page.getByTestId('agent-message')).toHaveText(/Done\./, { timeout: 30_000 });
  // A window launched by Playwright may lose the foreground on Windows (W1), and a turn that
  // completes then is unread: shown in a focused window, it becomes read. Wait for that before
  // leaving it, or the click can unmount it before the renderer sees the focus.
  await focusMain(app);
  await expect(row(page, done)).toHaveAttribute('data-badge', 'idle', { timeout: 10_000 });
  await row(page, running).getByTestId('session-title').click();
  await expect(row(page, done)).toHaveAttribute('data-badge', 'idle');
  const unread = await startSessionElsewhere(page, ws);
  await expect(row(page, unread)).toHaveAttribute('data-badge', 'unread', { timeout: 30_000 });
  await expect(row(page, failed)).toHaveAttribute('data-badge', 'error');
  await page.getByTestId('shell-sidebar').screenshot({ path: testInfo.outputPath('badges.png') });
});

/**
 * Starts a session through `window.piarc` without showing it, so its completion stays unread.
 */
async function startSessionElsewhere(page: Page, ws: string): Promise<string> {
  return page.evaluate(async (workspace) => {
    const created = JSON.parse(await window.piarc.createSession(workspace)) as {
      sessionId: string;
    };
    await window.piarc.prompt(created.sessionId, {
      requestId: crypto.randomUUID(),
      text: 'Background [[piarc-scenario:t18-chat#unread]]',
      mentions: [],
      attachments: [],
    });
    return created.sessionId;
  }, ws);
}

test('project actions support drag ordering, keyboard access and project search', async ({
  app,
  page,
  workspaces,
}, info) => {
  const first = await makeWorkspace(workspaces, 'Atlas');
  const second = await makeWorkspace(workspaces, 'Birch');
  await openFolder(page, app, first);
  await openFolder(page, app, second);
  const groups = page.getByTestId('workspace-group');
  const atlas = groups.filter({ has: page.getByRole('button', { name: 'Atlas', exact: true }) });
  const birch = groups.filter({ has: page.getByRole('button', { name: 'Birch', exact: true }) });
  await expect(groups.first()).toHaveAttribute('data-path', second);

  await atlas.getByTestId('project-toggle').dragTo(birch.getByTestId('project-toggle'));
  await expect(groups.first()).toHaveAttribute('data-path', first);
  await page.reload();
  await expect(groups.first()).toHaveAttribute('data-path', first);

  await atlas.getByTestId('project-toggle').press('Shift+F10');
  await expect(page.getByTestId('menu-move-up')).toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('menu-move-down').click();
  await expect(groups.last()).toHaveAttribute('data-path', first);
  await birch.getByTestId('project-toggle').click({ button: 'right' });
  await expect(page.getByTestId('menu-trust')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(birch.getByTestId('project-toggle')).toBeFocused();
  await atlas.getByTestId('project-toggle').click();
  await expect(atlas.getByTestId('project-toggle')).toHaveAttribute('aria-expanded', 'true');
  await atlas.getByTestId('project-toggle').click();
  await expect(atlas.getByTestId('project-toggle')).toHaveAttribute('aria-expanded', 'false');

  await page.getByTestId('open-search').click();
  await expect(page.getByTestId('global-search-input')).toBeFocused();
  await page.getByTestId('global-search-input').fill('atlas');
  // The Projects tab; the arrows move the selection while the field keeps the focus.
  await page.getByTestId('global-search-tab-project').click();
  await expect(page.getByTestId('global-search-input')).toBeFocused();
  await page.getByTestId('global-search-input').press('ArrowDown');
  await page.getByTestId('global-search-input').press('ArrowUp');
  await expect(page.getByTestId('search-project').first()).toHaveClass(/is-selected/u);
  await page
    .getByTestId('global-search')
    .screenshot({ path: info.outputPath('project-search.png') });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('global-search')).toHaveCount(0);
  await expect(page.getByTestId('home-workspace')).toHaveAttribute('value', first);
});
