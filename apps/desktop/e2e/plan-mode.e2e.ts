// Plan mode as the user drives it, with the real Core, Agent Host and mock provider: a session
// started in Plan from the new-session page streams like any other turn, and the plan card is
// answered from the card, the panel or the composer. Screenshots go to tmp/evidence/plan-mode/
// with PIARC_EVIDENCE_TASK=plan-mode.
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';

import { expect, focusMain, makeWorkspace, openFolder, startSession, test } from './sessions.js';
import { idle, prefer, requests, send } from './t19.js';

async function shoot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}

/** A session in `scenario` whose first reply is in, switched to Plan, asked for a plan. */
async function planSession(
  app: ElectronApplication,
  page: Page,
  workspaces: string,
  name: string,
  scenario: string,
): Promise<void> {
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, name, { 'README.md': '# parser\n' });
  await openFolder(page, app, ws);
  await startSession(page, 'Hi', scenario);
  await focusMain(app);
  await expect(page.getByTestId('agent-message')).toHaveText(/Ready when you are/u, {
    timeout: 30_000,
  });
  await page.getByTestId('permission-mode').click();
  await page.getByTestId('menu-plan').click();
  await send(page, 'Plan the parser fix');
  await expect(page.locator('[data-approval-card="plan"]')).toHaveCount(1, { timeout: 30_000 });
}

/**
 * The tool results and user text blocks after the last assistant message: Pi sends a steering
 * message as a user message of its own right after the tool results (two adjacent user messages).
 */
function lastUserTurn(body: Record<string, unknown>): { results: string; texts: string[] } {
  const messages = (body.messages ?? []) as { role: string; content: unknown }[];
  const after = messages.slice(messages.findLastIndex((m) => m.role === 'assistant') + 1);
  const blocks = after.flatMap((m): Record<string, unknown>[] =>
    typeof m.content === 'string'
      ? [{ type: 'text', text: m.content }]
      : (m.content as Record<string, unknown>[]),
  );
  return {
    results: blocks
      .filter((b) => b.type === 'tool_result')
      .map((b) => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')))
      .join('\n'),
    texts: blocks.filter((b) => b.type === 'text').map((b) => String(b.text)),
  };
}

/** Selects `quote` in the plan panel's rendered text, as a mouse selection would. */
async function selectInPlan(page: Page, quote: string): Promise<void> {
  await page.getByTestId('plan-text').evaluate((container, text) => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(text) ?? -1;
      if (at >= 0) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + text.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        container.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        return;
      }
    }
    throw new Error(`no text ${text}`);
  }, quote);
}

test('a reply in the composer revises the plan, and comments on the rendered plan go too', async ({
  page,
  app,
  workspaces,
  mock,
}, info) => {
  test.setTimeout(120_000);
  await planSession(app, page, workspaces, 'plan review', 'plan-review');
  const card = page.locator('[data-approval-card="plan"]');
  // The card is a decision bar; the composer invites the reply.
  await expect(card.getByTestId('plan-stop')).toBeVisible();
  await expect(card).not.toContainText('Run the tests');
  await expect(page.locator('.conversation .composer-mount')).toHaveAttribute(
    'data-placeholder',
    'Reply to revise the plan',
  );
  // The panel shows the plan rendered: headings and emphasis, no Markdown syntax.
  const panel = page.getByTestId('plan-panel');
  await expect(panel).toHaveAttribute('data-state', 'pending');
  await expect(panel.locator('h1')).toHaveText('Fix the parser bound');
  await expect(panel.locator('strong')).toHaveText('failing test');
  await expect(page.getByTestId('plan-text')).not.toContainText('**');
  await shoot(page, info, 'plan-review-card');

  // A reply from the composer: the plan is sent back with it, the message follows the plan.
  await send(page, 'Add the failing test first, as its own file.');
  await expect(page.locator('[data-testid="plan-row"][data-status="declined"]')).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(page.locator('[data-testid="plan-row"]').last()).toContainText('bound.test.ts', {
    timeout: 30_000,
  });
  const sent = await requests(mock, 'plan-review');
  const reply = lastUserTurn(sent[2]?.body ?? {});
  expect(reply.results).toContain('their message comes right after this result');
  expect(reply.texts.join('\n')).toContain('Add the failing test first, as its own file.');
  const order = await page
    .locator('[data-testid="plan-row"], [data-testid="user-message"]')
    .evaluateAll((rows) =>
      rows.map((row) =>
        row.getAttribute('data-testid') === 'plan-row'
          ? `plan:${row.getAttribute('data-status') ?? ''}`
          : row.textContent,
      ),
    );
  expect(order.slice(-3)).toEqual([
    'plan:declined',
    'Add the failing test first, as its own file.',
    'plan:pending',
  ]);

  // A comment on the rendered plan: select, write, Enter; the card lists it and sends it.
  await expect(page.getByTestId('plan-text')).toContainText('bound.test.ts');
  await selectInPlan(page, 'bound.test.ts');
  const popover = page.getByTestId('plan-comment-popover');
  await expect(popover).toBeVisible();
  await page.getByTestId('plan-comment-input').fill('Name it after parse()');
  await shoot(page, info, 'plan-comment-popover');
  await page.getByTestId('plan-comment-input').press('Enter');
  await expect(popover).toHaveCount(0);
  await expect(card.getByTestId('plan-comment')).toHaveCount(1);
  await expect(card.getByTestId('plan-comment')).toContainText('Name it after parse()');
  const marked = await page.evaluate(() => CSS.highlights.get('piarc-plan-comment')?.size ?? 0);
  expect(marked).toBe(1);
  await shoot(page, info, 'plan-comment-marked');
  await card.getByTestId('plan-send-comments').click();
  await expect(page.locator('[data-testid="plan-row"]').last()).toContainText('for parse()', {
    timeout: 30_000,
  });
  const plan2 =
    '# Fix the parser bound\n\n1. Add the failing test `bound.test.ts`\n2. Fix the off-by-one in `parse()`\n3. Run the tests';
  const at = plan2.indexOf('bound.test.ts');
  const commented = lastUserTurn((await requests(mock, 'plan-review'))[3]?.body ?? {});
  expect(commented.results).toContain(
    `1. On "bound.test.ts" (offsets ${String(at)}-${String(at + 13)}): Name it after parse()`,
  );

  // Approve: the plan runs in Accept edits.
  await card.getByTestId('plan-approve-auto').click();
  await idle(page);
  await expect(page.getByTestId('permission-mode')).toHaveText(/Accept edits/u);
  await expect(page.getByTestId('plan-panel')).toHaveAttribute('data-state', 'approved');
  await shoot(page, info, 'plan-approved');
});

test('stop on the plan card ends the turn and leaves the session in Plan', async ({
  page,
  app,
  workspaces,
}, info) => {
  await planSession(app, page, workspaces, 'plan stop', 'plan-stop');
  const card = page.locator('[data-approval-card="plan"]');
  await card.getByTestId('plan-stop').click();
  await expect(card).toHaveCount(0, { timeout: 10_000 });
  await idle(page);
  await expect(page.locator('[data-testid="plan-row"]').last()).toHaveAttribute(
    'data-status',
    'interrupted',
  );
  await expect(page.getByTestId('permission-mode')).toHaveText(/Plan/u);
  await shoot(page, info, 'plan-stopped');
  await send(page, 'Never mind, keep the helper name.');
  await expect(page.getByTestId('agent-message').last()).toHaveText(/Stopped\. Tell me/u, {
    timeout: 30_000,
  });
});

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
