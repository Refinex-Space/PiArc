// S6 (T12): whether an ad-hoc signed build can post system notifications (ADR-0018 rule 6).
// Electron 42+ uses UNNotification on macOS, which may refuse unsigned apps; the program side
// must learn the outcome either way (`show` or `failed`), so the app can fall back to in-app
// reminders. Whether the banner actually appears is checked by eye
// (docs/spikes/S06-first-run-checklist.md). Packaged form only: the `dev` form runs
// Electron's own signed bundle, which says nothing about PiArc's signature.
import { writeFile } from 'node:fs/promises';

import { expectTestHooks } from './core.js';
import { expect, test } from './fixtures.js';

test('a notification reports show or failed to the program', async ({ app }, testInfo) => {
  await expectTestHooks(app);
  const result = await app.evaluate(async () => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) {
      throw new Error('no Core test hooks');
    }
    return hooks.showNotification('PiArc S6', 'Notification probe (T12)', 5_000);
  });
  await writeFile(
    testInfo.outputPath('notification.json'),
    `${JSON.stringify({ platform: process.platform, ...result }, null, 2)}\n`,
  );
  expect(result.supported).toBe(true);
  const outcomes = result.events
    .filter((e) => e.type === 'show' || e.type === 'failed')
    .map((e) => e.type)
    .join(',');
  // Electron reports `show` once it hands the notification to the system. On Windows a toast
  // the system then refuses (notifications turned off for the app, W0) also reports `failed`
  // after it, so there the last event is the outcome.
  expect(
    process.platform === 'win32' ? ['show', 'failed', 'show,failed'] : ['show', 'failed'],
    JSON.stringify(result.events),
  ).toContain(outcomes);
});
