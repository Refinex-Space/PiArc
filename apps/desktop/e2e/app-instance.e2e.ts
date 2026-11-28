// A11: pages are served over the app scheme, and a second instance exits at once and focuses
// the window of the first.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';

import { appCommand } from './app.js';
import { expect, test } from './fixtures.js';

test('loads the window over the app scheme, not file:', async ({ page }) => {
  expect(
    await page.evaluate(() => ({
      protocol: window.location.protocol,
      origin: window.location.origin,
      secure: window.isSecureContext,
    })),
  ).toEqual({ protocol: 'app:', origin: 'app://piarc', secure: true });
});

test('a second instance exits and focuses the existing window', async ({
  app,
  appForm,
  appLog,
  page,
  userDataDir,
}) => {
  // The lock belongs to the user-data directory, which is private to this test. Compare real
  // paths: macOS reports /var through /private, Windows may shorten temp paths.
  const appUserData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  expect(realpathSync.native(appUserData)).toBe(realpathSync.native(userDataDir));
  // Hide the window (minimizing is not reliable for an app in the background on macOS); the
  // second instance must bring it back.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.hide();
  });
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
    .toBe(false);

  const { command, args } = appCommand(appForm, [`--user-data-dir=${userDataDir}`]);
  const second = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let secondOutput = '';
  second.stdout.on('data', (chunk: Buffer) => (secondOutput += chunk.toString('utf8')));
  second.stderr.on('data', (chunk: Buffer) => (secondOutput += chunk.toString('utf8')));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      second.kill();
      reject(new Error('The second instance did not exit within 20 s'));
    }, 20_000);
    second.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  expect(exitCode).toBe(0);
  expect(secondOutput).toContain('[app] another instance is running; exiting');

  await appLog.waitFor(/\[app\] second instance started; focusing the existing window/);
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        return {
          count: windows.length,
          minimized: windows[0]?.isMinimized(),
          visible: windows[0]?.isVisible(),
        };
      }),
    )
    .toEqual({ count: 1, minimized: false, visible: true });
  await expect(page.getByTestId('app-shell')).toBeVisible();
});
