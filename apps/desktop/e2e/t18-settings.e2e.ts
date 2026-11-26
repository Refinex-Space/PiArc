// T18-A10, A12: the settings window; changing Mod+N takes effect at once (old key dead, new
// key works, the menu shows it), a conflicting key is refused; switching the language updates
// the window and the application menu at once.
import { openSettings, closeSettings } from './settings-panel.js';
import type { ElectronApplication } from '@playwright/test';

import { expect, makeWorkspace, openFolder, startSession, test } from './sessions.js';
import { prefer } from './t19.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

function menuItem(app: ElectronApplication, id: string) {
  return app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    return { label: item?.label ?? null, accelerator: item?.accelerator ?? null };
  }, id);
}

function topMenuLabels(app: ElectronApplication) {
  return app.evaluate(
    ({ Menu }) => Menu.getApplicationMenu()?.items.map((item) => item.label) ?? [],
  );
}

test('a changed shortcut works at once, the old one stops, the menu follows; conflicts are refused', async ({
  app,
  page,
  workspaces,
}, testInfo) => {
  test.setTimeout(120_000);
  const ws = await makeWorkspace(workspaces, 'keys 快捷键');
  await openFolder(page, app, ws);
  await startSession(page, 'A session to leave', 't18-chat#keys');
  expect(await menuItem(app, 'session.new')).toMatchObject({ accelerator: 'CommandOrControl+N' });

  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-shortcuts').click();
  // Mod+W is taken by "Close Session".
  await settings.getByTestId('shortcut-key-session.new').click();
  await settings.keyboard.press(`${MOD}+KeyW`);
  await expect(settings.getByTestId('shortcut-problem')).toBeVisible();
  await settings.screenshot({ path: testInfo.outputPath('shortcut-conflict.png') });
  // Mod+Shift+N is free.
  await settings.keyboard.press(`${MOD}+Shift+KeyN`);
  await expect(settings.getByTestId('shortcut-problem')).toHaveCount(0);
  await expect(settings.getByTestId('shortcut-key-session.new')).toContainText(
    process.platform === 'darwin' ? '⇧⌘N' : 'Ctrl+Shift+N',
  );
  await expect
    .poll(() => menuItem(app, 'session.new'))
    .toMatchObject({
      accelerator: 'CommandOrControl+Shift+N',
    });
  await settings.screenshot({ path: testInfo.outputPath('shortcut-changed.png') });

  // The main window: the old key does nothing, the new one opens the new-session view.
  await closeSettings(settings);
  await expect(page.getByTestId('conversation')).toBeVisible();
  await page.keyboard.press(`${MOD}+KeyN`);
  await expect(page.getByTestId('conversation')).toBeVisible();
  await expect(page.getByTestId('home')).toHaveCount(0);
  await page.keyboard.press(`${MOD}+Shift+KeyN`);
  await expect(page.getByTestId('home')).toBeVisible();

  // Reset restores the default everywhere.
  await openSettings(page);
  await settings.getByTestId('settings-nav-shortcuts').click();
  await settings.getByTestId('shortcut-reset-session.new').click();
  await expect
    .poll(() => menuItem(app, 'session.new'))
    .toMatchObject({
      accelerator: 'CommandOrControl+N',
    });
  await closeSettings(settings);
  // Mod+/ lists the shortcuts.
  await page.keyboard.press(`${MOD}+Slash`);
  await expect(page.getByTestId('shortcuts-dialog')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('shortcut-list.png') });
});

test('switching the language updates the window and the menu at once', async ({
  app,
  page,
}, testInfo) => {
  const settings = await openSettings(page);
  await settings.getByTestId('setting-language').selectOption('en');
  await expect(page.getByTestId('open-search')).toHaveText('Search');
  await expect(settings.getByTestId('settings-nav-general')).toHaveText('General');
  await expect.poll(() => topMenuLabels(app)).toContain('File');
  expect((await menuItem(app, 'session.new')).label).toBe('New Session');
  await page.screenshot({ path: testInfo.outputPath('language-en.png') });

  await settings.getByTestId('setting-language').selectOption('zh-CN');
  await expect(page.getByTestId('open-search')).toHaveText('搜索');
  await expect(settings.getByTestId('settings-nav-general')).toHaveText('通用');
  await expect.poll(() => topMenuLabels(app)).toContain('文件');
  expect((await menuItem(app, 'session.new')).label).toBe('新建会话');
  await page.screenshot({ path: testInfo.outputPath('language-zh.png') });
  await settings.screenshot({ path: testInfo.outputPath('settings-zh.png') });
});

test('adjacent hovered and selected navigation rows keep a non-interactive gap', async ({
  page,
}, info) => {
  const settings = await openSettings(page);
  const selected = settings.getByTestId('settings-nav-sandbox');
  const hovered = settings.getByTestId('settings-nav-permissions');
  await selected.click();
  const background = (el: Element) => getComputedStyle(el).backgroundColor;
  for (const [density, gap, height] of [
    ['comfortable', 4, 32],
    ['compact', 3, 26],
  ] as const) {
    await prefer(settings, { key: 'appearance.density', value: density });
    await expect(settings.locator('html')).toHaveAttribute('data-density', density);
    await selected.hover();
    const resting = await hovered.evaluate(background);
    await hovered.hover();
    await expect(selected).toHaveAttribute('aria-current', 'page');
    const upper = await hovered.boundingBox();
    const lower = await selected.boundingBox();
    if (!upper || !lower) throw new Error('Both navigation rows must be visible');
    expect(lower.y - upper.y - upper.height).toBeCloseTo(gap);
    expect(lower.height).toBeGreaterThanOrEqual(height);
    expect(lower.x).toBe(upper.x);
    expect(lower.width).toBe(upper.width);
    expect(await hovered.evaluate(background)).not.toBe(resting);
    expect(await hovered.evaluate(background)).not.toBe(await selected.evaluate(background));
    await settings.locator('.settings-nav').screenshot({ path: info.outputPath(density + '.png') });
    const x = upper.x + upper.width / 2;
    const y = lower.y - gap / 2;
    expect(
      await settings.evaluate(
        (point) => document.elementFromPoint(point.x, point.y)?.closest('button') === null,
        { x, y },
      ),
    ).toBe(true);
    await settings.mouse.click(x, y);
    await expect(selected).toHaveAttribute('aria-current', 'page');
    await hovered.click();
    await settings.keyboard.press('Tab');
    await expect(selected).toBeFocused();
    await settings.keyboard.press('Enter');
    await expect(selected).toHaveAttribute('aria-current', 'page');
  }
});

test('appearance segments keep the reference geometry and one moving selected surface', async ({
  page,
}, info) => {
  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-appearance').click();
  const track = settings.getByTestId('setting-theme').getByRole('radiogroup');
  const labels = track.locator('label');
  await expect(labels.locator('svg[aria-hidden="true"]')).toHaveCount(3);
  await expect(settings.getByTestId('setting-reduceMotion').getByRole('combobox')).toBeVisible();
  const thumb = track.locator('.segment-thumb');
  const rects = () =>
    labels.evaluateAll((nodes) =>
      nodes.map((node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
  for (const [density, height, radius] of [
    ['comfortable', 28, 8],
    ['compact', 24, 6],
  ] as const) {
    await prefer(settings, { key: 'appearance.density', value: density });
    await expect(settings.locator('html')).toHaveAttribute('data-density', density);
    await expect(track).toHaveCSS('border-top-width', '0px');
    await expect(track).toHaveCSS('height', String(height) + 'px');
    await expect(track).toHaveCSS('border-radius', String(radius) + 'px');
    await expect(track).toHaveCSS('width', String(3 * (height - 2) + 2) + 'px');
    await expect(thumb).toHaveCount(1);
    const before = await rects();
    for (const theme of ['light', 'dark'] as const) {
      const label = labels.filter({ has: settings.getByTestId('theme-' + theme) });
      await label.click();
      await expect(label.getByRole('radio')).toBeChecked();
      await expect(settings.locator('html')).toHaveAttribute('data-color-mode', theme);
      await expect
        .poll(() =>
          thumb.evaluate((node) => {
            const selected = node.parentElement?.querySelector('input:checked')?.parentElement;
            if (!selected) return false;
            const a = node.getBoundingClientRect(),
              b = selected.getBoundingClientRect();
            return (
              Math.abs(a.x - b.x) < 0.5 &&
              Math.abs(a.width - b.width) < 0.5 &&
              a.height === b.height
            );
          }),
        )
        .toBe(true);
      expect(await rects()).toEqual(before);
      await settings.getByTestId('settings-page-appearance').screenshot({
        path: info.outputPath(density + '-' + theme + '.png'),
      });
    }
    await settings.keyboard.press('ArrowLeft');
    await expect(settings.getByTestId('theme-light')).toBeChecked();
    await expect(thumb).toHaveAttribute('data-moving', '');
    await expect(thumb).toHaveCSS('box-shadow', 'none');
    await expect(settings.getByTestId('theme-light').locator('..')).toHaveCSS(
      'outline-width',
      '1px',
    );
  }
  const motion = settings.getByTestId('setting-reduceMotion').getByRole('combobox');
  await motion.focus();
  // Space opens the native picker on macOS; the active option then receives the keys.
  await settings.keyboard.press('Space');
  await expect.poll(() => motion.evaluate((el) => el.matches(':open'))).toBe(true);
  await settings.keyboard.press('ArrowDown');
  await settings.keyboard.press('Enter');
  await expect(motion).toHaveValue('on');
  await expect(settings.locator('html')).toHaveAttribute('data-reduce-motion', 'true');
});
