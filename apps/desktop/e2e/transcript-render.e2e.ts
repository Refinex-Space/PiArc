// T09-A06 and the streaming render rules (architecture section 8.4): code is highlighted in the
// worker, a streaming code block shows plain text until its fence closes, open markup is closed
// while streaming, and a streaming delta re-renders only the streaming row.
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures.js';
import {
  addMessage,
  loadHistory,
  openLab,
  renderCounts,
  resetRenderCounts,
  settled,
  streamTurn,
} from './transcript.js';

test.beforeEach(async ({ page }) => {
  await openLab(page);
});

/** Records the states the first code block of the streaming row goes through. */
async function watchCodeBlock(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen = new Set<string>();
    (globalThis as { __codeStates?: Set<string> }).__codeStates = seen;
    const tick = (): void => {
      const block = document.querySelector('[data-row-id^="lab-turn"] [data-testid="code-block"]');
      if (block !== null) {
        const colored = block.querySelector('code span[style*="color"]') !== null;
        seen.add(
          `${block.getAttribute('data-complete') ?? '?'}/${block.getAttribute('data-highlight') ?? '?'}/${colored ? 'colored' : 'plain'}`,
        );
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

test('a streaming code block is plain text until its fence closes, then highlighted', async ({
  page,
}, testInfo) => {
  await watchCodeBlock(page);
  const message = [
    'Before the code.',
    '',
    '```ts',
    ...Array.from(
      { length: 12 },
      (_, line) => `const value${String(line)}: number = ${String(line)};`,
    ),
    '```',
    '',
    'After the code.',
  ].join('\n');
  const [id] = await streamTurn(page, { tokensPerSecond: 150, messages: [message] });
  if (id === undefined) {
    throw new Error('no streamed item');
  }
  await settled(page, id);
  const block = page.locator(`[data-row-id="${id}"] [data-testid="code-block"]`);
  await expect(block).toHaveAttribute('data-highlight', 'highlighted');
  await expect(block.locator('code span[style*="color"]').first()).toBeVisible();
  // Let the recorder's animation frame see the final state.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  const states = await page.evaluate(() => [
    ...((globalThis as { __codeStates?: Set<string> }).__codeStates ?? []),
  ]);
  // While streaming: incomplete and plain; at the end: complete and colored.
  expect(states).toContain('false/plain/plain');
  expect(states).toContain('true/highlighted/colored');
  expect(states).not.toContain('false/highlighted/colored');
  await page.screenshot({ path: testInfo.outputPath('highlighted.png') });
});

test('grammars and themes load in the worker, not in the page', async ({ page }) => {
  const id = await addMessage(page, '```rust\nfn main() { println!("hi"); }\n```');
  await settled(page, id);
  await expect(page.locator(`[data-row-id="${id}"] [data-testid="code-block"]`)).toHaveAttribute(
    'data-highlight',
    'highlighted',
  );
  const loaded = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((entry) => new URL(entry.name).pathname),
  );
  // The page itself fetched none of the grammar or theme chunks; the worker did.
  expect(loaded.filter((name) => /\/(rust|github-(light|dark))-[^/]+\.js$/u.test(name))).toEqual(
    [],
  );
});

test('unknown languages and indented code stay plain', async ({ page }) => {
  const id = await addMessage(page, '```no-such-language\nplain\n```\n\n    indented code\n');
  await settled(page, id);
  const blocks = page.locator(`[data-row-id="${id}"] [data-testid="code-block"]`);
  await expect(blocks).toHaveCount(2);
  for (const block of await blocks.all()) {
    await expect(block).toHaveAttribute('data-highlight', 'plain');
  }
});

test('open emphasis renders as emphasis while streaming', async ({ page }) => {
  await page.evaluate(() => {
    const seen = { strong: false };
    (globalThis as { __strongSeen?: typeof seen }).__strongSeen = seen;
    const tick = (): void => {
      if (document.querySelector('[data-row-id^="lab-turn"] strong') !== null) {
        seen.strong = true;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const message = 'Streaming **bold text whose closing marker never arrives, word after word';
  const [id] = await streamTurn(page, { tokensPerSecond: 60, messages: [message] });
  expect(
    await page.evaluate(() => (globalThis as { __strongSeen?: { strong: boolean } }).__strongSeen),
  ).toEqual({ strong: true });
  // Finished: the message equals a one-shot parse, where the unclosed marker is literal text.
  const row = page.locator(`[data-testid="agent-message"][data-row-id="${String(id)}"]`);
  await expect(row).toContainText('**bold text');
  await expect(row.locator('strong')).toHaveCount(0);
});

test('a streaming delta re-renders only the streaming row', async ({ page }) => {
  await loadHistory(page, 30);
  await resetRenderCounts(page);
  const [id] = await streamTurn(page, { tokensPerSecond: 100, seconds: 3 });
  const counts = await renderCounts(page);
  expect(Object.keys(counts)).toEqual([id]);
  expect(counts[String(id)]).toBeGreaterThan(20);
});
