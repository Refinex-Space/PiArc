// T33 with the real Core, Agent Host and mock provider: a command the model runs with
// `terminal` is a background task of kind Terminal in the rail's card and the dock panel; the
// panel reads the terminal's screen file from Core (a header naming the last command and how
// it ended, then the screen as text), and the stop button closes the terminal. No window shows
// the terminal itself (the panel for it is T34's). Screenshots go to tmp/evidence/T33/ with
// PIARC_EVIDENCE_TASK=T33.
import { expect, test } from './sessions.js';
import { idle, openSession, screenshots } from './t19.js';

test('a command run in a terminal is a terminal task the panel reads and stops', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(120_000);
  await openSession(app, page, workspaces, 'terminal 终端', 't33-terminal', 'Build in a terminal');
  await idle(page);
  await expect(page.getByTestId('bash-task')).toContainText(
    /Runs in the background as task bg-|作为后台任务 bg-/,
  );
  const card = page.getByTestId('bg-tasks-card');
  const task = card.getByTestId('bg-task');
  await expect(task).toHaveCount(1);
  await expect(task).toContainText(/Terminal|终端/);
  await expect(task).toContainText(/Running|运行中/);
  // The command ended; the terminal stays open with its screen in the task's last lines.
  await expect(task.locator('.bg-task-tail')).toContainText('all done', { timeout: 20_000 });
  await screenshots(page, info, 'terminal-card');

  await card.getByRole('button', { name: /Show all background tasks|查看全部后台任务/ }).click();
  const row = page.getByTestId('bg-tasks-panel').getByTestId('bg-panel-task');
  await row.getByRole('button', { name: /Output|输出/ }).click();
  const log = row.getByTestId('bg-task-output').locator('.bg-task-log');
  await expect(log).toContainText('PiArc terminal bg-');
  await expect(log).toContainText('ended with exit code 0.');
  await expect(log).toContainText('built 中文\nall done');
  await screenshots(page, info, 'terminal-screen');

  await task.getByTestId('bg-task-stop').click();
  await expect(task).toContainText(/Stopped|已停止/);
  await expect(task.getByTestId('bg-task-stop')).toHaveCount(0);
  await screenshots(page, info, 'terminal-stopped');
});
