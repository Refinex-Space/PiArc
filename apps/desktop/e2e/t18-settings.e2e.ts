// T18-A10, A12: the settings window; changing Mod+N takes effect at once (old key dead, new
// key works, the menu shows it), a conflicting key is refused; switching the language updates
// the window and the application menu at once.
import type { ElectronApplication, Page } from '@playwright/test';

import { expect, makeWorkspace, openFolder, startSession, test } from './sessions.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function openSettings(app: ElectronApplication, page: Page): Promise<Page> {
  const opened = app.waitForEvent('window');
  await page.getByTestId('open-settings').click();
  const settings = await opened;
  await settings.getByTestId('settings-window').waitFor();
  return settings;
}

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

  const settings = await openSettings(app, page);
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
  await page.bringToFront();
  await expect(page.getByTestId('conversation')).toBeVisible();
  await page.keyboard.press(`${MOD}+KeyN`);
  await expect(page.getByTestId('conversation')).toBeVisible();
  await expect(page.getByTestId('home')).toHaveCount(0);
  await page.keyboard.press(`${MOD}+Shift+KeyN`);
  await expect(page.getByTestId('home')).toBeVisible();

  // Reset restores the default everywhere.
  await settings.getByTestId('shortcut-reset-session.new').click();
  await expect
    .poll(() => menuItem(app, 'session.new'))
    .toMatchObject({
      accelerator: 'CommandOrControl+N',
    });
  // Mod+/ lists the shortcuts.
  await page.keyboard.press(`${MOD}+Slash`);
  await expect(page.getByTestId('shortcuts-dialog')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('shortcut-list.png') });
});

test('switching the language updates the window and the menu at once', async ({
  app,
  page,
}, testInfo) => {
  const settings = await openSettings(app, page);
  await settings.getByTestId('setting-language').selectOption('en');
  await expect(page.getByTestId('session-filter')).toHaveAttribute(
    'placeholder',
    'Filter sessions',
  );
  await expect(settings.getByTestId('settings-nav-general')).toHaveText('General');
  await expect.poll(() => topMenuLabels(app)).toContain('File');
  expect((await menuItem(app, 'session.new')).label).toBe('New Session');
  await page.screenshot({ path: testInfo.outputPath('language-en.png') });

  await settings.getByTestId('setting-language').selectOption('zh-CN');
  await expect(page.getByTestId('session-filter')).toHaveAttribute('placeholder', '筛选会话');
  await expect(settings.getByTestId('settings-nav-general')).toHaveText('通用');
  await expect.poll(() => topMenuLabels(app)).toContain('文件');
  expect((await menuItem(app, 'session.new')).label).toBe('新建会话');
  await page.screenshot({ path: testInfo.outputPath('language-zh.png') });
  await settings.screenshot({ path: testInfo.outputPath('settings-zh.png') });
});
