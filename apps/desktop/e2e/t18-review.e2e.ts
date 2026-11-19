// T18-A03, A04: review screenshots of the visual direction — the main window in light and
// dark, each in both densities (plus the high-contrast modes), the trust dialog and the settings
// window — and, on macOS, a capture of the real window with its native chrome (hidden title
// bar with the traffic lights, sidebar vibrancy), which page screenshots do not include.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

import type { ElectronApplication, Page } from '@playwright/test';

import type { PreferenceChange } from '../src/shared/preferences.js';
import {
  expect,
  focusMain,
  makeWorkspace,
  openFolder,
  row,
  startSession,
  test,
} from './sessions.js';

async function prefer(page: Page, change: PreferenceChange): Promise<void> {
  await page.evaluate((c) => window.piarc.setPreference(c), change);
}

/**
 * A screenshot of the main window as the user sees it. On macOS the window itself is captured
 * (`screencapture -l`): the sidebar is translucent over the system's vibrancy material, which a
 * page screenshot would composite onto white. Elsewhere the page is captured.
 */
async function captureMain(app: ElectronApplication, page: Page, file: string): Promise<void> {
  if (process.platform === 'win32') {
    await captureWindowsScreen(app, page, file);
    return;
  }
  if (process.platform !== 'darwin') {
    await page.screenshot({ path: file });
    return;
  }
  const source = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && !w.webContents.getURL().includes('#/settings'),
    );
    window?.focus();
    return window?.getMediaSourceId() ?? '';
  });
  const windowId = /^window:(\d+):/.exec(source)?.[1];
  if (windowId === undefined) {
    throw new Error(`no window id in ${source}`);
  }
  // Let a theme or density change reach the screen.
  await page.waitForTimeout(400);
  execFileSync('screencapture', ['-x', '-o', `-l${windowId}`, file]);
  expect(existsSync(file) && statSync(file).size > 10_000).toBe(true);
}

/**
 * Windows: the screen area of the main window, brought to the front (W1). Mica and the window
 * controls overlay are drawn by the system around the page, so only the screen shows them.
 */
async function captureWindowsScreen(
  app: ElectronApplication,
  page: Page,
  file: string,
): Promise<void> {
  await focusMain(app);
  const rect = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && !w.webContents.getURL().includes('#/settings'),
    );
    if (window === undefined) throw new Error('no main window');
    // Windows may keep other windows above one a test brings forward: lift it for the capture.
    window.setAlwaysOnTop(true);
    return screen.dipToScreenRect(window, window.getBounds());
  });
  // Let a theme or density change reach the screen.
  await page.waitForTimeout(600);
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    `$b = New-Object System.Drawing.Bitmap ${String(rect.width)}, ${String(rect.height)}`,
    '$g = [System.Drawing.Graphics]::FromImage($b)',
    `$g.CopyFromScreen(${String(rect.x)}, ${String(rect.y)}, 0, 0, $b.Size)`,
    '$b.Save($env:PIARC_CAPTURE, [System.Drawing.Imaging.ImageFormat]::Png)',
  ].join('; ');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, PIARC_CAPTURE: file },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.setAlwaysOnTop(false);
    }
  });
  expect(existsSync(file) && statSync(file).size > 10_000).toBe(true);
}

async function startInBackground(page: Page, ws: string, text: string): Promise<string> {
  return page.evaluate(
    async ({ workspace, prompt }) => {
      const created = JSON.parse(await window.piarc.createSession(workspace)) as {
        sessionId: string;
      };
      await window.piarc.prompt(created.sessionId, {
        requestId: crypto.randomUUID(),
        text: prompt,
        mentions: [],
        attachments: [],
      });
      return created.sessionId;
    },
    { workspace: ws, prompt: text },
  );
}

test('review screenshots: modes, densities, dialogs and the native window', async ({
  app,
  page,
  workspaces,
}, testInfo) => {
  test.setTimeout(180_000);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 800);
  });
  const web = await makeWorkspace(workspaces, 'piarc-web 前端', {
    '.mcp.json': JSON.stringify({ mcpServers: { docs: { command: 'docs-server' } } }),
    '.piarc/settings.json': JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }),
  });
  const core = await makeWorkspace(workspaces, 'core-service');
  await openFolder(page, app, core);
  const failed = await startSession(page, 'Migrate the storage schema', 't18-fail#review');
  await expect(row(page, failed)).toHaveAttribute('data-badge', 'error', { timeout: 60_000 });
  await openFolder(page, app, web);
  const shown = await startSession(
    page,
    'Fix the flaky login test 修复登录测试',
    't18-chat#review-1',
  );
  await expect(page.getByTestId('agent-message')).toHaveText(/Done\./, { timeout: 30_000 });
  await row(page, shown).click({ button: 'right' });
  await page.getByTestId('menu-pin').click();
  const running = await startInBackground(
    page,
    web,
    'Refactor the settings page [[piarc-scenario:t18-stall#review]]',
  );
  const unread = await startInBackground(
    page,
    web,
    'Update the README [[piarc-scenario:t18-chat#review-2]]',
  );
  await expect(row(page, running)).toHaveAttribute('data-badge', 'running', { timeout: 30_000 });
  await expect(row(page, unread)).toHaveAttribute('data-badge', 'unread', { timeout: 30_000 });
  await row(page, shown).getByTestId('session-title').click();
  await page
    .getByTestId('toast')
    .first()
    .waitFor({ state: 'detached', timeout: 15_000 })
    .catch(() => undefined);

  for (const theme of ['light', 'dark'] as const) {
    await prefer(page, { key: 'appearance.theme', value: theme });
    for (const density of ['comfortable', 'compact'] as const) {
      await prefer(page, { key: 'appearance.density', value: density });
      await expect(page.locator('html')).toHaveAttribute('data-density', density);
      await expect(page.locator('html')).toHaveAttribute('data-color-mode', theme);
      await captureMain(app, page, testInfo.outputPath(`main-${theme}-${density}.png`));
    }
    await prefer(page, { key: 'appearance.contrast', value: 'high' });
    await expect(page.locator('html')).toHaveAttribute('data-color-mode', `${theme}HighContrast`);
    await captureMain(app, page, testInfo.outputPath(`main-${theme}-high-contrast.png`));
    await prefer(page, { key: 'appearance.contrast', value: 'standard' });
    await prefer(page, { key: 'appearance.density', value: 'comfortable' });

    // The trust dialog, opened for review from the folder's menu.
    // By name: a Windows path in a CSS attribute selector would need its backslashes escaped.
    const group = page.getByTestId('workspace-group').filter({ hasText: 'piarc-web 前端' });
    await group.locator('.workspace-header').hover();
    await group.getByTestId('workspace-actions').click();
    await page.getByTestId('menu-trust').click();
    await expect(page.getByTestId('trust-item').first()).toBeVisible();
    await captureMain(app, page, testInfo.outputPath(`trust-${theme}.png`));
    await page.keyboard.press('Escape');

    const opened = app.waitForEvent('window');
    await page.getByTestId('open-settings').click();
    const settings = await opened;
    await settings.getByTestId('settings-nav-appearance').click();
    await settings.screenshot({ path: testInfo.outputPath(`settings-${theme}.png`) });
    await settings.close();
  }

  // The native window in the system theme: traffic lights and vibrancy are drawn by macOS.
  if (process.platform === 'darwin') {
    await prefer(page, { key: 'appearance.theme', value: 'system' });
    await captureMain(app, page, testInfo.outputPath('native-window.png'));
  }
});
