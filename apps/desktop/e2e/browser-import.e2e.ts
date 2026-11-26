// B5 of the built-in browser (ADR-0090, design addendum B5.1–B5.5): importing sign-ins from
// Chrome. The development build's Core reads a fixture Chrome folder (`PIARC_TEST_CHROME_ROOT`)
// with the fixed test key instead of the keychain or DPAPI (`createForTests`; release builds
// have no such override), so this never touches the machine's Chrome. The flow: choose the
// profile, tick sites (none ticked), the main process's native confirmation (answered by the
// development test hooks), the result; the cookie reaches the workspace's partition (the
// fixture page reads it), the page never sees a value, removing the site removes the cookie,
// and the clear-on-quit mode turns the import off.
import { createHash, createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ElectronApplication, Page } from '@playwright/test';

import { expect, test } from './sessions.js';
import { closeSettings, openSettings } from './settings-panel.js';
import { idle, openSession, prefer } from './t19.js';

const CHROME_ROOT = path.join(os.tmpdir(), `piarc-chrome-fixture-${String(process.pid)}`);
/** The fixture cookie's value: test data, never a real credential. */
const VALUE = 'piarc-import-e2e-value';
/** `piarc_browser_import::keys::TEST_PASSWORD`. */
const TEST_PASSWORD = 'piarc-test-chrome';
/** Seconds between 1601-01-01 and 1970-01-01 (Chrome's time). */
const EPOCH_GAP = 11_644_473_600;

test.use({ appEnv: { PIARC_TEST_CHROME_ROOT: CHROME_ROOT } });

/** Chrome's `v10` encryption with the test key (`piarc_browser_import::crypto::seal`). */
function seal(value: string, hostKey: string): Buffer {
  const plain = Buffer.concat([
    createHash('sha256').update(hostKey).digest(),
    Buffer.from(value, 'utf8'),
  ]);
  if (process.platform === 'win32') {
    const key = createHash('sha256').update(TEST_PASSWORD).digest();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from('v10'), nonce, body, cipher.getAuthTag()]);
  }
  const key = pbkdf2Sync(TEST_PASSWORD, 'saltysalt', 1003, 16, 'sha1');
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]);
}

function chromeTime(unixSeconds: number): bigint {
  return BigInt(unixSeconds + EPOCH_GAP) * 1_000_000n;
}

/** A Chrome folder with one profile whose cookies database has three sites' cookies. */
async function writeChromeFixture(): Promise<void> {
  await rm(CHROME_ROOT, { recursive: true, force: true });
  const network = path.join(CHROME_ROOT, 'Default', 'Network');
  await mkdir(network, { recursive: true });
  await writeFile(
    path.join(CHROME_ROOT, 'Local State'),
    JSON.stringify({ profile: { info_cache: { Default: { name: 'E2E Profile' } } } }),
  );
  const db = new DatabaseSync(path.join(network, 'Cookies'));
  db.exec(`CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL, is_persistent INTEGER NOT NULL, priority INTEGER NOT NULL, samesite INTEGER NOT NULL, source_scheme INTEGER NOT NULL, source_port INTEGER NOT NULL, last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL, has_cross_site_ancestor INTEGER NOT NULL);
INSERT INTO meta VALUES ('version', '24');`);
  const insert = db.prepare(
    `INSERT INTO cookies VALUES (0, ?, '', ?, '', ?, '/', ?, 0, 0, 0, 1, 1, 1, -1, 1, 80, 0, 0, 0)`,
  );
  const now = Math.floor(Date.now() / 1000);
  insert.run('127.0.0.1', 'piarc_import', seal(VALUE, '127.0.0.1'), chromeTime(now + 86_400));
  insert.run('127.0.0.1', 'piarc_old', seal('old', '127.0.0.1'), chromeTime(now - 60));
  insert.run('.example.test', 'other', seal('other', '.example.test'), chromeTime(now + 86_400));
  db.close();
}

let server: Server;
let origin = '';

test.beforeAll(async () => {
  await writeChromeFixture();
  // The page shows the cookies it gets as its title.
  server = createServer((_request, response) => {
    response
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(
        '<!doctype html><title>-</title><script>document.title = document.cookie || "none"</script>',
      );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  await rm(CHROME_ROOT, { recursive: true, force: true });
});

async function answerNext(app: ElectronApplication, answer: boolean): Promise<void> {
  await app.evaluate((_electron, value) => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) throw new Error('test hooks are missing: build the development app');
    hooks.answerConfirm(value);
  }, answer);
}

async function confirmations(
  app: ElectronApplication,
): Promise<readonly { message: string; detail: string }[]> {
  return app.evaluate(() => globalThis.__piarcTestHooks?.confirmations() ?? []);
}

async function openPreviewAt(page: Page, url: string): Promise<void> {
  if (!(await page.getByTestId('tile-preview').isVisible())) {
    await page.getByTestId('tool-preview').click();
  }
  const input = page.getByTestId('browser-address');
  await input.click();
  await input.fill(url);
  await input.press('Enter');
}

test('THR-17 imports chosen sites after the native confirmation; the page never sees a value', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(180_000);
  const { ws } = await openSession(app, page, workspaces, 'Chrome 导入', 't18-chat', 'Hello');
  await idle(page);
  await prefer(page, { key: 'language', value: 'en' });

  // B5.1: the site information menu opens the import for the page's site.
  await openPreviewAt(page, origin);
  await expect(page.getByTestId('browser-tab')).toHaveText(['none']);
  await page.getByTestId('browser-site').click();
  await page
    .getByRole('menuitem', {
      name: /Import this site’s sign-ins from Chrome…|从 Chrome 导入此站点的登录…/u,
    })
    .click();
  const dialog = page.getByTestId('chrome-import-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('chrome-import-profile').selectOption('Default');
  const sites = dialog.getByTestId('chrome-import-site');
  // Narrowed to the page's site; nothing is ticked and there is no "all".
  await expect(sites).toHaveCount(1);
  await expect(sites.first()).toHaveAttribute('data-site', '127.0.0.1');
  await dialog.getByTestId('chrome-import-only-host').uncheck();
  await expect(sites).toHaveCount(2);
  for (const box of await sites.all()) await expect(box).not.toBeChecked();
  await expect(dialog.getByTestId('chrome-import-submit')).toBeDisabled();
  await dialog.getByTestId('chrome-import-search').fill('127');
  await expect(sites).toHaveCount(1);
  await sites.first().check();

  // Cancelling the native confirmation imports nothing.
  await answerNext(app, false);
  await dialog.getByTestId('chrome-import-submit').click();
  await expect.poll(async () => (await confirmations(app)).length).toBe(1);
  const [shown] = await confirmations(app);
  expect(shown?.message).toBe('Import sign-ins for 1 site from Chrome?');
  expect(shown?.detail).toContain('“E2E Profile”');
  expect(shown?.detail).toContain('• 127.0.0.1');
  expect(shown?.detail).toContain('act as you');
  if (process.platform === 'darwin') {
    expect(shown?.detail).toContain('“Allow”, not “Always Allow”');
  }
  await expect(dialog.getByTestId('chrome-import-result')).toHaveCount(0);

  // Confirming imports the cookie that has not expired.
  await answerNext(app, true);
  await dialog.getByTestId('chrome-import-submit').click();
  const result = dialog.getByTestId('chrome-import-result');
  await expect(result).toBeVisible({ timeout: 30_000 });
  const site = result.locator('[data-site="127.0.0.1"]');
  await expect(site).toContainText(/1 cookie imported|已导入 1 条 cookie/u);
  await expect(site.locator('[data-reason="expired"]')).toContainText(
    /1 skipped: expired|跳过 1 条：已过期/u,
  );
  await dialog.getByTestId('chrome-import-close').click();
  await expect(page.getByTestId('browser-import-entry')).toHaveCount(1);
  await expect(page.getByTestId('browser-import-entry')).toContainText('127.0.0.1');
  await expect(page.getByTestId('browser-import-entry')).toContainText('E2E Profile');

  // The page never receives a value: the IPC answer has counts only.
  await answerNext(app, true);
  const outcome = await page.evaluate(
    ([workspace]) => window.piarc.chromeImport(workspace ?? '', 'Default', ['127.0.0.1']),
    [ws],
  );
  expect(outcome).toContain('"status":"imported"');
  expect(outcome).not.toContain(VALUE);
  await closeSettings(page);

  // B5.3: the cookie is in the workspace's partition.
  await page.getByTestId('browser-reload').click();
  await expect(page.getByTestId('browser-tab')).toHaveText([`piarc_import=${VALUE}`]);

  // Removing the site removes its cookie and its record.
  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-browser').click();
  await settings.getByTestId('browser-import-remove').click();
  await expect(settings.getByTestId('browser-imports-empty')).toBeVisible();
  await closeSettings(settings);
  await page.getByTestId('browser-reload').click();
  await expect(page.getByTestId('browser-tab')).toHaveText(['none']);

  // "Clear when PiArc quits" turns the import off.
  await prefer(page, { key: 'browser.storage', value: 'session' });
  const again = await openSettings(page);
  await again.getByTestId('settings-nav-browser').click();
  await expect(again.getByTestId('browser-import-open')).toBeDisabled();
  await expect(again.getByTestId('browser-import-disabled')).toBeVisible();
  const refused = await page.evaluate(
    ([workspace]) => window.piarc.chromeImport(workspace ?? '', 'Default', ['127.0.0.1']),
    [ws],
  );
  expect(refused).toBe('{"status":"unavailable"}');
  await closeSettings(again);
});

test('the browser settings page saves user-level settings', async ({ app, page, workspaces }) => {
  test.setTimeout(120_000);
  await openSession(app, page, workspaces, 'Browser settings', 't18-chat', 'Hello');
  await idle(page);
  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-browser').click();
  await expect(settings.getByTestId('browser-page')).toBeVisible();
  // The box follows the saved preference, so it changes once the write comes back.
  await settings.getByTestId('browser-agent-enabled').click();
  await expect(settings.getByTestId('browser-agent-enabled')).not.toBeChecked();
  await settings.getByTestId('browser-devtools-right').click({ force: true });
  await expect(settings.getByTestId('browser-devtools-right')).toBeChecked();
  await settings.getByTestId('browser-search-engine').selectOption('duckduckgo');
  const timeout = settings.getByTestId('browser-approval-timeout');
  await timeout.fill('45');
  await timeout.press('Enter');
  const names = settings.getByTestId('browser-local-names');
  await names.fill('*.localhost, *.dev');
  await settings.getByTestId('browser-local-names-save').click();
  await expect
    .poll(() => page.evaluate(() => window.piarc.getAppState().then((s) => s.preferences.browser)))
    .toMatchObject({
      agentEnabled: false,
      devtoolsDock: 'right',
      searchEngine: 'duckduckgo',
      approvalTimeout: 45,
      localHostnames: ['*.localhost', '*.dev'],
    });
  await settings.getByTestId('browser-local-names-reset').click();
  await expect(names).toHaveValue('*.localhost, *.test, *.local');
  await closeSettings(settings);
});
