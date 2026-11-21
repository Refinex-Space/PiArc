// T43-A05 on the transcript prototype page (the production approval rows, answers recorded in
// the main process): a card that appears takes focus on its container and is named by its kind
// and object; during an input method composition focus stays in the composer until the
// composition ends; for 400 ms after it appears, Enter on its buttons does nothing.
import type { ApprovalAnswer, ApprovalRequest } from '@piarc/protocol';
import type { CDPSession, ElectronApplication, Page } from '@playwright/test';

import { expect, test } from './sessions.js';
import { openLab } from './transcript.js';

const BASE: Omit<ApprovalRequest, 'requestId'> = {
  sessionId: 'test',
  revision: 1,
  connectionEpoch: 2,
  tool: 'Bash',
  kind: 'command',
  rules: ['Bash(env echo hi)'],
};

async function recordAnswers(app: ElectronApplication): Promise<() => Promise<ApprovalAnswer[]>> {
  await app.evaluate(({ ipcMain }) => {
    const answers: ApprovalAnswer[] = [];
    (globalThis as { testAnswers?: ApprovalAnswer[] }).testAnswers = answers;
    ipcMain.removeHandler('piarc:approval.answer');
    ipcMain.handle('piarc:approval.answer', (_evt, a: ApprovalAnswer) => {
      answers.push(a);
      return JSON.stringify({ status: 'cancelled' });
    });
  });
  return () =>
    app.evaluate(() => (globalThis as { testAnswers?: ApprovalAnswer[] }).testAnswers ?? []);
}

async function show(page: Page, requests: ApprovalRequest[]): Promise<void> {
  await page.evaluate((r) => {
    globalThis.__piarcTranscriptLab?.setApprovals(r);
  }, requests);
}

function focusedCard(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document.activeElement?.closest('[data-approval-card]')?.getAttribute('data-request-id') ??
      null,
  );
}

async function compose(cdp: CDPSession, text: string): Promise<void> {
  await cdp.send('Input.imeSetComposition', {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
}

test('a new card takes focus on its container, waits for a composition, and guards Enter for 400 ms', async ({
  page,
  app,
}) => {
  await openLab(page);
  const answers = await recordAnswers(app);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 100));

  // The card's container, not a button, has focus, and is named by its kind and object.
  await show(page, [{ ...BASE, requestId: 'one', command: 'env echo hi' }]);
  const card = page.locator('[data-request-id="one"]');
  await expect(card).toBeFocused();
  await expect(card).toHaveAttribute('aria-label', 'Approval needed. Run command? env echo hi');
  // Inside 400 ms, Enter and Space on a button do not answer.
  const allow = card.getByRole('button', { name: 'Allow once', exact: true });
  await allow.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press(' ');
  expect(await answers()).toEqual([]);
  // After it, the same key answers.
  await page.clock.runFor(401);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await answers()).length).toBe(1);
  expect((await answers())[0]).toMatchObject({ requestId: 'one', decision: 'allowOnce' });

  // A card that appears during a composition leaves focus in the composer until it ends.
  await show(page, []);
  const input = page.getByTestId('composer-input');
  await input.click();
  const cdp = await page.context().newCDPSession(page);
  await compose(cdp, 'ni');
  await show(page, [{ ...BASE, requestId: 'two', command: 'env echo two' }]);
  await expect(page.locator('[data-request-id="two"]')).toBeVisible();
  expect(await focusedCard(page)).toBeNull();
  await expect(input).toBeFocused();
  await cdp.send('Input.insertText', { text: '你' });
  await page.clock.runFor(1);
  await expect.poll(() => focusedCard(page)).toBe('two');
  await expect(input).toContainText('你');
});
