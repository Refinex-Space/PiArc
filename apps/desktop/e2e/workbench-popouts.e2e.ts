// A detached surface remains the same session panel. The separate Electron window displays
// only that tool and receives no preload bridge of its own.
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './sessions.js';
import { openPanel, run, visibleTerminal, waitForPanel } from './terminal-panel.js';

async function popOut(app: ElectronApplication, page: Page, id: string): Promise<Page> {
  const opening = app.waitForEvent('window');
  await page.getByTestId('tile-popout-' + id).click();
  const tool = await opening;
  await expect(tool.getByTestId('tile-' + id)).toBeVisible();
  await expect(tool.getByTestId('app-shell')).toHaveCount(0);
  expect(
    await tool.evaluate(() => ({ bridge: typeof window.piarc, opener: window.opener === null })),
  ).toEqual({ bridge: 'undefined', opener: true });
  return tool;
}

test('a native terminal accepts physical input, pins and redocks to the same shell', async ({
  app,
  page,
  workspaces,
}, info) => {
  const { terminal } = await openPanel(app, page, workspaces);
  const tool = await popOut(app, page, 'terminal');
  await tool.getByTestId('terminal-canvas').click();
  await run(tool, 'echo 32099');
  await waitForPanel(
    page,
    (text) => text.split('\n').some((line) => line.trim() === '32099'),
    'output typed in the native terminal',
  );
  await tool.getByTestId('tool-window-pin').click();
  await expect(tool.getByTestId('tool-window-pin')).toHaveAttribute('aria-pressed', 'true');
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some(
        (win) => win.webContents.getURL().endsWith('/tool-window.html') && win.isAlwaysOnTop(),
      ),
    ),
  ).toBe(true);
  await tool.screenshot({ path: info.outputPath('terminal-native.png') });
  await tool.getByTestId('tile-popout-terminal').click();
  await expect(page.getByTestId('terminal-panel')).toBeVisible();
  await expect.poll(() => tool.isClosed()).toBe(true);
  expect(await visibleTerminal(page)).toBe(terminal);
  await waitForPanel(page, (text) => text.includes('32099'), 'redocked terminal output');

  const second = await popOut(app, page, 'terminal');
  await second.close();
  await expect(page.getByTestId('terminal-panel')).toBeVisible();
  expect(await visibleTerminal(page)).toBe(terminal);
});
