// T32 with the real Core, Agent Host and mock provider: the rail's background task card shows a
// background command's kind, status, running time and last lines, the dockable panel lists the
// workspace's tasks and reads a task's output from Core in parts, and the stop button ends the
// command (A12); a background subagent is a task in the same panel and stops from it (A11).
// Screenshots go to tmp/evidence/T32/ with PIARC_EVIDENCE_TASK=T32.
import type { BrowserWindow } from 'electron';
import { expect, test } from './sessions.js';
import { idle, openSession, screenshots } from './t19.js';

test('the background task card and panel show a command and stop it', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(120_000);
  // Inspect the rail card alongside the workspace task tile, as in a wide desktop layout.
  const owner = await app.browserWindow(page);
  await owner.evaluate((window: BrowserWindow) => {
    window.setContentSize(1440, 820);
  });
  await openSession(app, page, workspaces, 'background 后台', 't32-bg', 'Start the watcher');
  await idle(page);
  // The conversation's command card says it runs on in the background.
  await expect(page.getByTestId('bash-state')).toHaveText('In the background');
  await expect(page.getByTestId('bash-task')).toContainText('Runs in the background as task bg-');
  const card = page.getByTestId('bg-tasks-card');
  await expect(card).toBeVisible();
  // A workspace task can advertise its state without taking space away from the composer.
  await expect(page.getByTestId('tile-background-tasks')).toHaveCount(0);
  const task = card.getByTestId('bg-task');
  await expect(task).toHaveCount(1);
  await expect(task).toContainText('Command');
  await expect(task).toContainText('Running');
  await expect(task.locator('.bg-task-tail')).toHaveText('tick 1\ntick 2\ntick 3');
  // The running time goes on.
  const duration = task.locator('.bg-task-duration');
  const first = await duration.textContent();
  await expect(duration).not.toHaveText(first ?? '');
  await screenshots(page, info, 'card-running');

  await card.getByRole('button', { name: 'Show all background tasks' }).click();
  const panel = page.getByTestId('bg-tasks-panel');
  await expect(panel).toBeVisible();
  const row = panel.getByTestId('bg-panel-task');
  await expect(row).toContainText('Running');
  await row.getByRole('button', { name: 'Output' }).click();
  const output = row.getByTestId('bg-task-output');
  await expect(output.locator('.bg-task-log')).toHaveText('tick 1\ntick 2\ntick 3\n');
  await expect(output).toContainText('21 bytes');
  await screenshots(page, info, 'panel-output');

  await task.getByTestId('bg-task-stop').click();
  await expect(task).toContainText('Stopped');
  await expect(row).toContainText('Stopped');
  await expect(task.getByTestId('bg-task-stop')).toHaveCount(0);
  await screenshots(page, info, 'card-stopped');
  await page.getByTestId('tile-close-background-tasks').click();
  await expect(page.getByTestId('tile-background-tasks')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Show all background tasks' })).toBeFocused();
  await page.getByTestId('tool-more').click();
  await page.getByTestId('tool-background-tasks').click();
  await expect(row).toContainText('Stopped');
  await page.getByTestId('tool-more').click();
  await page.getByTestId('tool-background-tasks').click();
  await expect(page.getByTestId('tile-background-tasks')).toHaveCount(0);
  // The task list and terminal occupy independent tiles. Closing the list leaves the
  // same terminal live; closing just its view and reopening attaches to that shell.
  await page.getByTestId('tool-terminal').click();
  const terminal = page.getByTestId('terminal-tab');
  await expect(terminal).toHaveCount(1);
  const taskId = await terminal.getAttribute('data-task');
  if (!taskId) throw new Error('Missing terminal task id');
  await page.getByTestId('tool-more').click();
  await page.getByTestId('tool-background-tasks').click();
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('tile-terminal')).toBeVisible();
  await expect(terminal).toHaveAttribute('data-task', taskId);
  await page.getByTestId('tile-close-background-tasks').click();
  await expect(page.getByTestId('tile-background-tasks')).toHaveCount(0);
  await expect(page.getByTestId('tool-more')).toBeFocused();
  await expect(terminal).toHaveAttribute('data-task', taskId);
  await page.getByTestId('tile-close-terminal').click();
  await expect(page.getByTestId('tile-terminal')).toHaveCount(0);
  await page.getByTestId('tool-terminal').click();
  await expect(terminal).toHaveAttribute('data-task', taskId);
});

test('a background subagent is a task and stops from the panel', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(120_000);
  await openSession(app, page, workspaces, 'background agent', 't32-agent', 'Survey quietly');
  await idle(page);
  const card = page.getByTestId('bg-tasks-card');
  const task = card.getByTestId('bg-task');
  await expect(task).toContainText('Subagent');
  await expect(task).toContainText('Survey in the background');
  await expect(task).toContainText('Running');
  await card.getByRole('button', { name: 'Show all background tasks' }).click();
  const row = page.getByTestId('bg-tasks-panel').getByTestId('bg-panel-task');
  await expect(row).toContainText('Subagent');
  await row.getByRole('button', { name: 'Output' }).click();
  await expect(row).toContainText('A subagent keeps no output file');
  await screenshots(page, info, 'subagent-running');
  await row.getByTestId('bg-task-stop').click();
  await expect(row).toContainText('Stopped');
  await expect(page.getByTestId('subagent-card')).toHaveAttribute('data-status', 'interrupted');
  await screenshots(page, info, 'subagent-stopped');
});
