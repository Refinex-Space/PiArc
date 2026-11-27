// T26 with the real Core, Agent Host and mock provider: the plan card and panel (inline comments,
// keep planning, both approvals and their mode records), the task card and the rail's task
// list, the question form (three kinds of answer, and a timeout) and the next-step suggestions.
// Screenshots go to tmp/evidence/T26/ with PIARC_EVIDENCE_TASK=T26.
import type { Page, TestInfo } from '@playwright/test';

import { expect, test } from './sessions.js';
import { idle, lastUserBlocks, openSession, requests, send } from './t19.js';

const PLAN1 =
  '# Plan\n\n1. Read src/parser.ts\n2. Fix the off-by-one in the loop\n3. Add a regression test';

async function shoot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}

/** Selects `quote` inside the plan panel's text, as a mouse selection would. */
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

/** The text of every tool result in a request body. */
function toolResults(body: Record<string, unknown>): string[] {
  const messages = (body.messages ?? []) as { role: string; content: unknown }[];
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as { type: string; content?: unknown }[])
          .filter((block) => block.type === 'tool_result')
          .map((block) =>
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
          )
      : [],
  );
}

test('plan card: inline comments with keep planning, then both approvals switch modes', async ({
  page,
  app,
  workspaces,
  mock,
}, info) => {
  await openSession(app, page, workspaces, 'plan mode', 't26-plan', 'Fix the parser bug');
  const card = page.locator('[data-approval-card="plan"]');
  await expect(card).toHaveCount(1);
  await expect(page.locator('[data-testid="plan-row"]').last()).toContainText(
    'Fix the off-by-one in the loop',
  );
  await expect(page.getByTestId('permission-mode')).toHaveText(/Plan/u);
  await expect(page.getByTestId('mode-change-row').first()).toContainText('Plan');
  // The plan panel opens with the whole plan rendered; comment on a passage there (ADR-0103).
  const panel = page.getByTestId('plan-panel');
  await expect(panel).toHaveAttribute('data-state', 'pending');
  await selectInPlan(page, 'Fix the off-by-one in the loop');
  await page.getByTestId('plan-comment-input').fill('Which loop? Add a failing test first.');
  await page.getByTestId('plan-comment-add').click();
  await expect(card.getByTestId('plan-comment')).toHaveCount(1);
  await expect(card.getByTestId('plan-comment')).toContainText('Fix the off-by-one in the loop');
  await shoot(page, info, 'plan-card-with-comment');
  // The reply goes from the composer, with the comment.
  await send(page, 'Start with the test.');

  // The model hears the refusal with the comment and its UTF-16 anchor, then the reply; plan
  // mode stays on.
  await expect(page.locator('[data-testid="plan-row"]').last()).toContainText(
    'Add a failing test for the loop bound',
    { timeout: 30_000 },
  );
  const second = page.locator('[data-approval-card="plan"]');
  const start = PLAN1.indexOf('Fix the off-by-one in the loop');
  const end = start + 'Fix the off-by-one in the loop'.length;
  const sent = await requests(mock, 't26-plan');
  const revised = toolResults(sent[2]?.body ?? {}).join('\n');
  expect(revised).toContain('Plan mode stays on');
  expect(revised).toContain('their message comes right after this result');
  expect(revised).toContain(
    `1. On "Fix the off-by-one in the loop" (offsets ${String(start)}-${String(end)}): Which loop? Add a failing test first.`,
  );
  expect(JSON.stringify(lastUserBlocks(sent[2]?.body ?? {}))).toContain('Start with the test.');
  await expect(page.getByTestId('permission-mode')).toHaveText(/Plan/u);
  await expect(page.locator('[data-testid="plan-row"][data-status="declined"]')).toHaveCount(1);

  // Approve and review edits: the mode becomes Manual and the transcript records it.
  await second.getByTestId('plan-approve-manual').click();
  await idle(page);
  await expect(page.getByTestId('permission-mode')).toHaveText(/Manual/u);
  await expect(page.getByTestId('mode-change-row').last()).toContainText('Manual');
  await expect(page.locator('[data-testid="plan-row"][data-status="approved"]')).toHaveCount(1);
  await expect(page.getByTestId('plan-panel')).toHaveAttribute('data-state', 'approved');
  await shoot(page, info, 'plan-approved-manual');

  // Plan again, then approve and accept edits.
  await send(page, 'Now plan the rename.');
  const third = page.locator('[data-approval-card="plan"]');
  await expect(page.locator('[data-testid="plan-row"]').last()).toContainText('Rename the helper');
  await expect(page.getByTestId('permission-mode')).toHaveText(/Plan/u);
  await third.getByTestId('plan-approve-auto').click();
  await idle(page);
  await expect(page.getByTestId('permission-mode')).toHaveText(/Accept edits/u);
  await expect(page.getByTestId('mode-change-row').last()).toContainText('Accept edits');
  // Rows scrolled out of the virtual list are not mounted: the earlier records were checked when
  // they appeared; the last two belong to the rename plan.
  const modes = await page.getByTestId('mode-change-row').allTextContents();
  expect(modes.slice(-2).map((text) => /changed to (.+)$/u.exec(text)?.[1])).toEqual([
    'Plan',
    'Accept edits',
  ]);
  await shoot(page, info, 'plan-approved-accept-edits');
  // The approved plan's tool result tells the model the mode it continues in.
  const last = await requests(mock, 't26-plan');
  expect(toolResults(last.at(-1)?.body ?? {}).join('\n')).toContain(
    'The user approved the plan. Plan mode is off. The permission mode is now Accept edits',
  );
});

test('task card and the rail task list follow TodoWrite', async ({
  page,
  app,
  workspaces,
}, info) => {
  await openSession(app, page, workspaces, 'todo list', 't26-todo', 'Fix the loop bound');
  await idle(page);
  // The latest list is the card; the earlier one is a line naming the change, opening to it.
  const card = page.getByTestId('task-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('task-count')).toHaveText('2/3 done');
  const earlier = page.getByTestId('task-update');
  await expect(earlier).toHaveCount(1);
  await expect(earlier).toContainText('1/3 done');
  await earlier.locator('button').click();
  await expect(earlier.locator('[data-status="inProgress"]')).toHaveText(/Fixing the loop bound/u);
  const rail = page.getByTestId('task-panel');
  await expect(rail).toBeVisible();
  await expect(rail.getByTestId('task-count')).toHaveText('2/3 done');
  const tasks = rail.getByTestId('task');
  await expect(tasks).toHaveCount(3);
  await expect(tasks.nth(0)).toHaveAttribute('data-status', 'completed');
  await expect(tasks.nth(1)).toHaveAttribute('data-status', 'completed');
  await expect(tasks.nth(2)).toHaveAttribute('data-status', 'inProgress');
  await expect(tasks.nth(2)).toHaveText(/Adding a regression test/u);
  await shoot(page, info, 'task-card-and-rail');
});

test('question form: single, multiple and own answers reach the model structured', async ({
  page,
  app,
  workspaces,
  mock,
}, info) => {
  await openSession(app, page, workspaces, 'questions', 't26-ask', 'Set up the project');
  const form = page.locator('[data-approval-card="question"]');
  await expect(form.getByTestId('question')).toHaveCount(3);
  await form.getByLabel('Postgres').check();
  await form.getByLabel('macOS').check();
  await form.getByLabel('Windows').check();
  await form.getByTestId('question').nth(2).getByTestId('question-other').fill('PiArc Desktop');
  await shoot(page, info, 'question-form');
  await form.getByTestId('question-submit').click();
  await idle(page);
  await expect(page.getByTestId('question-row')).toContainText('PiArc Desktop');
  const sent = await requests(mock, 't26-ask');
  const result = toolResults(sent[1]?.body ?? {}).join('\n');
  expect(result).toContain(
    '{"question":"Which database?","outcome":"answered","selected":["Postgres"]}',
  );
  expect(result).toContain(
    '{"question":"Which platforms?","outcome":"answered","selected":["macOS","Windows"]}',
  );
  expect(result).toContain(
    '{"question":"What should the project be called?","outcome":"answered","selected":[],"other":"PiArc Desktop"}',
  );
  await shoot(page, info, 'question-answered');
});

test('question form: a timeout takes the default option or reports no answer', async ({
  page,
  app,
  workspaces,
  mock,
}, info) => {
  await openSession(app, page, workspaces, 'question timeout', 't26-ask-timeout', 'Ask me', {
    '.piarc/settings.json': JSON.stringify({ askUserQuestion: { timeoutSeconds: 2 } }),
  });
  const form = page.locator('[data-approval-card="question"]');
  await expect(form).toBeVisible();
  await expect(form).toHaveCount(0, { timeout: 15_000 });
  await idle(page);
  const rows = page.getByTestId('question-row');
  await expect(rows).toContainText('Timed out: the default was used');
  await expect(rows).toContainText('Timed out without an answer');
  const sent = await requests(mock, 't26-ask-timeout');
  const result = toolResults(sent[1]?.body ?? {}).join('\n');
  expect(result).toContain(
    '{"question":"Which database?","outcome":"default","selected":["SQLite"]}',
  );
  expect(result).toContain('{"question":"Which port?","outcome":"unanswered","selected":[]}');
  await shoot(page, info, 'question-timed-out');
});

test('next steps: run here sends the next input, a new session starts with the suggestion', async ({
  page,
  app,
  workspaces,
  mock,
}, info) => {
  const { id } = await openSession(app, page, workspaces, 'next steps', 't26-next', 'Fix it');
  await idle(page);
  const steps = page.getByTestId('next-step');
  await expect(steps).toHaveCount(2);
  await shoot(page, info, 'next-steps');
  await steps.nth(0).getByTestId('next-run-here').click();
  await expect(page.getByTestId('user-message').last()).toContainText(
    'Run the whole test suite and report failures.',
  );
  // The composer is idle before the new turn starts too: wait for the request itself.
  await expect.poll(async () => (await requests(mock, 't26-next')).length).toBe(3);
  await idle(page);
  const here = await requests(mock, 't26-next');
  expect(here).toHaveLength(3);
  expect(lastUserBlocks(here[2]?.body ?? {}).map((block) => block.text)).toEqual([
    'Run the whole test suite and report failures.',
  ]);
  await steps.nth(1).getByTestId('next-new-session').click();
  const conversation = page.getByTestId('conversation');
  await expect(conversation).not.toHaveAttribute('data-session-id', id);
  await expect(page.getByTestId('user-message').first()).toContainText(
    'Write a release note for the parser fix',
  );
  await idle(page);
  await expect(page.getByTestId('agent-message').last()).toContainText('Here is the release note.');
  const fresh = await requests(mock, 't26-next-new');
  expect(fresh).toHaveLength(1);
  expect(JSON.stringify(lastUserBlocks(fresh[0]?.body ?? {}))).toContain(
    'Write a release note for the parser fix',
  );
  await shoot(page, info, 'next-step-new-session');
});
