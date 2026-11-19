// T27 with the real Core, Agent Host and mock provider: the environment bar's usage ring (a
// hint at 75 %, a warning at 90 %), the rail's context card with the breakdown by category, its
// compact button, and `/compact <focus>` typed into the composer. Screenshots go to
// tmp/evidence/T27/ with PIARC_EVIDENCE_TASK=T27.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page, TestInfo } from '@playwright/test';

import { expect, test } from './sessions.js';
import { idle, openSession, requests, send } from './t19.js';

async function shoot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}

test('usage ring levels, the context card and both ways to compact', async ({
  page,
  app,
  workspaces,
  mock,
  userDataDir,
}, info) => {
  // Keep only the latest message on compaction, so a short conversation has something to
  // summarize (Pi's default keeps the last 20,000 tokens).
  await writeFile(
    path.join(userDataDir, 'pi', 'settings.json'),
    JSON.stringify({ retry: { baseDelayMs: 5 }, compaction: { keepRecentTokens: 1 } }),
  );
  await openSession(app, page, workspaces, 'context usage', 't27-usage', 'First question');
  await idle(page);
  const ring = page.getByTestId('usage-ring');
  // 20,000 of 200,000 tokens.
  await expect(ring).toHaveAttribute('data-percent', '10');
  await expect(ring).toHaveAttribute('data-level', 'normal');

  await send(page, 'Second question');
  await idle(page);
  await expect(ring).toHaveAttribute('data-percent', '75');
  await expect(ring).toHaveAttribute('data-level', 'warning');
  await expect(ring).toHaveAttribute(
    'aria-label',
    /75% used: the conversation will be compacted soon/u,
  );
  await shoot(page, info, 'ring-75-warning');

  await send(page, 'Third question');
  await idle(page);
  await expect(ring).toHaveAttribute('data-percent', '90');
  await expect(ring).toHaveAttribute('data-level', 'critical');
  await expect(ring).toHaveAttribute('aria-label', /90% used: compact the conversation now/u);

  // The ring opens the context card: percentage, categories (the provider's count makes the
  // rest unclassified) and the automatic compaction threshold.
  await ring.click();
  const card = page.getByTestId('context-panel');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('context-percent')).toHaveText('90% used');
  await expect(card).toContainText('180,000 of 200,000 tokens');
  await expect(card).toContainText('Reported by the provider');
  for (const category of ['systemPrompt', 'tools', 'conversation', 'unclassified']) {
    await expect(card.locator(`[data-category="${category}"]`)).toBeVisible();
  }
  await expect(card).toContainText('Compacts automatically at 182,904 tokens');
  await shoot(page, info, 'ring-90-context-card');

  // The card's button compacts like a bare /compact.
  await card.getByTestId('context-compact').click();
  await expect(page.getByTestId('compaction-row').last()).toHaveAttribute(
    'data-status',
    'completed',
  );
  await idle(page);
  await expect(ring).toHaveAttribute('data-level', 'normal');
  await expect(card).toContainText('Estimated');
  const afterButton = await requests(mock, 't27-usage');
  expect(JSON.stringify(afterButton[3]?.body)).toContain(
    'You write handover notes for a coding session.',
  );
  expect(JSON.stringify(afterButton[3]?.body)).not.toContain('Focus requested by the user');
  await shoot(page, info, 'after-compact-button');

  // `/compact <focus>` in the composer sends the focus with the summary request.
  await send(page, 'Fourth question');
  await idle(page);
  await send(page, '/compact Keep the API decisions.');
  await idle(page);
  await expect(page.getByTestId('compaction-row').last()).toHaveAttribute(
    'data-status',
    'completed',
  );
  const sent = await requests(mock, 't27-usage');
  expect(sent).toHaveLength(6);
  expect(JSON.stringify(sent[5]?.body)).toContain(
    'Focus requested by the user: Keep the API decisions.',
  );
  // The command is not a message to the model.
  expect(JSON.stringify(sent[5]?.body)).not.toContain('/compact Keep');
  await shoot(page, info, 'after-compact-focus');
});
