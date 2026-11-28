// Keep the computer awake while working (ADR-0109): the main process holds a power save blocker
// while a session is in a turn and the preference is on (the default), lets it go when the turn
// ends, and follows the switch in Settings › General at once. The blocker is read through the
// development build's test hook; the system's own sleep is checked by hand. Screenshots go to
// tmp/evidence/<task>/ with PIARC_EVIDENCE_TASK set.
import { execFileSync } from 'node:child_process';

import type { ElectronApplication } from '@playwright/test';

import { expectTestHooks } from './core.js';
import { closeSettings, openSettings } from './settings-panel.js';
import { expect, makeWorkspace, openFolder, startSession, test } from './sessions.js';
import { idle, prefer } from './t19.js';

function held(app: ElectronApplication): Promise<boolean | undefined> {
  return app.evaluate(() => globalThis.__piarcTestHooks?.keepAwake().held);
}

/** macOS: whether the app's process holds an idle-sleep assertion (`pmset -g assertions` lists
 * Chromium's `kIOPMAssertionTypeNoIdleSleep` as `NoIdleSleepAssertion`). */
async function systemAssertion(app: ElectronApplication): Promise<boolean> {
  const pid = await app.evaluate(() => process.pid);
  const out = execFileSync('/usr/bin/pmset', ['-g', 'assertions'], { encoding: 'utf8' });
  return out
    .split('\n')
    .some((line) => line.includes(`pid ${String(pid)}(`) && line.includes('NoIdleSleepAssertion'));
}

test('the computer is kept awake while a turn runs and the switch decides', async ({
  app,
  page,
  workspaces,
}, testInfo) => {
  test.setTimeout(120_000);
  await expectTestHooks(app);
  await prefer(page, { key: 'language', value: 'en' });
  expect(await held(app)).toBe(false);
  const ws = await makeWorkspace(workspaces, 'keep awake');
  await openFolder(page, app, ws);
  // `env sleep 3` asks first: the turn stays running while the card waits.
  await startSession(page, 'Take a while', 't18-slow');
  const card = page.locator('[data-approval-card=command]');
  await expect(card).toBeVisible();
  await expect.poll(() => held(app)).toBe(true);
  if (process.platform === 'darwin') await expect.poll(() => systemAssertion(app)).toBe(true);

  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-general').click();
  const toggle = settings.getByTestId('setting-keep-awake');
  await expect(toggle).toBeChecked();
  await settings.screenshot({ path: testInfo.outputPath('general-power.png') });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => held(app)).toBe(false);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(() => held(app)).toBe(true);
  await prefer(page, { key: 'appearance.theme', value: 'dark' });
  await settings.screenshot({ path: testInfo.outputPath('general-power-dark.png') });
  await prefer(page, { key: 'appearance.theme', value: 'light' });
  await closeSettings(settings);

  await card.getByRole('button', { name: 'Allow once' }).click();
  await expect(
    page.getByTestId('agent-message').filter({ hasText: 'Finished after a while.' }),
  ).toBeVisible({ timeout: 30_000 });
  await idle(page);
  await expect.poll(() => held(app)).toBe(false);
  if (process.platform === 'darwin') await expect.poll(() => systemAssertion(app)).toBe(false);
});
