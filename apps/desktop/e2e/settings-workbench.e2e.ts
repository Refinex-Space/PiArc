// Settings are a view of the originating workbench (ADR-0101). The search operates on the local
// settings catalog.
import type { BrowserWindow } from 'electron';

import { expect, test } from './sessions.js';
import { prefer } from './t19.js';

test('the gear turns the workbench into settings, finds a setting and turns back', async ({
  app,
  page,
}, info) => {
  await prefer(page, { key: 'language', value: 'en' });
  const gear = page.getByTestId('open-settings');
  await gear.click();
  const settings = page.getByTestId('settings-window');
  await expect(settings).toBeVisible();
  expect(app.windows()).toHaveLength(1);
  // ADR-0101: no dialog; the workbench stays mounted underneath and takes no input.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('app-shell')).toHaveAttribute('inert', '');
  await expect(page.getByTestId('shell-sidebar')).toBeAttached();
  const search = settings.getByRole('combobox', { name: 'Search settings' });
  await expect(search).toBeFocused();
  const frame = settings.locator('.settings-search');
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
  await singleEdge('1px');
  // Results fill the page area; the navigation keeps only the groups with a match.
  await search.fill('density');
  await expect(settings.getByTestId('settings-results')).toBeVisible();
  await expect(settings.getByTestId('settings-nav-appearance')).toBeVisible();
  await expect(settings.getByTestId('settings-nav-general')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('search-results.png') });
  await search.press('Enter');
  await expect(settings.getByTestId('settings-page-appearance')).toBeVisible();
  await expect(settings.getByTestId('setting-density')).toHaveClass(/is-located/u);
  await expect(settings.getByTestId('theme-dark')).toHaveAccessibleName('Dark');
  await page.screenshot({ path: info.outputPath('appearance-light.png') });
  // Esc clears a search first, then leaves settings; focus goes back to the gear.
  await search.fill('proxy');
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(settings).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(page.getByTestId('app-shell')).not.toHaveAttribute('inert', '');
  await expect(gear).toBeFocused();
  // The back button does the same.
  await gear.click();
  await settings.getByTestId('settings-close').click();
  await expect(settings).toHaveCount(0);
  await expect(gear).toBeFocused();
});

test('settings take the sidebar column and centre the page as the workbench resizes', async ({
  app,
  page,
}, info) => {
  const owner = await app.browserWindow(page);
  const initial = await owner.evaluate((w: BrowserWindow) => w.getBounds());
  const area = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  expect(initial.width).toBe(Math.min(1200, area.width));
  expect(initial.height).toBe(Math.min(800, area.height));
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings-window');
  await expect(settings).toBeVisible();
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
    const geometry = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`missing ${selector}`);
        return element.getBoundingClientRect();
      };
      const nav = box('.settings-sidebar');
      const sidebar = box('[data-testid="shell-sidebar"]');
      const view = box('.settings-view');
      const column = box('.settings-column');
      return {
        navLeft: nav.left,
        navWidth: nav.width,
        sidebarWidth: sidebar.width,
        viewRight: innerWidth - view.right,
        viewHeight: view.height,
        columnWidth: column.width,
        left: column.left - view.left,
        right: view.right - column.right,
      };
    });
    // The settings navigation is the sidebar's column, the page fills the rest of the window.
    expect(geometry.navLeft).toBe(0);
    expect(geometry.navWidth).toBeCloseTo(geometry.sidebarWidth, 0);
    expect(geometry.viewRight).toBe(0);
    expect(geometry.viewHeight).toBe(height);
    expect(geometry.columnWidth).toBeLessThanOrEqual(720);
    // The page's column is centred, with the scrollbar's room on the right.
    expect(Math.abs(geometry.left - geometry.right)).toBeLessThanOrEqual(12);
    await page.screenshot({ path: info.outputPath('settings-' + String(width) + '.png') });
  }
});

test('shortcut keys have individual keycaps and recording can be cancelled without closing settings', async ({
  page,
}, info) => {
  await prefer(page, { key: 'language', value: 'zh-CN' });
  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-nav-shortcuts').click();
  const editor = page.getByTestId('shortcut-key-session.new');
  await expect(editor.locator('kbd')).toHaveCount(2);
  await expect(editor.locator('kbd').last()).toHaveText('N');
  await expect(editor.locator('kbd').first()).toHaveText(
    process.platform === 'darwin' ? '⌘' : 'Ctrl',
  );
  await page.screenshot({ path: info.outputPath('shortcut-keycaps-zh.png') });
  await editor.click();
  await expect(editor).toHaveAttribute('aria-pressed', 'true');
  await editor.press('Escape');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveAttribute('aria-pressed', 'false');
  await expect(editor.locator('kbd')).toHaveCount(2);
  await editor.click();
  await editor.press('Tab');
  await expect(editor).not.toBeFocused();
  await expect(editor).toHaveAttribute('aria-pressed', 'false');
  await prefer(page, { key: 'appearance.density', value: 'compact' });
  await prefer(page, { key: 'appearance.theme', value: 'dark' });
  await editor.click();
  await editor.press(
    process.platform === 'darwin' ? 'Meta+Alt+Shift+KeyN' : 'Control+Alt+Shift+KeyN',
  );
  await expect(editor.locator('kbd')).toHaveCount(4);
  await expect(editor).toHaveAttribute('aria-pressed', 'false');
  const row = page.getByTestId('shortcut-session.new');
  expect(
    await row.evaluate((el) =>
      [...el.querySelectorAll('kbd')].every(
        (cap) => cap.clientWidth >= cap.scrollWidth && cap.clientHeight >= cap.scrollHeight,
      ),
    ),
  ).toBe(true);
  await row.screenshot({ path: info.outputPath('shortcut-long-dark.png') });
  await row.getByTestId('shortcut-reset-session.new').click();
  await expect(editor.locator('kbd')).toHaveCount(2);
});
