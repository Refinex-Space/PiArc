// Installing from the market (ADR-0102): for every project (off until the native confirmation
// turns it on), for this project only (needs the project trusted), updates, and uninstalling from
// the market's details and from the installed view, with the two-step confirmation in place.
// The installed package is what the catalog described (Core checks name, version and
// integrity); this spec checks what the user sees.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ElectronApplication } from '@playwright/test';

import { expect, marketRow, openMarket, test } from './market.js';
import { focusMain, makeWorkspace, openFolder, startSession } from './sessions.js';
import { idle, prefer } from './t19.js';

const EVIDENCE = path.join(import.meta.dirname, '..', '..', '..', 'tmp', 'evidence', 'market');

async function answerNext(app: ElectronApplication, answer: boolean): Promise<void> {
  await app.evaluate((_electron, value) => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) throw new Error('test hooks are missing: build the development app');
    hooks.answerConfirm(value);
  }, answer);
}

test('installs off, turns on through the native confirmation and uninstalls in two steps', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(240_000);
  await mkdir(EVIDENCE, { recursive: true });
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'market 市场', {});
  await openFolder(page, app, ws);
  await startSession(page, 'Hello', 't18-chat', 'trust');
  await idle(page);
  await focusMain(app);

  const settings = await openMarket(page);
  const lint = marketRow(settings, 'pi-lint-skills');
  await expect(lint).toBeVisible({ timeout: 30_000 });
  const action = settings.getByTestId('market-action-pi-lint-skills');
  await expect(action).toHaveAttribute('data-action', 'install');

  // The menu offers this project only (the project is trusted).
  await settings.getByTestId('market-action-pi-lint-skills-more').click();
  await expect(settings.getByTestId('market-action-pi-lint-skills-project')).toBeEnabled();
  await settings.screenshot({ path: path.join(EVIDENCE, 'install-menu-light-en.png') });
  await settings.keyboard.press('Escape');

  await action.click();
  await expect(settings.getByTestId('market-notice')).toContainText('is installed', {
    timeout: 90_000,
  });
  await expect(action).toHaveAttribute('data-action', 'enable');

  // Cancelling the native confirmation leaves it off; confirming turns it on.
  await answerNext(app, false);
  await action.click();
  await expect(action).toHaveAttribute('data-action', 'enable');
  await answerNext(app, true);
  await action.click();
  await expect(action).toHaveAttribute('data-action', 'enabled', { timeout: 30_000 });

  // Another package for this project only.
  await settings.getByTestId('market-action-@demo/prompts-more').click();
  await settings.getByTestId('market-action-@demo/prompts-project').click();
  await expect(settings.getByTestId('market-action-@demo/prompts')).toHaveAttribute(
    'data-action',
    'enable',
    { timeout: 90_000 },
  );

  // Uninstall from the details: the first click asks once more in place.
  await lint.getByTestId('market-open').click();
  await settings.getByTestId('package-uninstall-start').click();
  await expect(settings.getByTestId('package-uninstall-hint')).toHaveText(
    'Removes it from this computer; every project stops using it.',
  );
  await settings.screenshot({ path: path.join(EVIDENCE, 'uninstall-confirm-light-en.png') });
  await settings.getByTestId('package-uninstall-cancel').click();
  await expect(settings.getByTestId('package-uninstall-hint')).toHaveCount(0);
  await settings.getByTestId('package-uninstall-start').click();
  await settings.getByTestId('package-uninstall').click();
  await expect(settings.getByTestId('market-action-pi-lint-skills')).toHaveAttribute(
    'data-action',
    'install',
    { timeout: 30_000 },
  );
  await settings.getByTestId('market-back').click();

  // The installed view: the project package has a visible uninstall.
  await settings.getByTestId('skills-view-installed').check({ force: true });
  const row = settings.locator('[data-testid="package-row"][data-id="@demo/prompts"]');
  await expect(row).toBeVisible();
  await expect(
    settings.locator('[data-testid="package-row"][data-id="pi-lint-skills"]'),
  ).toHaveCount(0);
  await row.getByTestId('package-uninstall-start').click();
  await row.getByTestId('package-uninstall').click();
  await expect(row).toHaveCount(0, { timeout: 30_000 });

  // M-22: the permissions page's audit lists the package rows.
  await page.evaluate(() => {
    window.location.hash = '#/settings/permissions?audit=plugin';
  });
  await expect(settings.getByTestId('audit-kind')).toHaveValue('plugin');
  const audit = settings.getByTestId('permission-audit-table');
  await expect(audit).toContainText('pi-lint-skills@1.2.0');
  await expect(audit).toContainText('Market');
  await expect(audit).toContainText('Uninstall');
  await settings
    .getByTestId('permission-audit')
    .screenshot({ path: path.join(EVIDENCE, 'audit-packages-light-en.png') });
});

test('a skill shows its own file in Finder, and only a skill Core lists', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'skills 技能', {
    '.claude/skills/tidy/SKILL.md': '---\nname: tidy\ndescription: Tidy up\n---\nTidy.\n',
  });
  await openFolder(page, app, ws);
  await startSession(page, 'Hello', 't18-chat', 'trust');
  await idle(page);
  // The native reveal is replaced by a recorder (Playwright cannot see Finder).
  await app.evaluate(({ shell }) => {
    const shown: string[] = [];
    Object.assign(globalThis, { __piarcShown: shown });
    shell.showItemInFolder = (file: string) => {
      shown.push(file);
    };
  });
  const settings = await openMarket(page);
  await settings.getByTestId('skills-view-installed').check({ force: true });
  const row = settings.locator('[data-testid="skill-row"][data-name="tidy"]');
  await row.getByTestId('skill-more-tidy').click();
  await settings.getByTestId('skill-reveal').click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as { __piarcShown?: string[] }).__piarcShown ?? []))
    .toEqual([path.join(ws, '.claude', 'skills', 'tidy', 'SKILL.md')]);
  // A name Core does not list reveals nothing.
  const refused = await page.evaluate(
    (dir) =>
      window.piarc.revealSkill(dir, 'not-a-skill').then(
        () => 'revealed',
        () => 'refused',
      ),
    ws,
  );
  expect(refused).toBe('refused');
});
