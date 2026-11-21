// T42 with the real Core, Agent Host and mock provider: comments on the Changes panel's diff
// lines (FR-RV-04). Comments on both sides and on a range, across two files, edited and deleted;
// Mod+Enter sends them as one message (path, range, side, excerpt and body checked in the mock's
// request); sent while the agent works they wait in the queue and reach the model after the turn.
// Screenshots go to tmp/evidence/T42/ with PIARC_EVIDENCE_TASK=T42.
import type { Locator, Page } from '@playwright/test';

import { expect, test } from './sessions.js';
import { idle, openSession, requests, screenshots, send, userTexts } from './t19.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const SCENARIO = 't42-comments';
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
const NOTES = NAMES.map((name, i) => `export const ${name} = ${String(i + 1)};`).join('\n') + '\n';

function file(page: Page, label: string): Locator {
  return page.locator(`[data-testid=changes-file][data-path="${label}"]`);
}

function gutter(scope: Locator, side: 'old' | 'new', line: number): Locator {
  return scope.locator(
    `[data-testid=changes-comment-add][data-side=${side}][data-line="${String(line)}"]`,
  );
}

/** Opens a comment on `side` line `line` of `scope` and writes `text` (not saved). */
async function write(
  page: Page,
  scope: Locator,
  side: 'old' | 'new',
  line: number,
  text: string,
): Promise<void> {
  await gutter(scope, side, line).click();
  const input = page.getByTestId('changes-comment-input');
  await expect(input).toBeFocused();
  await input.fill(text);
}

async function save(page: Page): Promise<void> {
  await page.getByTestId('changes-comment-save').click();
  await expect(page.getByTestId('changes-comment-editor')).toHaveCount(0);
}

function comment(page: Page, text: string): Locator {
  return page.getByTestId('changes-comment').filter({ hasText: text });
}

test('comments on diff lines go to the agent together, queued while it works', async ({
  app,
  page,
  mock,
  workspaces,
}, info) => {
  test.setTimeout(120_000);
  await openSession(app, page, workspaces, 'comments 评论', SCENARIO, 'Start.', {
    'notes.ts': NOTES,
    '.piarc/settings.json': ACCEPT_EDITS,
  });
  await idle(page);
  await send(page, 'Edit the files.');
  await expect(
    page.getByTestId('agent-message').filter({ hasText: 'Edited two files.' }),
  ).toHaveCount(1, { timeout: 30_000 });
  await idle(page);

  await page.getByTestId('panel-tab-changes-card').click();
  await page.getByTestId('changes-card').getByTestId('changes-open').click();
  const notes = file(page, 'notes.ts');
  const made = file(page, 'src/made.ts');
  await expect(notes).toBeVisible();
  await expect(made).toBeVisible();

  // The new side of line 2, by keyboard: the line number is a button.
  await gutter(notes, 'new', 2).focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('changes-comment-input').fill('Why a string?');
  await save(page);
  // A range on the new side: Shift+click stretches the comment being started.
  await gutter(notes, 'new', 11).click();
  await gutter(notes, 'new', 12).click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('changes-comment-editor')).toContainText('Lines 11–12');
  await page.getByTestId('changes-comment-input').fill('Keep these two together.');
  await save(page);
  // The old side of line 2.
  await write(page, notes, 'old', 2, 'The number was fine.');
  await save(page);
  // One more, deleted again.
  await write(page, notes, 'new', 4, 'Never mind.');
  await save(page);
  await comment(page, 'Never mind.').getByTestId('changes-comment-delete').click();
  await expect(comment(page, 'Never mind.')).toHaveCount(0);
  // Edit the first one.
  await comment(page, 'Why a string?').getByTestId('changes-comment-edit').click();
  await page.getByTestId('changes-comment-input').fill('Why a string here?');
  await save(page);
  await expect(comment(page, 'Why a string here?')).toHaveCount(1);
  await comment(page, 'The number was fine.').scrollIntoViewIfNeeded();
  await screenshots(page, info, 'comments-saved');
  // A second file, left in the editor for the screenshots.
  await write(page, made, 'new', 2, 'Return the name instead.');
  await expect(page.getByTestId('changes-comments-count')).toHaveText('3 comments not sent');
  await screenshots(page, info, 'comments');

  // Mod+Enter in the editor keeps that comment and sends all four as one message.
  await page.keyboard.press(`${MOD}+Enter`);
  await expect(
    page.getByTestId('agent-message').filter({ hasText: 'Read your comments.' }),
  ).toHaveCount(1, { timeout: 30_000 });
  await idle(page);
  await expect(page.getByTestId('changes-comments-bar')).toHaveCount(0);
  const expected = [
    'Review comments on the changes:',
    '',
    '## notes.ts',
    '',
    'Line 2 (new version):',
    '```',
    "export const second = 'two';",
    '```',
    'Why a string here?',
    '',
    'Line 2 (old version):',
    '```',
    'export const second = 2;',
    '```',
    'The number was fine.',
    '',
    'Lines 11-12 (new version):',
    '```',
    'export const eleventh = 11;',
    "export const twelfth = 'twelve';",
    '```',
    'Keep these two together.',
    '',
    '## src/made.ts',
    '',
    'Line 2 (new version):',
    '```',
    "  return 'made';",
    '```',
    'Return the name instead.',
  ].join('\n');
  let sent = await requests(mock, SCENARIO);
  expect(userTexts(sent.at(-1)?.body ?? {}).at(-1)).toBe(expected);
  expect(sent.flatMap((r) => userTexts(r.body)).filter((t) => t.includes('Never mind'))).toEqual(
    [],
  );

  // While the agent works (waiting for an approval), the comments wait in the queue.
  await send(page, 'Wait for the signal.');
  await expect(page.getByTestId('composer')).toHaveAttribute('data-running', 'true', {
    timeout: 20_000,
  });
  const allow = page
    .locator('[data-approval-card=command] button')
    .filter({ hasText: /^Allow once$/u });
  await expect(allow).toBeVisible({ timeout: 20_000 });
  await write(page, made, 'new', 1, 'Name it differently.');
  await page.keyboard.press(`${MOD}+Enter`);
  const queued = page.getByTestId('queue-item').filter({ hasText: 'Review comments' });
  await expect(queued).toHaveAttribute('data-kind', 'followUp');
  await expect(page.getByTestId('changes-comments-bar')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('comments-queued.png') });
  const before = (await requests(mock, SCENARIO)).length;
  await allow.click();
  await expect(
    page.getByTestId('agent-message').filter({ hasText: 'Read the queued comments.' }),
  ).toHaveCount(1, { timeout: 30_000 });
  await idle(page);
  sent = await requests(mock, SCENARIO);
  const after = sent.slice(before);
  // The turn finished first (the command's result, then "Waited."), then the comments.
  expect(after).toHaveLength(2);
  expect(userTexts(after[0]?.body ?? {}).some((t) => t.includes('Name it differently.'))).toBe(
    false,
  );
  expect(userTexts(after[1]?.body ?? {}).at(-1)).toBe(
    [
      'Review comments on the changes:',
      '',
      '## src/made.ts',
      '',
      'Line 1 (new version):',
      '```',
      'export function made(): string {',
      '```',
      'Name it differently.',
    ].join('\n'),
  );
});
