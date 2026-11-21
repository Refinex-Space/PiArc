// T42-A04, A05, A06 with the real Core, Agent Host and mock provider: while the main window is
// in the background, a session waiting for approval raises a notification whose buttons answer
// through Core's ledger. Playwright cannot press a system notification's buttons, so the
// development build's test hook presses them (the same code path as Electron's `action`
// event). Allow once from the notification runs the command; a card already answered on the
// card turns the notification's answer into the in-app "already answered" reminder; a command
// too long to read in a notification only offers Open. Evidence in tmp/evidence/T42/.
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

import { expectTestHooks } from './core.js';
import { expect, makeWorkspace, openFolder, startSession, test } from './sessions.js';
import { prefer } from './t19.js';

const EVIDENCE = path.join(import.meta.dirname, '..', '..', '..', 'tmp', 'evidence', 'T42');

test('approval notifications answer through the ledger', async ({ app, page, workspaces }) => {
  test.setTimeout(120_000);
  await expectTestHooks(app);
  await mkdir(EVIDENCE, { recursive: true });
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'notify 通知');
  await openFolder(page, app, ws);
  await startSession(page, 'Check the environment', 't42-notify');
  // `env sleep 3` asks first: allowing it on the card leaves time to put another window in front.
  const allowOnce = (p = page) =>
    p.locator('[data-approval-card=command] button').filter({ hasText: /^Allow once$/u });
  await allowOnce().click();
  const opening = app.waitForEvent('window');
  await page.getByTestId('open-settings').click();
  const settings = await opening;
  await settings.getByTestId('settings-window').waitFor();
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .filter((w) => !w.isDestroyed() && !w.webContents.getURL().includes('#/settings'))
          .some((w) => w.isFocused()),
      ),
    )
    .toBe(false);

  const notified = () =>
    app.evaluate(() => globalThis.__piarcTestHooks?.attention().notified ?? []);
  // `printenv HOME`: a short command a notification may allow.
  await expect
    .poll(async () => (await notified()).find((n) => n.body.includes('printenv HOME'))?.actions, {
      timeout: 30_000,
    })
    .toEqual(['Allow once', 'Deny']);
  if (process.platform === 'darwin' && process.env.PIARC_CAPTURE_NOTIFICATION === '1') {
    // The banner itself (A06): only the system draws it, so the whole screen is captured while
    // it shows. Needs the terminal's screen recording permission and PiArc's notifications on.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await promisify(execFile)('screencapture', [
      '-x',
      path.join(EVIDENCE, 'macos-notification-banner.png'),
    ]);
  }
  await app.evaluate(() => globalThis.__piarcTestHooks?.notificationAction(0));

  // `printenv PATH`: answered on the card first; the notification's answer comes too late.
  await expect
    .poll(async () => (await notified()).some((n) => n.body.includes('printenv PATH')), {
      timeout: 30_000,
    })
    .toBe(true);
  await page
    .locator('[data-approval-card=command] button')
    .filter({ hasText: /^Decline$/u })
    .first()
    .click();
  await app.evaluate(() => globalThis.__piarcTestHooks?.notificationAction(0));
  await expect(
    page.getByText('That request was already answered or is no longer current.'),
  ).toBeVisible();

  // A command too long to read in a notification: Open only.
  await expect
    .poll(async () => (await notified()).find((n) => n.body.includes('LONG_VARIABLE'))?.actions, {
      timeout: 30_000,
    })
    .toEqual(['Open']);
  await page.screenshot({ path: path.join(EVIDENCE, 'notification-stale-reminder.png') });
  await page
    .locator('[data-approval-card=command] button')
    .filter({ hasText: /^Decline$/u })
    .first()
    .click();
  await expect(page.getByTestId('composer')).toHaveAttribute('data-running', 'false', {
    timeout: 30_000,
  });
  // The command allowed from the notification ran; the audit says where the answer came from.
  await expect(page.getByTestId('conversation')).toContainText('printenv HOME');
  const shown = await notified();
  await writeFile(
    path.join(EVIDENCE, 'notifications.json'),
    `${JSON.stringify(
      shown.filter((n) => n.kind === 'awaiting'),
      null,
      2,
    )}\n`,
  );

  // The settings page explains what the buttons do (or the fallback without notifications).
  await settings.getByTestId('settings-nav-general').click();
  await expect(settings.getByTestId('setting-notifications-note')).toContainText(
    'its notification can allow it once or deny it',
  );
  await settings.screenshot({ path: path.join(EVIDENCE, 'settings-notifications-light.png') });
  await prefer(page, { key: 'appearance.theme', value: 'dark' });
  await settings.screenshot({ path: path.join(EVIDENCE, 'settings-notifications-dark.png') });
  await prefer(page, { key: 'appearance.theme', value: 'light' });
});
