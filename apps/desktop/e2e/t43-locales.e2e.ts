// T43-A09: the main pages in Chinese and in English, with no text cut off or spilling out of its
// control: buttons, tabs, navigation items, table headers and badges whose content is wider than
// their box are reported (text meant to end in an ellipsis is not in this set). Screenshots go to
// tmp/evidence/T43/locales/ with PIARC_EVIDENCE_TASK=T43.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { ElectronApplication, Page } from '@playwright/test';

import { expect, focusMain, makeWorkspace, openFolder, test } from './sessions.js';
import { idle, prefer } from './t19.js';

const EVIDENCE = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'tmp',
  'evidence',
  process.env.PIARC_EVIDENCE_TASK ?? 'L4',
  'locales',
);

/** Controls whose text is wider than the control. */
function overflowing(page: Page) {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        'button, [role="tab"], .settings-nav-item, th, .badge, .change-tag, .segment, label',
      ),
    ]
      .filter((el) => el.offsetParent !== null && getComputedStyle(el).textOverflow !== 'ellipsis')
      .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 2)
      .map((el) => `${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 40)}"`),
  );
}

async function capture(page: Page, language: string, name: string, problems: string[]) {
  await page.screenshot({ path: path.join(EVIDENCE, `${language}-${name}.png`) });
  for (const p of await overflowing(page)) problems.push(`${language} ${name}: ${p}`);
}

async function openSettings(app: ElectronApplication, page: Page): Promise<Page> {
  const opened = app.waitForEvent('window');
  await page.getByTestId('open-settings').click();
  const settings = await opened;
  await settings.getByTestId('settings-window').waitFor();
  return settings;
}

test('the main pages in Chinese and English, with nothing cut off', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(240_000);
  await mkdir(EVIDENCE, { recursive: true });
  const problems: string[] = [];
  const ws = await makeWorkspace(workspaces, 'locales 语言', {
    'notes.txt': 'The release is on Friday.\n',
  });
  await openFolder(page, app, ws);
  await page.getByTestId('home-input').fill('Read the notes. [[piarc-scenario:t43-rows]]');
  await page.getByTestId('home-start').click();
  await page.getByTestId('trust-accept').click();
  await expect(page.getByTestId('conversation')).toBeVisible({ timeout: 30_000 });
  await focusMain(app);
  await idle(page);
  const settings = await openSettings(app, page);

  for (const language of ['zh-CN', 'en'] as const) {
    await prefer(page, { key: 'language', value: language });
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await capture(page, language, 'conversation', problems);
    await page.getByTestId('panel-tab-changes-card').click();
    await page.getByTestId('changes-open').click();
    await capture(page, language, 'changes', problems);
    await page.getByTestId('new-session').click();
    await capture(page, language, 'new-session', problems);
    await page.getByTestId('session-title').first().click();
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
    ]) {
      await settings.getByTestId(`settings-nav-${id}`).click();
      await expect(settings.getByTestId(`settings-page-${id}`)).toBeVisible();
      await capture(settings, language, `settings-${id}`, problems);
    }
  }
  expect(problems).toEqual([]);
});
