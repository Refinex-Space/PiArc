import { readFileSync } from 'node:fs';
import path from 'node:path';

import { desktopDir } from './app.js';
import { expect, test } from './fixtures.js';

test('opens one window with the sidebar and the main area', async ({ app, page }, testInfo) => {
  expect(app.windows()).toHaveLength(1);
  await expect(page).toHaveTitle('PiArc');
  await expect(page.getByTestId('shell-sidebar')).toBeVisible();
  await expect(page.getByTestId('shell-main')).toBeVisible();
  // A new conversation starts without session details or open tool tiles.
  await expect(page.getByTestId('panel-area-rail')).toHaveCount(0);
  await expect(page.locator('[data-testid^="tile-body-"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('window.png') });
});

test('exposes window.piarc and answers the app version from the main process', async ({ page }) => {
  const manifest: unknown = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
  const version =
    typeof manifest === 'object' && manifest !== null && 'version' in manifest
      ? String(manifest.version)
      : '';
  expect(await page.evaluate(() => typeof window.piarc)).toBe('object');
  expect(await page.evaluate(() => window.piarc.getAppVersion())).toBe(version);
});
