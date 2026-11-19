// Exercise the native confirmation and session restore against the real Core. The transcript
// lab supplies simultaneous requests and a question, which Pi's M1 preflight serializes.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApprovalAnswer, ApprovalRequest } from '@piarc/protocol';
import { expect, relaunch, row, test } from './sessions.js';
import { idle, openSession } from './t19.js';
import { openLab } from './transcript.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test('edits and confirms an exact rule, declines protected writes and restores the chosen mode', async ({
  page,
  app,
  workspaces,
  appForm,
  userDataDir,
}, info) => {
  const { id, ws } = await openSession(
    app,
    page,
    workspaces,
    'approval review',
    't20-approval',
    'Review the changes',
  );
  const card = page.getByTestId('approval-card');
  await expect(card).toContainText('echo one');
  await expect(row(page, id)).toHaveAttribute('data-badge', 'awaiting');
  await card.getByLabel('Rule to save').fill('Bash(echo approved)');
  await app.evaluate(({ dialog }) => {
    const seen: string[] = [];
    (globalThis as { approvalDialogs?: string[] }).approvalDialogs = seen;
    dialog.showMessageBox = (...args: unknown[]) => {
      const options = args.at(-1) as { detail: string };
      seen.push(options.detail);
      return Promise.resolve({ response: seen.length === 1 ? 1 : 0, checkboxChecked: false });
    };
  });
  await card.getByRole('button', { name: 'Always allow', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Always allow', exact: true })).toBeEnabled();
  await card.getByRole('button', { name: 'Always allow', exact: true }).click();
  await expect(card).toHaveAttribute('data-approval-card', 'fileChange');
  expect(
    await app.evaluate(() => (globalThis as { approvalDialogs?: string[] }).approvalDialogs),
  ).toEqual(['Rule to save\nBash(echo approved)', 'Rule to save\nBash(echo approved)']);
  expect(
    JSON.parse(await readFile(path.join(ws, '.piarc', 'settings.local.json'), 'utf8')),
  ).toMatchObject({
    permissions: { allow: ['Bash(echo approved)'] },
  });
  await expect(card).toContainText(/\.piarc[\\/]note\.txt/u);
  await expect(card.getByRole('button', { name: 'Always allow' })).toHaveCount(0);
  await card.screenshot({ path: info.outputPath('protected-file.png') });
  await card
    .getByLabel('Feedback for the model (optional)')
    .fill('Keep the project configuration as it is.');
  await card.getByRole('button', { name: 'Decline' }).click();
  await idle(page);
  await page.keyboard.press(MOD + '+Shift+M');
  await expect(page.getByRole('menu', { name: 'Permission mode' })).toBeVisible();
  await page.keyboard.press('2');
  await expect(page.getByTestId('permission-mode')).toHaveText(/Accept edits/u);
  await expect(page.getByTestId('mode-change-row')).toContainText('Accept edits');
  await app.close();
  const next = await relaunch(appForm, userDataDir);
  try {
    await row(next.page, id).getByTestId('session-title').click();
    await expect(next.page.getByTestId('mode-change-row')).toContainText('Accept edits');
    await expect(next.page.getByTestId('permission-mode')).toHaveText(/Accept edits/u);
  } finally {
    await next.app.close();
  }
});

test('guards approval shortcuts with the actual composer, focused card and visible order', async ({
  page,
  app,
}, info) => {
  await openLab(page);
  const base = {
    sessionId: 'test',
    revision: 1,
    connectionEpoch: 2,
    tool: 'Bash',
    kind: 'command',
  } as const;
  const requests: ApprovalRequest[] = [
    {
      ...base,
      requestId: 'one',
      command: 'echo ' + 'A'.repeat(520),
      rules: ['Bash(echo A)'],
      cwd: '/example',
    },
    {
      ...base,
      requestId: 'two',
      kind: 'permissionExpansion',
      tool: 'Read',
      directory: '/extra',
      path: '/extra/a.ts',
    },
  ];
  await app.evaluate(({ ipcMain }) => {
    const answers: ApprovalAnswer[] = [];
    (globalThis as { testAnswers?: ApprovalAnswer[] }).testAnswers = answers;
    ipcMain.removeHandler('piarc:approval.answer');
    ipcMain.handle('piarc:approval.answer', (_evt, a: ApprovalAnswer) => {
      answers.push(a);
      return JSON.stringify({ status: 'cancelled' });
    });
  });
  const answers = () =>
    app.evaluate(() => (globalThis as { testAnswers?: ApprovalAnswer[] }).testAnswers ?? []);
  // Freeze renderer time while the new rows mount. The first physical key is inside 400 ms.
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 100));
  await page.evaluate((r) => {
    globalThis.__piarcTranscriptLab?.setApprovals(r);
  }, requests);
  const first = page.locator('[data-request-id="one"]');
  await expect(first).toBeVisible();
  await page.keyboard.press(MOD + '+Enter');
  await expect(first.getByRole('button', { name: 'Always allow' })).toBeDisabled();
  expect(await answers()).toHaveLength(0);
  await page.clock.runFor(401);
  await first.getByRole('button', { name: 'Show full request' }).click();
  await expect(first.getByRole('button', { name: 'Always allow' })).toBeEnabled();
  await first.screenshot({ path: info.outputPath('command.png'), animations: 'disabled' });
  const outside = page.locator('[data-request-id="two"]');
  await outside.screenshot({ path: info.outputPath('outside.png'), animations: 'disabled' });
  await first.scrollIntoViewIfNeeded();
  await page.keyboard.press(MOD + '+Shift+Enter');
  await expect
    .poll(answers)
    .toEqual([expect.objectContaining({ requestId: 'one', decision: 'allowSession' })]);
  const composer = page.getByTestId('composer-input');
  await composer.fill('draft');
  await page.keyboard.press('Escape');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 });
  await page.keyboard.press(MOD + '+Enter');
  expect(await answers()).toHaveLength(1);
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await first.getByLabel('Feedback for the model (optional)').fill('Wait for review');
  await page.keyboard.press('Escape');
  await expect
    .poll(answers)
    .toEqual([
      expect.objectContaining({ requestId: 'one', decision: 'allowSession' }),
      expect.objectContaining({ requestId: 'one', decision: 'deny', feedback: 'Wait for review' }),
    ]);
  await page.evaluate(() => {
    globalThis.__piarcTranscriptLab?.setApprovals([
      {
        sessionId: 'test',
        requestId: 'ask',
        revision: 1,
        connectionEpoch: 2,
        tool: 'AskUserQuestion',
        kind: 'question',
      },
    ]);
  });
  const question = page.locator('[data-approval-card="question"]');
  await expect(question).toContainText('does not support');
  await question.screenshot({ path: info.outputPath('question.png'), animations: 'disabled' });
});
