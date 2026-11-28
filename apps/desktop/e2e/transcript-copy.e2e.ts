// T09-A10: selecting across blocks (and messages) and copying gives the text in order, without
// the transcript's own labels and buttons; "copy this message" gives the Markdown source or the
// plain text. The clipboard is read in the main process and restored after each test.
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures.js';
import { addMessage, openLab, readClipboard, settled, withSavedClipboard } from './transcript.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const MESSAGE = [
  'First paragraph with **bold** text.',
  '',
  '- item one',
  '- item two',
  '',
  '```ts',
  'const a = 1;',
  '  const b = 2;',
  '```',
  '',
  'After the code, see [docs](https://example.com/docs).',
].join('\n');

test.beforeEach(async ({ page }) => {
  await openLab(page);
});

/** Selects from `startText` (inclusive) to `endText` (exclusive) across the transcript. */
async function select(page: Page, startText: string, endText: string): Promise<void> {
  await page.evaluate(
    ({ from, to }) => {
      const transcript = document.querySelector('[data-testid="transcript"]');
      if (transcript === null) {
        throw new Error('no transcript');
      }
      const walker = document.createTreeWalker(transcript, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) {
        if (walker.currentNode instanceof Text) {
          nodes.push(walker.currentNode);
        }
      }
      const start = nodes.find((node) => node.data.includes(from));
      const end = nodes.findLast((node) => node.data.includes(to));
      if (start === undefined || end === undefined) {
        throw new Error(`text not found: ${from} … ${to}`);
      }
      const range = document.createRange();
      range.setStart(start, start.data.indexOf(from));
      range.setEnd(end, end.data.indexOf(to));
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    { from: startText, to: endText },
  );
}

test('copies a selection across a paragraph, a list and a code block', async ({ app, page }) => {
  const id = await addMessage(page, MESSAGE);
  await settled(page, id);
  await expect(page.locator(`[data-row-id="${id}"] [data-testid="code-block"]`)).toHaveAttribute(
    'data-highlight',
    'highlighted',
  );
  await withSavedClipboard(app, async () => {
    await select(page, 'paragraph with', ', see');
    await page.keyboard.press(`${MOD}+C`);
    await expect
      .poll(() => readClipboard(app))
      .toBe(
        [
          'paragraph with bold text.',
          '',
          'item one',
          'item two',
          'const a = 1;',
          '  const b = 2;',
          'After the code',
        ].join('\n'),
      );
  });
});

test('copies a selection across two messages without the buttons between them', async ({
  app,
  page,
}) => {
  const first = await addMessage(page, 'The first message ends here.');
  const second = await addMessage(page, 'The second message starts here.');
  await settled(page, first);
  await settled(page, second);
  // Both replies are in one turn: only the last carries the actions (ADR-0078).
  await expect(page.getByTestId('message-actions')).toHaveCount(1);
  await withSavedClipboard(app, async () => {
    await select(page, 'message ends', ' starts here');
    await page.keyboard.press(`${MOD}+C`);
    await expect.poll(() => readClipboard(app)).toBe('message ends here.\n\nThe second message');
  });
});

test('copies a whole message as Markdown or as plain text', async ({ app, page }, testInfo) => {
  const id = await addMessage(page, MESSAGE);
  await settled(page, id);
  const row = page.locator(`[data-row-id="${id}"]`);
  await withSavedClipboard(app, async () => {
    await row.getByRole('button', { name: 'Copy Markdown' }).click();
    await expect.poll(() => readClipboard(app)).toBe(MESSAGE);
    await expect(row.getByRole('button', { name: 'Copied' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('copied.png') });

    await row.getByRole('button', { name: 'Copy text' }).click();
    await expect
      .poll(() => readClipboard(app))
      .toBe(
        [
          'First paragraph with bold text.',
          '',
          '• item one\n• item two',
          '',
          'const a = 1;\n  const b = 2;',
          '',
          'After the code, see docs (https://example.com/docs).',
        ].join('\n'),
      );
  });
});
