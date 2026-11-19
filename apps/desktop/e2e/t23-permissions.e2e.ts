// T23-A08, A11, A12: "always allow" offers one prefix rule per subcommand, editable before
// the native confirmation; a critical deletion offers none; Bypass permissions appears only
// after it is enabled in settings and still asks natively; the Permissions page adds, edits
// and removes rules (allow rules behind the native confirmation) and filters the audit.
// Screenshots go to tmp/evidence/T23/.
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';

import { expect, test } from './sessions.js';
import { idle, openSession } from './t19.js';

const EVIDENCE = path.join(import.meta.dirname, '..', '..', '..', 'tmp', 'evidence', 'T23');

async function openSettings(app: ElectronApplication, page: Page): Promise<Page> {
  const opened = app.waitForEvent('window');
  await page.getByTestId('open-settings').click();
  const settings = await opened;
  await settings.getByTestId('settings-window').waitFor();
  return settings;
}

/** Answers every native message box with `responses` in turn and records each detail. */
async function scriptDialogs(app: ElectronApplication, responses: number[]): Promise<void> {
  await app.evaluate(({ dialog }, answers) => {
    const seen: string[] = [];
    (globalThis as { t23Dialogs?: string[] }).t23Dialogs = seen;
    dialog.showMessageBox = (...args: unknown[]) => {
      const options = args.at(-1) as { message?: string; detail?: string };
      seen.push(`${options.message ?? ''}\n${options.detail ?? ''}`);
      return Promise.resolve({ response: answers[seen.length - 1] ?? 1, checkboxChecked: false });
    };
  }, responses);
}

function dialogs(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as { t23Dialogs?: string[] }).t23Dialogs ?? []);
}

test('always allow saves one edited rule per subcommand; bypass needs settings and a native confirmation', async ({
  page,
  app,
  workspaces,
}) => {
  test.setTimeout(120_000);
  await mkdir(EVIDENCE, { recursive: true });
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'permissions 权限',
    't23-permissions',
    'Check the rules',
    { 'notes.txt': 'first line\nsecond line\n' },
  );
  const card = page.getByTestId('approval-card');
  await expect(card).toContainText("awk 'NR==1' notes.txt && printenv HOME");
  const rules = card.getByTestId('approval-rules');
  await expect(rules).toHaveValue('Bash(awk *)\nBash(printenv *)');
  await rules.fill('Bash(awk *)\nBash(printenv PATH *)\nBash(printenv HOME)');
  await card
    .getByRole('button', { name: 'Show full request' })
    .click()
    .catch(() => undefined);
  await card.screenshot({ path: path.join(EVIDENCE, 'always-allow-rules.png') });
  await scriptDialogs(app, [0]);
  await card.getByRole('button', { name: 'Always allow', exact: true }).click();
  // The next command runs without a card: ls is read-only, the rest match the saved rules.
  const critical = page.getByTestId('approval-card');
  await expect(critical).toContainText('rm -rf ~');
  expect(await dialogs(app)).toEqual([
    'Save the permission rules below?\nRules to save (one per line)\nBash(awk *)\nBash(printenv PATH *)\nBash(printenv HOME)',
  ]);
  expect(
    JSON.parse(await readFile(path.join(ws, '.piarc', 'settings.local.json'), 'utf8')),
  ).toMatchObject({
    permissions: { allow: ['Bash(awk *)', 'Bash(printenv PATH *)', 'Bash(printenv HOME)'] },
  });
  // A critical deletion cannot be allowed permanently.
  await expect(critical.getByTestId('approval-rules')).toHaveCount(0);
  await expect(critical.getByRole('button', { name: 'Always allow' })).toHaveCount(0);
  await critical.screenshot({ path: path.join(EVIDENCE, 'critical-delete.png') });
  await critical.getByRole('button', { name: 'Decline' }).click();
  await idle(page);

  // Bypass is not offered until the user enables it.
  const modeButton = page.getByTestId('permission-mode');
  await modeButton.click();
  const menu = page.getByRole('menu', { name: 'Permission mode' });
  await expect(menu.getByRole('menuitem', { name: /Plan/u })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Bypass permissions/u })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const settings = await openSettings(app, page);
  await settings.getByTestId('settings-nav-permissions').click();
  // A controlled checkbox: it turns on when the saved preference comes back.
  await settings.getByTestId('setting-enable-bypass').click();
  await expect(settings.getByTestId('setting-enable-bypass')).toBeChecked();
  await settings.screenshot({ path: path.join(EVIDENCE, 'bypass-setting.png') });
  await settings.close();
  await scriptDialogs(app, [1, 0]);
  await modeButton.click();
  await menu.getByRole('menuitem', { name: /Bypass permissions/u }).click();
  await expect(modeButton).toHaveText(/Manual/u);
  await modeButton.click();
  await menu.getByRole('menuitem', { name: /Bypass permissions/u }).click();
  await expect(modeButton).toHaveText(/Bypass permissions/u);
  await expect(page.getByTestId('mode-change-row').last()).toContainText('Bypass permissions');
  const shown = await dialogs(app);
  expect(shown).toHaveLength(2);
  expect(shown[0]).toContain('Switch this session to Bypass permissions?');
  await page.screenshot({ path: path.join(EVIDENCE, 'bypass-mode.png') });
});

test('the Permissions page edits rules by source behind a native confirmation and filters the audit', async ({
  page,
  app,
  workspaces,
}) => {
  test.setTimeout(120_000);
  await mkdir(EVIDENCE, { recursive: true });
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'audit 审计',
    't23-permissions',
    'Check the rules',
    { 'notes.txt': 'first line\nsecond line\n' },
  );
  // Decisions for the audit: decline the three cards of the turn.
  const card = page.getByTestId('approval-card');
  for (const command of ['printenv HOME', 'printenv PATH', 'rm -rf ~']) {
    await expect(card).toContainText(command);
    await card.getByRole('button', { name: 'Decline' }).click();
  }
  await idle(page);
  const settings = await openSettings(app, page);
  await settings.getByTestId('settings-nav-permissions').click();
  const local = settings.getByTestId('permission-source-projectLocal');
  await expect(local).toContainText('.piarc/settings.local.json');
  await expect(settings.getByTestId('permission-source-user')).toBeVisible();
  // Syntax is checked while typing; broad allow rules get a hint.
  await local.getByTestId('permission-add-projectLocal').click();
  const input = local.getByTestId('permission-rule-input');
  await input.fill('Bash(git push *');
  await expect(local.getByTestId('permission-check')).toContainText('Invalid');
  await expect(local.getByTestId('permission-save')).toBeDisabled();
  await input.fill('Bash(git *)');
  await expect(local.getByTestId('permission-broad')).toBeVisible();
  await settings.screenshot({ path: path.join(EVIDENCE, 'permissions-broad-hint.png') });
  // A new allow rule asks natively; cancelling keeps the file unchanged.
  await scriptDialogs(app, [1, 0, 0]);
  await input.fill('Bash(git log *)');
  await local.getByTestId('permission-save').click();
  await expect.poll(() => dialogs(app)).toHaveLength(1);
  await expect(local.getByTestId('permission-rule')).toHaveCount(0);
  await local.getByTestId('permission-save').click();
  await expect(local.getByTestId('permission-rule')).toHaveCount(1);
  await expect(local.getByTestId('permission-rule')).toContainText('Bash(git log *)');
  // Deny rules need no confirmation.
  await local.getByTestId('permission-add-projectLocal').click();
  await local.getByTestId('permission-behavior').selectOption('deny');
  await local.getByTestId('permission-rule-input').fill('Read(.env)');
  await local.getByTestId('permission-save').click();
  await expect(local.getByTestId('permission-rule')).toHaveCount(2);
  // Editing an allow rule asks again.
  const allowRow = local.getByTestId('permission-rule').filter({ hasText: 'Bash(git log *)' });
  await allowRow.getByRole('button', { name: 'Edit' }).click();
  await local.getByTestId('permission-rule-input').fill('Bash(git log --oneline *)');
  await local.getByTestId('permission-save').click();
  await expect(local).toContainText('Bash(git log --oneline *)');
  const shown = await dialogs(app);
  expect(shown).toHaveLength(3);
  expect(shown.every((d) => d.startsWith('Save this allow rule?'))).toBe(true);
  expect(shown[2]).toContain('Replaces\nBash(git log *)');
  expect(
    JSON.parse(await readFile(path.join(ws, '.piarc', 'settings.local.json'), 'utf8')),
  ).toMatchObject({
    permissions: { allow: ['Bash(git log --oneline *)'], deny: ['Read(.env)'] },
  });
  const denyRow = local.getByTestId('permission-rule').filter({ hasText: 'Read(.env)' });
  await denyRow.getByRole('button', { name: 'Remove' }).click();
  await expect(local.getByTestId('permission-rule')).toHaveCount(1);
  await settings.screenshot({ path: path.join(EVIDENCE, 'permissions-rules.png'), fullPage: true });
  // The audit: filter by tool and outcome.
  const audit = settings.getByTestId('permission-audit');
  await audit.getByRole('button', { name: 'Refresh' }).click();
  await expect(audit.getByTestId('audit-row').first()).toContainText('Bash');
  await audit.getByTestId('audit-tool').fill('Bash');
  await audit.getByTestId('audit-conclusion').selectOption('deny');
  await expect(audit.getByTestId('audit-row')).toHaveCount(3);
  await expect(audit.getByTestId('audit-row').first()).toContainText('Denied');
  await audit.getByTestId('audit-conclusion').selectOption('allow');
  await expect(audit.getByTestId('audit-row')).toHaveCount(0);
  await audit.getByTestId('audit-tool').fill('');
  await audit.getByTestId('audit-conclusion').selectOption('');
  await audit.getByTestId('audit-session').fill('no-such-session');
  await expect(audit.getByTestId('audit-row')).toHaveCount(0);
  await audit.getByTestId('audit-session').fill('');
  await expect(audit.getByTestId('audit-row').first()).toBeVisible();
  await audit.screenshot({ path: path.join(EVIDENCE, 'permissions-audit.png') });
});
