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
  // The model runs `sleep 3` before answering: time to put another window in front.
  const id = await startSession(page, 'Take a while', 't18-slow#notify');
  const settings = app.waitForEvent('window');
  await page.getByTestId('open-settings').click();
  const front = await settings;
  await front.getByTestId('settings-window').waitFor();
  // The main window is no longer in front.
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .filter((w) => !w.webContents.getURL().includes('#/settings'))
          .some((w) => w.isFocused()),
      ),
    )
    .toBe(false);

  await expect(row(page, id)).toHaveAttribute('data-badge', 'unread', { timeout: 30_000 });
  const observed = await app.evaluate(() => globalThis.__piarcTestHooks?.attention());
  expect(observed?.notified).toEqual([
    expect.objectContaining({
      kind: 'completed',
      title: expect.stringContaining('Take a while'),
    }),
  ]);
  expect(observed?.bounces).toBe(1);
  expect(observed?.count).toBe(1);
  if (process.platform === 'darwin') {
    expect(await app.evaluate(({ app: electronApp }) => electronApp.getBadgeCount())).toBe(1);
  }
  await expect(page.getByTestId('toast')).toBeVisible();
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
