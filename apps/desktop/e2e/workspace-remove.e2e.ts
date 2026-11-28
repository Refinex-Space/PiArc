// Removing a project from the sidebar: the project's menu (right click or the "…" button) has
// "Remove project". Without running work it goes at once; with a running session the main
// process asks first (cancelling keeps it). The folder and the sessions stay: opening the
// folder lists the project again with its sessions, and a removed project stays removed after
// a restart.
import { existsSync } from 'node:fs';

import type { ElectronApplication, Page } from '@playwright/test';

import {
  expect,
  makeWorkspace,
  openFolder,
  relaunch,
  row,
  startSession,
  stubMessageBox,
  test,
} from './sessions.js';

function group(page: Page, dir: string) {
  // A JSON string is a valid CSS string (Windows paths keep their escaped backslashes).
  return page.locator(`[data-testid="workspace-group"][data-path=${JSON.stringify(dir)}]`);
}

async function asked(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as { __piarcMessageBoxes?: string[] }).__piarcMessageBoxes ?? [],
  );
}

test('remove a project from the sidebar and bring it back by opening the folder', async ({
  app,
  page,
  appForm,
  userDataDir,
  workspaces,
}, testInfo) => {
  test.setTimeout(150_000);
  const ws = await makeWorkspace(workspaces, 'remove 移除');
  const other = await makeWorkspace(workspaces, 'keep 保留');
  await openFolder(page, app, other);
  await openFolder(page, app, ws);
  const done = await startSession(page, 'Finish this', 't18-chat#remove-done');
  await expect(page.getByTestId('agent-message')).toHaveText(/Done\./, { timeout: 30_000 });
  await page.getByTestId('new-session').click();
  const running = await startSession(page, 'Keep running', 't18-stall#remove-running', 'none');
  await expect(row(page, running)).toHaveAttribute('data-badge', 'running', { timeout: 30_000 });

  // A running session: the main process asks; cancelling keeps the project and the turn.
  await stubMessageBox(app, 1);
  await group(page, ws).getByTestId('project-toggle').click({ button: 'right' });
  await expect(page.getByTestId('menu-remove')).toHaveText(/移除项目|Remove project/u);
  await page.screenshot({ path: testInfo.outputPath('menu.png') });
  await page.getByTestId('menu-remove').click();
  await expect.poll(() => asked(app)).toHaveLength(1);
  expect((await asked(app))[0]).toMatch(/remove 移除/u);
  await expect(group(page, ws)).toBeVisible();
  await expect(row(page, running)).toHaveAttribute('data-badge', 'running');

  // Confirmed through the "…" button: the project and its sessions leave the sidebar, the
  // conversation that was shown gives way to the home view, the other project stays.
  await stubMessageBox(app, 0);
  await group(page, ws).hover();
  await group(page, ws).getByTestId('workspace-actions').click();
  await page.getByTestId('menu-remove').click();
  await expect(group(page, ws)).toHaveCount(0);
  await expect(row(page, done)).toHaveCount(0);
  await expect(row(page, running)).toHaveCount(0);
  await expect(page.getByTestId('conversation')).toHaveCount(0);
  await expect(group(page, other)).toBeVisible();
  expect(await asked(app)).toHaveLength(1);
  expect(existsSync(ws)).toBe(true);
  await page.getByTestId('shell-sidebar').screenshot({ path: testInfo.outputPath('removed.png') });

  // Nothing runs any more: removing the other project asks nothing.
  await stubMessageBox(app, 1);
  await group(page, other).getByTestId('project-toggle').click({ button: 'right' });
  await page.getByTestId('menu-remove').click();
  await expect(group(page, other)).toHaveCount(0);
  expect(await asked(app)).toHaveLength(0);

  // Opening the folder lists the project again with its finished session.
  await openFolder(page, app, ws);
  await expect(group(page, ws)).toBeVisible();
  await expect(row(page, done)).toBeVisible();
  await page.getByTestId('shell-sidebar').screenshot({ path: testInfo.outputPath('restored.png') });

  // A removed project stays removed after a restart.
  await app.close();
  const again = await relaunch(appForm, userDataDir);
  try {
    const { page: next } = again;
    await expect(group(next, ws)).toBeVisible();
    await expect(row(next, done)).toBeVisible();
    await expect(group(next, other)).toHaveCount(0);
  } finally {
    await again.app.close();
  }
});
