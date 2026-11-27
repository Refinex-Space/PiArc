// Plan mode as the user drives it, with the real Core, Agent Host and mock provider: a session
// started in Plan from the new-session page streams like any other turn, and the plan card is
// answered from the card, the panel or the composer. Screenshots go to tmp/evidence/plan-mode/
// with PIARC_EVIDENCE_TASK=plan-mode.
import type { Page, TestInfo } from '@playwright/test';

import { expect, focusMain, makeWorkspace, openFolder, startSession, test } from './sessions.js';
import { prefer } from './t19.js';

async function shoot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}

test('a session started in Plan from the new-session page streams while it plans', async ({
  page,
  app,
  workspaces,
}, info) => {
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'plan live', {});
  await openFolder(page, app, ws);
  await page.getByTestId('home-mode').click();
  await page.getByTestId('menu-plan').click();
  await startSession(page, 'Plan the parser fix', 'plan-live');
  await focusMain(app);
  // The model is still writing: its text, the working row and the stop button are on screen
  // before any plan card.
  await expect(page.getByTestId('conversation')).toContainText('Reading the parser', {
    timeout: 5_000,
  });
  await expect(page.getByTestId('composer')).toHaveAttribute('data-running', 'true');
  await expect(page.getByTestId('working-row')).toHaveCount(1);
  await shoot(page, info, 'plan-streaming');
  await expect(page.locator('[data-approval-card="plan"]')).toHaveCount(1, { timeout: 30_000 });
});

test('a second session in a trusted workspace started in Plan streams while it plans', async ({
  page,
  app,
  workspaces,
}) => {
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'plan trusted', { 'README.md': '# parser\n' });
  await openFolder(page, app, ws);
  await startSession(page, 'Say hello', 't18-chat');
  await expect(page.getByTestId('agent-message')).toHaveText(/Done\./u, { timeout: 30_000 });
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('home')).toBeVisible();
  await page.getByTestId('tool-files').click();
  await page.getByTestId('home-mode').click();
  await page.getByTestId('menu-plan').click();
  await startSession(page, 'Plan the parser fix', 'plan-live', 'none');
  await focusMain(app);
  await expect(page.getByTestId('conversation')).toContainText('Reading the parser', {
    timeout: 5_000,
  });
  await expect(page.getByTestId('composer')).toHaveAttribute('data-running', 'true');
  await expect(page.locator('[data-approval-card="plan"]')).toHaveCount(1, { timeout: 30_000 });
});

test('Plan chosen in a conversation: thinking, tool calls and text stream before the card', async ({
  page,
  app,
  workspaces,
}, info) => {
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'plan real', { 'README.md': '# parser\n' });
  await openFolder(page, app, ws);
  await startSession(page, 'Hi', 'plan-real');
  await focusMain(app);
  await expect(page.getByTestId('agent-message')).toHaveText(/Ready when you are/u, {
    timeout: 30_000,
  });
  await page.getByTestId('permission-mode').click();
  await page.getByTestId('menu-plan').click();
  await expect(page.getByTestId('permission-mode')).toHaveText(/Plan/u);
  await page.getByTestId('composer-input').click();
  await page.keyboard.type('Plan the parser fix');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('composer')).toHaveAttribute('data-running', 'true', {
    timeout: 5_000,
  });
  await expect(page.getByTestId('working-row')).toHaveCount(1);
  await expect(page.getByTestId('conversation')).toContainText('Let me read the project', {
    timeout: 10_000,
  });
  await shoot(page, info, 'plan-conversation-streaming');
  await expect(page.locator('[data-approval-card="plan"]')).toHaveCount(1, { timeout: 30_000 });
  await shoot(page, info, 'plan-conversation-card');
});

test('a model that only thinks and calls tools while planning still shows its work', async ({
  page,
  app,
  workspaces,
}, info) => {
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'plan silent', { 'README.md': '# parser\n' });
  await openFolder(page, app, ws);
  await startSession(page, 'Hi', 'plan-silent');
  await focusMain(app);
  await expect(page.getByTestId('agent-message')).toHaveText(/Ready when you are/u, {
    timeout: 30_000,
  });
  await page.getByTestId('permission-mode').click();
  await page.getByTestId('menu-plan').click();
  await page.getByTestId('composer-input').click();
  await page.keyboard.type('Plan the parser fix');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('composer')).toHaveAttribute('data-running', 'true', {
    timeout: 5_000,
  });
  await page.waitForTimeout(1_500);
  await shoot(page, info, 'plan-silent-thinking');
  await page.waitForTimeout(2_500);
  await shoot(page, info, 'plan-silent-tools');
  await expect(page.locator('[data-approval-card="plan"]')).toHaveCount(1, { timeout: 30_000 });
});

test('a window that missed the start of a running turn still shows it running', async ({
  page,
  app,
  workspaces,
}, info) => {
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'plan reload', { 'README.md': '# parser\n' });
  await openFolder(page, app, ws);
  const id = await startSession(page, 'Hi', 'plan-silent');
  await focusMain(app);
  await expect(page.getByTestId('agent-message')).toHaveText(/Ready when you are/u, {
    timeout: 30_000,
  });
  await page.getByTestId('permission-mode').click();
  await page.getByTestId('menu-plan').click();
  await page.getByTestId('composer-input').click();
  await page.keyboard.type('Plan the parser fix');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('composer')).toHaveAttribute('data-running', 'true');
  // The page loads again while the model thinks: it never sees this turn's `turn/started`.
  await page.reload();
  await page
    .locator(`[data-testid="session-row"][data-session-id="${id}"]`)
    .getByTestId('session-title')
    .click();
  await expect(page.getByTestId('conversation')).toHaveAttribute('data-session-id', id);
  await expect(page.getByTestId('composer')).toHaveAttribute('data-running', 'true', {
    timeout: 3_000,
  });
  await expect(page.getByTestId('composer-stop')).toBeVisible();
  await expect(page.getByTestId('working-row')).toHaveCount(1);
  await shoot(page, info, 'plan-reload-running');
  await expect(page.locator('[data-approval-card="plan"]')).toHaveCount(1, { timeout: 30_000 });
});

test('a draft session (a tool opened first) started in Plan streams while it plans', async ({
  page,
  app,
  workspaces,
}, info) => {
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'plan draft', { 'README.md': '# parser\n' });
  await openFolder(page, app, ws);
  // A tool opened on the new-session page makes a draft session the message then goes to.
  await page.getByTestId('tool-files').click();
  await expect(page.getByRole('treeitem', { name: 'README.md', exact: true })).toBeVisible();
  await page.getByTestId('home-mode').click();
  await page.getByTestId('menu-plan').click();
  await startSession(page, 'Plan the parser fix', 'plan-live');
  await focusMain(app);
  await expect(page.getByTestId('conversation')).toContainText('Reading the parser', {
    timeout: 5_000,
  });
  await expect(page.getByTestId('composer')).toHaveAttribute('data-running', 'true');
  await expect(page.getByTestId('working-row')).toHaveCount(1);
  await shoot(page, info, 'plan-draft-streaming');
  await expect(page.locator('[data-approval-card="plan"]')).toHaveCount(1, { timeout: 30_000 });
});
