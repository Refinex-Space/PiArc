// T28 with the real Core, Agent Host and mock provider: the Changes panel (unified diff with line
// counts and syntax colors, discarding a hunk and a file, CRLF and the byte order mark kept,
// Mod+Shift+D, the note about command-only changes, plain text past the limits), the rewind
// dialog (files to restore or delete, the note about commands, the report), the conversation
// rewound with the message back in the input and the original branch kept, switching branches
// with the transcript and task list following, branching from a message into a new session and
// `/rewind`. Screenshots go to tmp/evidence/T28/ with PIARC_EVIDENCE_TASK=T28.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page, TestInfo } from '@playwright/test';

import { expect, test } from './sessions.js';
import { idle, openSession, requests, screenshots, send, userTexts } from './t19.js';

const ACCEPT_EDITS = JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } });

const NAMES = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'eleventh',
  'twelfth',
  'thirteenth',
  'fourteenth',
];
const NOTES =
  '﻿' + NAMES.map((name, i) => `export const ${name} = ${String(i + 1)};`).join('\r\n') + '\r\n';

async function shoot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}

function userRow(page: Page, text: string) {
  return page.getByTestId('user-row').filter({ hasText: text });
}

/** Sends `text` and waits for the agent's `reply` and the end of the turn. */
async function exchange(page: Page, text: string, reply: string): Promise<void> {
  await send(page, text);
  await expect(page.getByTestId('agent-message').filter({ hasText: reply })).toHaveCount(1, {
    timeout: 30_000,
  });
  await idle(page);
}

async function clearComposer(page: Page): Promise<void> {
  await page.getByTestId('composer-input').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
}

test('the Changes panel shows, highlights and discards the session’s changes', async ({
  page,
  app,
  workspaces,
}, info) => {
  const { ws } = await openSession(app, page, workspaces, 'changes', 't28-changes', 'Start.', {
    'notes.ts': NOTES,
    '.piarc/settings.json': ACCEPT_EDITS,
  });
  await idle(page);
  await exchange(page, 'Edit the files.', 'Edited two files.');
  expect(existsSync(path.join(ws, 'by-command.txt'))).toBe(true);

  // The rail's card: totals of what the file tools changed (not the command's file).
  await page.getByTestId('panel-tab-changes-card').click();
  const card = page.getByTestId('changes-card');
  await expect(card.getByTestId('changes-counts')).toHaveText('+5 −2');
  await page.getByTestId('changes-open').click();
  const panel = page.getByTestId('changes-panel');
  await expect(panel).toBeVisible();
  const files = panel.getByTestId('changes-file');
  await expect(files).toHaveCount(2);
  const noteRow = panel.locator('[data-testid="changes-file"][data-path="notes.ts"]');
  await expect(noteRow.getByTestId('changes-counts')).toHaveText('+2 −2');
  await expect(noteRow.getByTestId('changes-hunk')).toHaveCount(2);
  await expect(noteRow.getByTestId('changes-diff')).toHaveAttribute('data-highlight', 'ts');
  // Syntax colors: the highlight worker's tokens carry colors.
  await expect(noteRow.locator('.diff-text span[style]').first()).toBeVisible();
  await expect(panel.getByTestId('changes-bash-note')).toContainText('Bash');
  await expect(panel.locator('[data-path="by-command.txt"]')).toHaveCount(0);
  await screenshots(page, info, 'changes-panel');

  // Discard the second hunk: only the twelfth line goes back; CRLF and the BOM stay.
  await noteRow.getByTestId('changes-hunk').nth(1).getByTestId('changes-discard-hunk').click();
  await expect(noteRow.getByTestId('changes-counts')).toHaveText('+1 −1');
  const bytes = await readFile(path.join(ws, 'notes.ts'), 'utf8');
  expect(bytes.startsWith('﻿')).toBe(true);
  expect(bytes).toContain("export const second = 'two';\r\n");
  expect(bytes).toContain('export const twelfth = 12;\r\n');
  expect(bytes.replaceAll('\r\n', '')).not.toContain('\n');
  await shoot(page, info, 'changes-after-hunk');

  // Mod+Shift+D closes the panel and opens it again.
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+Shift+D`);
  await expect(panel).toHaveCount(0);
  await page.keyboard.press(`${mod}+Shift+D`);
  await expect(page.getByTestId('changes-panel')).toBeVisible();

  // Discard the created file: it is removed.
  const made = page.locator('[data-testid="changes-file"][data-path="src/made.ts"]');
  await made.getByTestId('changes-discard-file').click();
  await expect(made).toHaveCount(0);
  expect(existsSync(path.join(ws, 'src', 'made.ts'))).toBe(false);
  // A wide diff can temporarily fold the rail. Its summary still follows the discard.
  if (!(await card.isVisible())) await page.getByTestId('tool-rail').click();
  await expect(card.getByTestId('changes-counts')).toHaveText('+1 −1');
});

test('past the limits the Changes panel folds files and shows them as plain text', async ({
  page,
  app,
  workspaces,
}, info) => {
  await openSession(app, page, workspaces, 'degrade', 't28-degrade', 'Start.', {
    '.piarc/settings.json': ACCEPT_EDITS,
  });
  await idle(page);
  await exchange(page, 'Write a large file.', 'Wrote a large file.');
  await page.getByTestId('panel-tab-changes-card').click();
  await page.getByTestId('changes-open').click();
  const panel = page.getByTestId('changes-panel');
  await expect(panel.getByTestId('changes-degraded')).toBeVisible();
  const small = panel.locator('[data-testid="changes-file"][data-path="small.ts"]');
  await expect(small.getByTestId('changes-diff')).toHaveCount(0);
  await small.getByTestId('changes-toggle').click();
  await expect(small.getByTestId('changes-plain')).toContainText('+export const small = 1;');
  await expect(small.locator('.diff-text span[style]')).toHaveCount(0);
  await shoot(page, info, 'changes-degraded');
});

test('rewinding, switching branches and branching from a message', async ({
  page,
  app,
  workspaces,
  mock,
}, info) => {
  const { id, ws } = await openSession(app, page, workspaces, 'rewind', 't28-rewind', 'Start.', {
    '.piarc/settings.json': ACCEPT_EDITS,
  });
  await idle(page);
  await exchange(page, 'Plan the work.', 'Planned.');
  await exchange(page, 'Make the file.', 'Made the file.');
  expect(existsSync(path.join(ws, 'made.txt'))).toBe(true);

  // "Rewind to here" on the second request: the file it created goes away.
  const target = userRow(page, 'Make the file.');
  await target.hover();
  await target.getByTestId('rewind-here').click();
  const dialog = page.getByTestId('rewind-dialog');
  await expect(dialog.getByTestId('rewind-message')).toHaveText('Make the file.');
  const file = dialog.getByTestId('rewind-file');
  await expect(file).toHaveCount(1);
  await expect(file).toHaveAttribute('data-path', 'made.txt');
  await expect(file).toHaveAttribute('data-action', 'delete');
  await expect(dialog.getByTestId('rewind-bash-note')).toContainText('Bash');
  await screenshots(page, info, 'rewind-dialog');
  await dialog.getByTestId('rewind-confirm').click();
  const report = dialog.getByTestId('rewind-report');
  await expect(report).toHaveAttribute('data-completed', 'true');
  await expect(report.getByTestId('rewind-result')).toHaveAttribute('data-outcome', 'deleted');
  await expect(report.getByTestId('rewind-undo')).toBeVisible();
  await shoot(page, info, 'rewind-report');
  await dialog.getByTestId('rewind-close').click();
  expect(existsSync(path.join(ws, 'made.txt'))).toBe(false);

  // The conversation continues before the message, which is back in the input (focused, ready to
  // edit); the original branch is offered above it and the task list is the one of this point.
  await expect(page.getByTestId('composer-input')).toHaveText('Make the file.');
  await expect(page.getByTestId('composer-input')).toBeFocused();
  await expect(userRow(page, 'Make the file.')).toHaveCount(0);
  await expect(userRow(page, 'Plan the work.')).toHaveCount(1);
  const tail = page.getByTestId('branch-tail');
  await expect(tail).toContainText('Make the file.');
  const taskSection = page.getByTestId('panel-tab-tasks');
  if ((await taskSection.getAttribute('aria-expanded')) !== 'true') await taskSection.click();
  // In-progress items show their active form.
  await expect(page.getByTestId('task-panel')).toContainText('Planning the work');
  await expect(page.getByTestId('task-panel')).not.toContainText('Making the file');
  await shoot(page, info, 'rewound');

  await clearComposer(page);
  await exchange(page, 'Try another way.', 'Another way.');
  const sent = await requests(mock, 't28-rewind');
  const last = userTexts(sent[sent.length - 1]?.body ?? {}).join('\n');
  expect(last).toContain('Plan the work.');
  expect(last).toContain('Try another way.');
  expect(last).not.toContain('Make the file.');
  const fresh = userRow(page, 'Try another way.');
  await expect(fresh.getByTestId('branch-position')).toHaveText('2 / 2');
  await shoot(page, info, 'branch-switcher');

  // Back to the original branch: its messages and task list return.
  await fresh.getByTestId('branch-previous').click();
  await expect(userRow(page, 'Make the file.')).toHaveCount(1);
  await expect(page.getByTestId('agent-message').filter({ hasText: 'Made the file.' })).toHaveCount(
    1,
  );
  await expect(userRow(page, 'Try another way.')).toHaveCount(0);
  await expect(userRow(page, 'Make the file.').getByTestId('branch-position')).toHaveText('1 / 2');
  if ((await taskSection.getAttribute('aria-expanded')) !== 'true') await taskSection.click();
  await expect(page.getByTestId('task-panel')).toContainText('Making the file');
  await shoot(page, info, 'branch-switched');

  // "Branch from here": a new session stops before the message, which is in its input.
  const original = userRow(page, 'Make the file.');
  await original.hover();
  await original.getByTestId('branch-from-here').click();
  const conversation = page.getByTestId('conversation');
  await expect(conversation).not.toHaveAttribute('data-session-id', id);
  await expect(page.getByTestId('composer-input')).toHaveText('Make the file.');
  await expect(userRow(page, 'Plan the work.')).toHaveCount(1);
  await expect(userRow(page, 'Make the file.')).toHaveCount(0);
  await shoot(page, info, 'branch-from-here');

  // `/rewind` lists the branch's messages first.
  await clearComposer(page);
  await page.keyboard.type('/rewind');
  await page.keyboard.press('Enter');
  const picker = page.getByTestId('rewind-dialog');
  await expect(picker.getByTestId('rewind-turn')).toHaveCount(2);
  await shoot(page, info, 'rewind-command');
  await picker.getByTestId('rewind-turn').first().click();
  await expect(picker.getByTestId('rewind-message')).toHaveText('Plan the work.');
  await picker.getByTestId('rewind-cancel').click();
  await expect(picker).toHaveCount(0);
});
