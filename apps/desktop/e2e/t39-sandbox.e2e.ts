// T39: the Bash sandbox in the app. The sandbox page turns the sandbox on and off, switches
// its mode and edits the allowed domains and denyRead paths (A08; the organization's entries are
// read-only, adding domains and turning auto-approval on go through the native confirmation);
// the next command follows the change; a sandbox denial is in the audit under "Sandbox denials"
// (A07); a network-domain card allows once, adds to the allowlist or declines (A14). On Windows
// the switch is disabled and says why (A12). Screenshots go to tmp/evidence/T39/.
import { openSettings, closeSettings } from './settings-panel.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';

import { expect, test as base } from './sessions.js';
import { idle, lastUserBlocks, openSession, prefer, requests } from './t19.js';

const EVIDENCE = path.join(import.meta.dirname, '..', '..', '..', 'tmp', 'evidence', 'T39');
const ENTERPRISE = 'artifacts.corp.example';

const test = base.extend<{ hello: number; sandboxSettings: Record<string, unknown> }>({
  sandboxSettings: [{ enabled: true, autoAllowBashIfSandboxed: true }, { option: true }],
  // A local server the sandbox's proxy reaches under the names allowed.test and other.test.
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here.
  hello: async ({}, use) => {
    const server = http.createServer((_request, response) => {
      response.end('hello');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await use((server.address() as AddressInfo).port);
    server.close();
  },
  appEnv: async ({ hello }, use) => {
    await use({
      PIARC_TEST_SANDBOX_HOSTS: `allowed.test=${String(hello)},other.test=${String(hello)}`,
      PIARC_TEST_SANDBOX_ENTERPRISE_DOMAINS: ENTERPRISE,
    });
  },
  userDataDir: async ({ userDataDir, sandboxSettings }, use) => {
    await writeFile(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({ sandbox: sandboxSettings }),
    );
    await use(userDataDir);
  },
});

/** Native message boxes answer with button 0 and record their message and detail. */
async function confirmDialogs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const seen: string[] = [];
    (globalThis as { t39Dialogs?: string[] }).t39Dialogs = seen;
    dialog.showMessageBox = (...args: unknown[]) => {
      const options = args.at(-1) as { message?: string; detail?: string };
      seen.push(`${options.message ?? ''}\n${options.detail ?? ''}`);
      return Promise.resolve({ response: 0, checkboxChecked: false });
    };
  });
}

function dialogs(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as { t39Dialogs?: string[] }).t39Dialogs ?? []);
}

async function userSettings(dataDir: string): Promise<{ sandbox?: Record<string, unknown> }> {
  return JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')) as {
    sandbox?: Record<string, unknown>;
  };
}

/** The tool result text of call `id` in the mock's last request for `scenario`. */
async function toolResult(
  mock: Parameters<typeof requests>[0],
  scenario: string,
  id: string,
): Promise<string> {
  const all = await requests(mock, scenario);
  const blocks = all.flatMap((r) =>
    ((r.body.messages ?? []) as { role: string; content: unknown }[]).flatMap((m) =>
      Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [],
    ),
  );
  const block = blocks.findLast((b) => b.type === 'tool_result' && b.tool_use_id === id);
  return JSON.stringify(block?.content ?? '');
}

async function bothThemes(page: Page, settingsPage: Page, name: string): Promise<void> {
  await settingsPage.getByTestId('settings-page-sandbox').evaluate((node) => {
    node.scrollTop = 0;
  });
  for (const theme of ['light', 'dark'] as const) {
    await prefer(page, { key: 'appearance.theme', value: theme });
    await expect(settingsPage.locator('html')).toHaveAttribute('data-color-mode', theme);
    await settingsPage.screenshot({ path: path.join(EVIDENCE, `${name}-${theme}.png`) });
  }
  await prefer(page, { key: 'appearance.theme', value: 'system' });
}

test('the sandbox page edits the user values, the next command follows, denials are audited', async ({
  page,
  app,
  mock,
  workspaces,
  userDataDir,
}) => {
  test.skip(process.platform !== 'darwin', 'The command sandbox exists on macOS only (D7).');
  test.setTimeout(180_000);
  await mkdir(EVIDENCE, { recursive: true });
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'sandbox 沙箱',
    't39-sandbox',
    'Write outside',
  );
  await idle(page);
  // The command ran sandboxed without a card (auto-approval) and was refused.
  expect(await toolResult(mock, 't39-sandbox', 'escape')).toContain(
    "PiArc's sandbox refused writing",
  );
  await expect(page.getByTestId('env-sandbox')).toBeVisible();

  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-sandbox').click();
  const sandbox = settings.getByTestId('sandbox-page');
  await expect(sandbox.getByTestId('sandbox-enabled')).toBeChecked();
  await expect(sandbox.getByTestId('sandbox-mode-auto')).toBeChecked();
  // The organization's domain is listed read-only.
  const domains = sandbox.getByTestId('sandbox-domains');
  const managed = domains.locator('[data-readonly="true"]', { hasText: ENTERPRISE });
  await expect(managed).toContainText('Managed by your organization');
  await expect(managed.getByTestId('sandbox-domains-remove')).toHaveCount(0);

  await confirmDialogs(app);
  await domains.getByTestId('sandbox-domains-input').fill('registry.npmjs.org');
  await domains.getByRole('button', { name: 'Add' }).click();
  await expect(domains.getByTestId('sandbox-domains-entry')).toHaveCount(2);
  const denyRead = sandbox.getByTestId('sandbox-deny-read');
  await denyRead.getByTestId('sandbox-deny-read-input').fill('~/.aws');
  await denyRead.getByRole('button', { name: 'Add' }).click();
  await expect(denyRead.getByTestId('sandbox-deny-read-entry')).toHaveCount(1);
  expect((await userSettings(userDataDir)).sandbox).toMatchObject({
    network: { allowedDomains: ['registry.npmjs.org'] },
    filesystem: { denyRead: ['~/.aws'] },
  });
  expect(await dialogs(app)).toEqual([
    'Allow sandboxed commands to reach these domains?\nAllowed domains\nregistry.npmjs.org',
  ]);
  await expect(sandbox.getByTestId('sandbox-writable')).toContainText(ws);
  await bothThemes(page, settings, 'sandbox-page');

  // Switching off and on, and back to asking: the next command shows a card.
  await sandbox.getByTestId('sandbox-enabled').click();
  await expect(sandbox.getByTestId('sandbox-enabled')).not.toBeChecked();
  expect((await userSettings(userDataDir)).sandbox).toMatchObject({ enabled: false });
  // Switching off went through the native confirmation (R5).
  expect((await dialogs(app)).at(-1)).toMatch(/^Turn the sandbox off\?/u);
  await sandbox.getByTestId('sandbox-enabled').click();
  await expect(sandbox.getByTestId('sandbox-enabled')).toBeChecked();
  // The radio is styled away; its label takes the click, as a user's would.
  await sandbox.getByText('Still ask', { exact: true }).click();
  await expect(sandbox.getByTestId('sandbox-mode-ask')).toBeChecked();
  expect((await userSettings(userDataDir)).sandbox).toMatchObject({
    enabled: true,
    autoAllowBashIfSandboxed: false,
  });

  // The audit page, filtered to sandbox denials.
  await sandbox.getByTestId('sandbox-audit').click();
  await settings.getByTestId('permission-audit').waitFor();
  await expect(settings.getByTestId('audit-kind')).toHaveValue('sandbox');
  const row = settings.getByTestId('audit-row').filter({ hasText: 'escape.txt' });
  await expect(row).toContainText('Write refused');
  await settings
    .getByTestId('permission-audit')
    .screenshot({ path: path.join(EVIDENCE, 'sandbox-audit.png') });

  await closeSettings(settings);
  await page.getByTestId('composer-input').click();
  await page.keyboard.type('Write inside');
  await page.keyboard.press('Enter');
  const card = page.getByTestId('approval-card');
  await expect(card.getByTestId('approval-sandbox')).toHaveAttribute('data-place', 'sandbox');
  await expect(card).toContainText('Runs in the sandbox');
  for (const theme of ['light', 'dark'] as const) {
    await prefer(page, { key: 'appearance.theme', value: theme });
    await expect(page.locator('html')).toHaveAttribute('data-color-mode', theme);
    await card.screenshot({ path: path.join(EVIDENCE, `sandbox-card-${theme}.png`) });
  }
  await prefer(page, { key: 'appearance.theme', value: 'system' });
  await card.getByRole('button', { name: 'Allow once' }).click();
  await idle(page);
  expect(await readFile(path.join(ws, 'made.txt'), 'utf8')).toBe('ok');
});

test('a network-domain card allows once, adds to the allowlist or declines', async ({
  page,
  app,
  mock,
  workspaces,
  userDataDir,
}) => {
  test.skip(process.platform !== 'darwin', 'The command sandbox exists on macOS only (D7).');
  test.setTimeout(180_000);
  await mkdir(EVIDENCE, { recursive: true });
  await openSession(app, page, workspaces, 'network 网络', 't39-network', 'Fetch');
  const card = page.getByTestId('approval-card');
  await expect(card.getByTestId('approval-domain')).toContainText('allowed.test');
  await expect(card).toContainText('Allow network access?');
  for (const theme of ['light', 'dark'] as const) {
    await prefer(page, { key: 'appearance.theme', value: theme });
    await expect(page.locator('html')).toHaveAttribute('data-color-mode', theme);
    await card.screenshot({ path: path.join(EVIDENCE, `network-card-${theme}.png`) });
  }
  await prefer(page, { key: 'appearance.theme', value: 'system' });
  await card.getByRole('button', { name: 'Allow once' }).click();
  // Allowed once: the next connection asks again; this time it goes into the allowlist.
  await expect(card.getByTestId('approval-domain')).toContainText('allowed.test');
  await confirmDialogs(app);
  await card.getByTestId('approval-add-domain').click();
  await expect(card.getByTestId('approval-domain')).toContainText('other.test');
  await card.getByRole('button', { name: 'Decline' }).click();
  await idle(page);
  expect(await toolResult(mock, 't39-network', 'once')).toContain('hello');
  expect(await toolResult(mock, 't39-network', 'saved')).toContain('hello');
  const declined = await toolResult(mock, 't39-network', 'denied');
  expect(declined).toContain('403');
  expect(declined).toContain('connecting to other.test');
  expect(await dialogs(app)).toEqual([
    'Add this domain to the sandbox’s allowed domains?\nAllowed domains\nallowed.test',
  ]);
  expect((await userSettings(userDataDir)).sandbox).toMatchObject({
    network: { allowedDomains: ['allowed.test'] },
  });
  expect(lastUserBlocks((await requests(mock, 't39-network')).at(-1)?.body ?? {})).not.toEqual([]);
});

test.describe('on Windows', () => {
  test.use({ sandboxSettings: { enabled: true, autoAllowBashIfSandboxed: true } });

  test('the sandbox switch is unavailable and commands still ask', async ({
    page,
    app,
    workspaces,
  }) => {
    test.skip(process.platform !== 'win32', 'This checks the Windows notice (A12).');
    test.setTimeout(180_000);
    await mkdir(EVIDENCE, { recursive: true });
    const { ws } = await openSession(app, page, workspaces, 'windows 沙箱', 't39-windows', 'Go');
    // No sandbox, no auto-approval: the command asks.
    const card = page.getByTestId('approval-card');
    await expect(card).toContainText('printf w > w.txt');
    await expect(page.getByTestId('env-sandbox-warning')).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCE, 'windows-env-bar.png') });
    await card.getByRole('button', { name: 'Decline' }).click();
    await idle(page);
    await expect(readFile(path.join(ws, 'w.txt'), 'utf8')).rejects.toThrow();
    const settings = await openSettings(page);
    await settings.getByTestId('settings-nav-sandbox').click();
    const sandbox = settings.getByTestId('sandbox-page');
    await expect(sandbox.getByTestId('sandbox-enabled')).toBeDisabled();
    await expect(sandbox.getByTestId('sandbox-enabled-hint')).toHaveText(
      /sandbox is not available on Windows|Windows 上沙箱不可用/u,
    );
    await bothThemes(page, settings, 'windows-sandbox-page');
  });
});
