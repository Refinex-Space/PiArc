// T43-A01: axe on every state of the accessibility state list (`a11y/states.ts`), light and
// dark, with the real Core, Agent Host and mock provider. Journeys reach the states the way a
// user does; `checkState` writes each axe result to tmp/evidence/T43/axe/ and fails on any
// violation. The last test checks every listed state was reached in this run.
import { readdir } from 'node:fs/promises';

import type { ElectronApplication, Page } from '@playwright/test';

import { AXE_DIR, checkState } from './a11y.js';
import { A11Y_STATES } from './a11y/states.js';
import { expect, focusMain, makeWorkspace, openFolder, test } from './sessions.js';
import { idle, prefer, send } from './t19.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function openSettings(app: ElectronApplication, page: Page): Promise<Page> {
  const opened = app.waitForEvent('window');
  await page.getByTestId('open-settings').click();
  const settings = await opened;
  await settings.getByTestId('settings-window').waitFor();
  return settings;
}

/** Opens a rail tab (card) by its panel id. */
async function railTab(page: Page, panel: string): Promise<void> {
  await page.getByTestId(`panel-tab-${panel}`).click();
}

test('windows, the trust dialog, a first conversation, palettes, rail cards and settings pages', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(240_000);
  await prefer(page, { key: 'language', value: 'en' });
  await checkState(page, 'window:welcome');

  const ws = await makeWorkspace(workspaces, 'a11y 无障碍', {
    'notes.txt': 'The release is on Friday.\n',
    '.piarc/settings.json': JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] }] },
    }),
  });
  await openFolder(page, app, ws);
  await checkState(page, 'window:new-session');

  await page.getByTestId('home-input').fill('Read the notes. [[piarc-scenario:t43-rows]]');
  await page.getByTestId('home-start').click();
  await expect(page.getByTestId('trust-dialog')).toBeVisible();
  await checkState(page, 'dialog:trust');
  await page.getByTestId('trust-accept').click();
  await expect(page.getByTestId('conversation')).toBeVisible({ timeout: 30_000 });
  await focusMain(app);
  await idle(page);
  await checkState(page, 'window:conversation');
  await checkState(page, 'row:userMessage');
  await checkState(page, 'row:agentMessage');
  await checkState(page, 'row:reasoning');
  await checkState(page, 'row:group');

  await page.keyboard.press(`${MOD}+K`);
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await checkState(page, 'dialog:command-palette');
  await page.keyboard.press('Escape');
  await page.keyboard.press(`${MOD}+/`);
  await expect(page.getByRole('dialog')).toBeVisible();
  await checkState(page, 'dialog:shortcuts');
  await page.keyboard.press('Escape');

  await railTab(page, 'context');
  await checkState(page, 'panel:context');
  await railTab(page, 'usage');
  await checkState(page, 'panel:usage');
  await railTab(page, 'changes-card');
  await checkState(page, 'panel:changes-card');
  await page.getByTestId('changes-open').click();
  await expect(page.getByTestId('changes-empty')).toBeVisible();
  await checkState(page, 'state:changes-empty');

  await page.getByTestId('session-filter').fill('Friday');
  await expect(page.getByTestId('search-hit').first()).toBeVisible({ timeout: 20_000 });
  await checkState(page, 'window:message-search');
  await page.getByTestId('session-filter').fill('');

  const settings = await openSettings(app, page);
  for (const id of [
    'general',
    'appearance',
    'providers',
    'permissions',
    'sandbox',
    'agents',
    'skills',
    'mcp',
    'usage',
    'diagnostics',
    'shortcuts',
  ] as const) {
    await settings.getByTestId(`settings-nav-${id}`).click();
    await expect(settings.getByTestId(`settings-page-${id}`)).toBeVisible();
    await checkState(settings, `settings:${id}`);
  }
  await send(page, 'Thanks.');
});

test('every listed state was checked in this run', async () => {
  const checked = new Set(
    (await readdir(AXE_DIR).catch(() => []))
      .filter((f) => f.endsWith('.checked'))
      .map((f) => f.slice(0, -'.checked'.length)),
  );
  const missing = A11Y_STATES.map((s) => s.id).filter(
    (id) => !checked.has(id.replace(/[^a-z0-9-]+/giu, '_')),
  );
  expect(missing).toEqual([]);
});
