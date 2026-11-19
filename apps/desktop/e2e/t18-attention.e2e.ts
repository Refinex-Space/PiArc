// T18-A11: a session that finishes while the window is not in front raises a system
// notification (and always the in-app reminder and the Dock bounce), and the Dock badge counts
// the sessions that need the user. On macOS the program cannot see whether a banner appeared
// (S6, I43), so the test checks what PiArc asked for; the banner itself is checked by hand.
import { expectTestHooks } from './core.js';
import {
  expect,
  focusMain,
  makeWorkspace,
  openFolder,
  row,
  startSession,
  test,
} from './sessions.js';

test('a session finishing in the background notifies and counts on the Dock badge', async ({
  app,
  page,
  workspaces,
}, testInfo) => {
  test.setTimeout(120_000);
  await expectTestHooks(app);
  const ws = await makeWorkspace(workspaces, 'notify 通知');
  await openFolder(page, app, ws);
  // The model runs `env sleep 3` before answering: time to put another window in front. The
  // command asks first (`sleep` alone is read-only and would run without a card, T23).
  const id = await startSession(page, 'Take a while', 't18-slow#notify');
  await page
    .locator('[data-approval-card=command] button')
    .filter({ hasText: /^(Allow once|仅本次允许)$/u })
    .click();
  const settings = app.waitForEvent('window');
  await page.getByTestId('open-settings').click();
  const front = await settings;
  await front.getByTestId('settings-window').waitFor();
  // The main window is no longer in front.
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .filter(
            (w) =>
              !w.isDestroyed() &&
              !w.webContents.isDestroyed() &&
              !w.webContents.getURL().includes('#/settings'),
          )
          .some((w) => w.isFocused()),
      ),
    )
    .toBe(false);

  await expect(row(page, id)).toHaveAttribute('data-badge', 'unread', { timeout: 30_000 });
  const observed = await app.evaluate(() => globalThis.__piarcTestHooks?.attention());
  // Whether the window still had the foreground when the approval card came is up to the
  // desktop: Windows did not keep it for a window launched by Playwright (CI run 44453549786,
  // W1), so that card may have notified too. The completion is the one this test is about.
  const completed = (observed?.notified ?? []).filter((n) => n.kind === 'completed');
  expect(completed).toEqual([
    expect.objectContaining({
      title: expect.stringContaining('Take a while'),
    }),
  ]);
  expect((observed?.notified ?? []).every((n) => n.kind !== 'failed')).toBe(true);
  // One bounce (Dock) or taskbar flash for each notification.
  expect(observed?.bounces).toBe(observed?.notified.length);
  expect(observed?.count).toBe(1);
  if (process.platform === 'darwin') {
    expect(await app.evaluate(({ app: electronApp }) => electronApp.getBadgeCount())).toBe(1);
  }
  await expect(page.getByTestId('toast').filter({ hasText: /finished|已完成/u })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('reminder.png') });

  // Back in front and shown: read, the count goes back to 0.
  await front.close();
  await focusMain(app);
  await row(page, id).getByTestId('session-title').click();
  await expect(row(page, id)).toHaveAttribute('data-badge', 'idle', { timeout: 10_000 });
  await expect
    .poll(() => app.evaluate(() => globalThis.__piarcTestHooks?.attention().count))
    .toBe(0);
  if (process.platform === 'darwin') {
    expect(await app.evaluate(({ app: electronApp }) => electronApp.getBadgeCount())).toBe(0);
  }
});
