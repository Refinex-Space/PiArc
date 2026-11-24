// T41 with the real Core, Agent Host and mock provider: the session rail's usage card and the
// settings window's "Usage" page (A12). The mock model has no catalog price, so its cost shows
// "Unknown", never $0 (A11); setting the user's price on the page prices every request with it
// (A11), and the next turn's card agrees. Each mock reply reports 1,000 input, 200 output,
// 5,000 cache-read and 300 cache-write tokens: at 3 / 15 / 0.3 / 3.75 USD per million tokens a
// reply costs 3,000 + 3,000 + 1,500 + 1,125 = 8,625 micro-dollars. Screenshots (light, dark,
// Chinese) go to tmp/evidence/T41/.
import { closeSettings, openSettings } from './settings-panel.js';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from './sessions.js';
import { idle, openSession, prefer, send } from './t19.js';

const REPO = path.join(import.meta.dirname, '..', '..', '..');
const EVIDENCE = path.join(REPO, 'tmp', 'evidence', 'T41');
const REPLY_USD = 0.008625;

test('the rail card and the Usage page show tokens and estimated cost', async ({
  page,
  app,
  workspaces,
}) => {
  await mkdir(EVIDENCE, { recursive: true });
  await openSession(app, page, workspaces, 'usage cost', 't41-usage', 'First question');
  await idle(page);
  await send(page, 'Second question');
  await idle(page);

  // The rail's usage card: tokens of both replies, cost unknown (no price yet).
  await page.getByTestId('panel-tab-usage').click();
  const card = page.getByTestId('usage-card');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('usage-card-cost')).toHaveAttribute('data-cost', 'unknown');
  await expect(card.getByTestId('usage-card-cost')).toHaveText('Unknown');
  await expect(card).toContainText('2 requests');
  await expect(card.getByTestId('usage-tokens')).toContainText('2,000');
  await expect(card.getByTestId('usage-tokens')).toContainText('10,000');

  // The Usage page lists the model without a price and the session.
  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-usage').click();
  const usage = settings.getByTestId('usage-page');
  await expect(usage).toBeVisible();
  const row = usage.locator('[data-testid="usage-model-row"][data-model="piarc-mock/mock-large"]');
  await expect(row.getByTestId('usage-price-source')).toHaveText('No price');
  await expect(row.getByTestId('usage-model-cost')).toHaveText('Unknown');
  await expect(usage.getByTestId('usage-session-row')).toHaveCount(1);

  // The user's price replaces the missing one.
  await row.getByTestId('usage-price-edit').click();
  const form = usage.getByTestId('usage-price-form');
  await form.getByTestId('usage-price-input').fill('-1');
  await form.getByTestId('usage-price-output').fill('15');
  await form.getByTestId('usage-price-cacheRead').fill('0.3');
  await form.getByTestId('usage-price-cacheWrite').fill('3.75');
  await form.getByTestId('usage-price-save').click();
  await expect(form.getByRole('alert')).toHaveText('Enter a number of 0 or more for every price.');
  await form.getByTestId('usage-price-input').fill('3');
  await form.getByTestId('usage-price-save').click();
  await expect(row.getByTestId('usage-price-source')).toHaveText('Your price');
  await expect(row.getByTestId('usage-model-cost')).toHaveText('$0.01725');
  const cost = Number(await row.getByTestId('usage-model-cost').getAttribute('data-cost'));
  expect(Math.abs(cost - 2 * REPLY_USD)).toBeLessThan(1e-12);
  await expect(usage.getByTestId('usage-total-cost')).toHaveText('$0.01725 (estimate)');
  await expect(usage.getByTestId('usage-session-cost')).toHaveText('$0.01725');
  await settings.screenshot({ path: path.join(EVIDENCE, 'usage-page-light.png') });
  await prefer(page, { key: 'appearance.theme', value: 'dark' });
  await settings.screenshot({ path: path.join(EVIDENCE, 'usage-page-dark.png') });
  await prefer(page, { key: 'language', value: 'zh-CN' });
  await expect(row.getByTestId('usage-price-source')).toHaveText('你的价格');
  await expect(usage.getByTestId('usage-total-cost')).toHaveText('$0.01725（估算）');
  await settings.screenshot({ path: path.join(EVIDENCE, 'usage-page-zh-CN-dark.png') });
  await prefer(page, { key: 'language', value: 'en' });
  await prefer(page, { key: 'appearance.theme', value: 'light' });

  // The next turn's card uses the user's price.
  await closeSettings(settings);
  await send(page, 'Third question');
  await idle(page);
  await expect(card.getByTestId('usage-card-cost')).toHaveText('$0.02588 (estimate)');
  await expect(card.getByTestId('usage-card-models')).toContainText('mock-large');
  await page.screenshot({ path: path.join(EVIDENCE, 'usage-card-light.png') });
  await prefer(page, { key: 'appearance.theme', value: 'dark' });
  await page.screenshot({ path: path.join(EVIDENCE, 'usage-card-dark.png') });
  await prefer(page, { key: 'appearance.theme', value: 'light' });

  await openSettings(page);
  await settings.getByTestId('settings-nav-usage').click();
  // Resetting goes back to no price: unknown again, not zero.
  await row.getByTestId('usage-price-edit').click();
  await usage.getByTestId('usage-price-reset').click();
  await expect(row.getByTestId('usage-price-source')).toHaveText('No price');
  await expect(row.getByTestId('usage-model-cost')).toHaveText('Unknown');
});
