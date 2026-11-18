// T19-A01, A03: a real turn from the mock through Core and the Agent Host — every P0 row type on
// screen (screenshots in both themes), and the working row going through its phases: the
// current tool, the timer, the token count, the automatic retry (n / max) and the compaction.
import { expect, test } from './sessions.js';
import { readClipboard, withSavedClipboard } from './transcript.js';
import { idle, openSession, screenshots, seedCompaction, send } from './t19.js';

const FILES = {
  'src/main.ts': '// TODO: greet\nexport const greet = (name: string) => `Hi ${name}`;\n',
};

test.beforeEach(async ({ userDataDir }) => {
  await seedCompaction(userDataDir, 1500);
});

test('the P0 rows of a real turn, and the working row through its phases', async ({
  app,
  page,
  workspaces,
}, testInfo) => {
  test.setTimeout(120_000);
  await openSession(
    app,
    page,
    workspaces,
    'rows 行',
    't19-rows',
    'Resolve the TODO in src/main.ts',
    FILES,
  );
  const working = page.getByTestId('working-row');
  const activity = page.getByTestId('working-activity');
  // Thinking, then the tool calls of the first response.
  await expect(page.getByTestId('thinking-block').first()).toBeVisible({ timeout: 20_000 });
  await expect(working).toBeVisible();
  await expect(page.getByTestId('working-elapsed')).toHaveText(/\d+ s/u);
  // The command runs about two seconds: the working row names it.
  await expect(activity).toHaveText('Bash · sleep 2; echo checked', { timeout: 20_000 });
  await screenshots(page, testInfo, 'working-tool');
  await expect(page.getByTestId('working-tokens')).toHaveText(/\d[\d,]* tokens/u);
  // The third response is a 429: Pi retries it, the working row counts.
  await expect(page.getByTestId('working-retry')).toHaveText('Retrying 1/3', { timeout: 20_000 });
  await page.screenshot({ path: testInfo.outputPath('working-retry.png') });
  await idle(page);

  await expect(page.getByTestId('user-message').first()).toContainText('Resolve the TODO');
  await expect(page.getByTestId('agent-message').last()).toContainText('now resolved');
  await expect(
    page.locator('[data-testid="agent-message"] [data-testid="code-block"]'),
  ).toHaveCount(1);
  const thinking = page.getByTestId('thinking-block').first();
  await expect(thinking).toHaveAttribute('data-expanded', 'false');
  await expect(page.getByTestId('thinking-label').first()).toHaveText(
    /^Thought for \d+ seconds?$/u,
  );
  const groups = page.getByTestId('tool-group');
  await expect(groups.first()).toContainText('Read main.ts · Searched “TODO”');
  const bash = page.getByTestId('bash-card');
  await expect(bash).toHaveAttribute('data-outcome', 'success');
  await expect(bash.getByTestId('bash-command')).toHaveText('$ sleep 2; echo checked');
  await expect(bash.getByTestId('bash-exit')).toHaveText('exit 0');
  // The edit is a group of one; opening it shows the file change card with Core's diff.
  const edit = groups.filter({ hasText: 'Edited main.ts' });
  await expect(edit.getByTestId('tool-lines')).toHaveText('+1 −1');
  await edit.getByTestId('tool-group-toggle').click();
  const change = page.getByTestId('file-change-card');
  await expect(change.getByTestId('file-change-path')).toHaveText('src/main.ts');
  await expect(change.locator('.diff-line[data-kind="added"]')).toContainText(
    '// Greets the user.',
  );
  await thinking.getByTestId('thinking-toggle').click();
  await expect(thinking).toHaveAttribute('data-expanded', 'true');
  await screenshots(page, testInfo, 'rows');
  // Capture each row itself: the virtual list may extend beyond one window.
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(
      (value) => window.piarc.setPreference({ key: 'appearance.theme', value }),
      theme,
    );
    await expect(page.locator('html')).toHaveAttribute('data-color-mode', theme);
    for (const kind of [
      'user-row',
      'agent-message',
      'thinking-block',
      'tool-group',
      'bash-card',
      'file-change-card',
    ]) {
      await page
        .getByTestId(kind)
        .last()
        .screenshot({ path: testInfo.outputPath(`${kind}-${theme}.png`) });
    }
  }

  // `/compact`: a turn of its own; the working row shows the compaction, then the notice.
  await send(page, '/compact');
  await expect(activity).toHaveText('Compacting the conversation', { timeout: 20_000 });
  await page.screenshot({ path: testInfo.outputPath('working-compaction.png') });
  await idle(page);
  await expect(page.getByTestId('compaction-row')).toContainText('Conversation compacted');
  await screenshots(page, testInfo, 'compaction');
});

test('copies the source and visible text and selects only the requested turn', async ({
  app,
  page,
  workspaces,
}) => {
  await openSession(app, page, workspaces, 'copy 选择', 't19-chat', 'First question');
  const first = page.getByTestId('agent-message').first();
  await expect(first).toHaveText(/First\./u);
  await idle(page);
  await send(page, 'Second question');
  await expect(page.getByTestId('agent-message').last()).toContainText('Second.');
  await idle(page);
  await withSavedClipboard(app, async () => {
    await first.getByRole('button', { name: 'Copy Markdown' }).click();
    await expect.poll(() => readClipboard(app)).toBe('**First**.');
    await first.getByRole('button', { name: 'Copy text' }).click();
    await expect.poll(() => readClipboard(app)).toBe('First.');
  });
  await first.getByTestId('select-turn').click();
  const selected = await page.evaluate(() => window.getSelection()?.toString());
  expect(selected).toContain('First question');
  expect(selected).toContain('First.');
  expect(selected).not.toContain('Second');
});
