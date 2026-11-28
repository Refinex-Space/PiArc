// The Pi package market (ADR-0102) against the mock registry: categories with counts (themes are
// not a category and theme-only packages stay hidden), search, a package's details with its
// README and links, the way back to the same list, offline with the cached catalog and retry,
// and payloads in names and READMEs stay text. Screenshots (light, dark, English, Chinese) go
// to tmp/evidence/market/.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { expect, marketRow, openMarket, test } from './market.js';
import { prefer } from './t19.js';

const EVIDENCE = path.join(import.meta.dirname, '..', '..', '..', 'tmp', 'evidence', 'market');

test('browses categories, searches, opens details and comes back to the same list', async ({
  page,
  npm,
}) => {
  test.setTimeout(120_000);
  await mkdir(EVIDENCE, { recursive: true });
  await prefer(page, { key: 'language', value: 'en' });
  const settings = await openMarket(page);
  await expect(marketRow(settings, 'pi-lint-skills')).toBeVisible({ timeout: 30_000 });
  // The catalog finishes reading kinds in the background; counts follow.
  await expect(settings.getByTestId('market-category-prompt').locator('..')).toContainText('1', {
    timeout: 30_000,
  });
  await expect(marketRow(settings, 'pi-dark-theme')).toHaveCount(0);
  await expect(settings.getByTestId('market-status')).toContainText('Catalog updated');
  // Most downloaded first.
  await expect(settings.getByTestId('market-row').first()).toHaveAttribute(
    'data-name',
    'pi-lint-skills',
    {
      timeout: 10_000,
    },
  );
  const names = await settings
    .getByTestId('market-row')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-name')));
  expect(names.slice(0, 3)).toEqual(['pi-lint-skills', 'pi-git-tools', '@demo/prompts']);
  await settings.screenshot({ path: path.join(EVIDENCE, 'list-light-en.png') });

  await settings.getByTestId('market-category-extension').check({ force: true });
  await expect(settings.getByTestId('market-row')).toHaveCount(1);
  await expect(marketRow(settings, 'pi-git-tools')).toBeVisible();
  await settings.getByTestId('market-category-all').check({ force: true });

  await settings.getByTestId('market-search').fill('review');
  await expect(settings.getByTestId('market-row')).toHaveCount(1, { timeout: 10_000 });
  await expect(marketRow(settings, '@demo/prompts')).toBeVisible();
  await settings.getByTestId('market-search').fill('nothing-matches-this');
  await expect(settings.getByTestId('market-none')).toBeVisible({ timeout: 10_000 });
  await settings.getByRole('button', { name: 'Clear filters' }).click();
  await expect(marketRow(settings, 'pi-lint-skills')).toBeVisible();

  // Details: README rendered as Markdown, raw HTML stays text, links go through confirmation.
  await marketRow(settings, 'pi-lint-skills').getByTestId('market-row-open').click();
  const detail = settings.getByTestId('market-detail');
  await detail.waitFor();
  await expect(detail.locator('.catalog-detail-title h3')).toHaveText('pi-lint-skills');
  await expect(settings.getByTestId('market-readme')).toContainText('Runs lint for you.');
  await expect(settings.getByTestId('market-link-repository')).toBeVisible();
  await expect(settings.getByTestId('market-facts')).toContainText('MIT');
  expect(page.url()).toContain('view=market&package=pi-lint-skills');
  await settings.screenshot({ path: path.join(EVIDENCE, 'detail-light-en.png') });
  await settings.getByTestId('market-back').click();
  await expect(marketRow(settings, 'pi-lint-skills')).toBeVisible();

  // Payloads stay text: nothing runs, the bidi override shows as its code point.
  await marketRow(settings, 'pi-xss-probe').getByTestId('market-row-open').click();
  await expect(settings.getByTestId('market-readme')).toContainText('<script>');
  expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
  await settings.getByTestId('market-back').click();
  await expect(marketRow(settings, 'pi-xss-probe')).toContainText('[U+202E]');

  await prefer(page, { key: 'appearance.theme', value: 'dark' });
  await prefer(page, { key: 'language', value: 'zh-CN' });
  await expect(settings.getByTestId('market-category-skill').locator('..')).toContainText('Skills');
  await settings.screenshot({ path: path.join(EVIDENCE, 'list-dark-zh.png') });

  // Offline: the cached catalog stays with a line saying so, and retry works once back.
  await npm.control('offline');
  await settings.getByTestId('market-refresh').click();
  await expect(settings.getByTestId('market-status')).toContainText('连不上 npm registry', {
    timeout: 30_000,
  });
  await expect(marketRow(settings, 'pi-lint-skills')).toBeVisible();
  await settings.screenshot({ path: path.join(EVIDENCE, 'offline-dark-zh.png') });
  await npm.control('online');
  await settings.getByTestId('market-status').getByRole('button').click();
  await expect(settings.getByTestId('market-status')).toContainText('目录更新于', {
    timeout: 30_000,
  });
  expect(await npm.violations()).toEqual([]);
});
