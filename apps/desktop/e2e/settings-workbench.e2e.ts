// Settings stay in their originating workbench. The search operates on the local settings catalog.
import type { BrowserWindow } from 'electron';

import { expect, test } from './sessions.js';
import { prefer } from './t19.js';

test('the gear opens a modal in place, finds a setting and restores focus', async ({
  app,
  page,
}, info) => {
  await prefer(page, { key: 'language', value: 'en' });
  const gear = page.getByTestId('open-settings');
  await gear.click();
  const panel = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(panel).toBeVisible();
  expect(app.windows()).toHaveLength(1);
  const search = panel.getByRole('combobox', { name: 'Search settings' });
  await expect(search).toBeFocused();
  const frame = panel.locator('.settings-search');
  const singleEdge = async (width: string) => {
    await expect(search).toBeFocused();
    await expect(search).toHaveCSS('outline-style', 'none');
    await expect(search).toHaveCSS('border-top-width', '0px');
    await expect(search).toHaveCSS('box-shadow', 'none');
    await expect(frame).toHaveCSS('outline-width', width);
  };
  await search.click();
  await singleEdge('1px');
  await search.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await singleEdge('2px');
  await search.fill('density');
  await search.press('Enter');
  await expect(panel.getByTestId('settings-page-appearance')).toBeVisible();
  await expect(search).toHaveCSS('outline-style', 'none');
  await expect(panel.getByTestId('theme-dark')).toHaveAccessibleName('Dark');
  await page.screenshot({ path: info.outputPath('appearance-light.png') });
  await panel.getByTestId('settings-close').click();
  await expect(panel).toHaveCount(0);
  await expect(gear).toBeFocused();
});

test('the settings frame leaves balanced margins as the workbench resizes', async ({
  app,
  page,
}, info) => {
  const owner = await app.browserWindow(page);
  const initial = await owner.evaluate((w: BrowserWindow) => w.getBounds());
  const area = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  expect(initial.width).toBe(Math.min(1200, area.width));
  expect(initial.height).toBe(Math.min(800, area.height));
  const button = page.getByTestId('open-settings');
  await button.click();
  const dialog = page.locator('.settings-dialog');
  for (const [width, height] of [
    [1200, 800],
    [960, 600],
    [1440, 900],
  ] as const) {
    await owner.evaluate(
      (w: BrowserWindow, size) => {
        w.setContentSize(size.width, size.height);
      },
      { width, height },
    );
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    const rect = await dialog.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        width: r.width,
        height: r.height,
        left: r.left,
        right: innerWidth - r.right,
        top: r.top,
        bottom: innerHeight - r.bottom,
        viewHeight: innerHeight,
      };
    });
    expect(rect.left).toBeCloseTo(rect.right, 0);
    expect(rect.top).toBeCloseTo(rect.bottom, 0);
    expect(rect.width).toBeCloseTo(
      Math.min(1000, width - Math.max(32, Math.min(width * 0.08, 96))),
      0,
    );
    expect(rect.height).toBeCloseTo(
      Math.min(780, rect.viewHeight - Math.max(32, Math.min(rect.viewHeight * 0.1, 96))),
      0,
    );
    await page.screenshot({ path: info.outputPath('settings-' + String(width) + '.png') });
  }
});
