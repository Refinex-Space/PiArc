// T29-A06, A07, A08 in the settings window with the real Core and settings Agent Host: provider
// sign-in through the mock authorization server (piarc-mock-auth) with the authorization code
// and device code flows, refusal, expiry and cancel; Anthropic's subscription sign-in is not
// offered; per-model settings and the auxiliary model are saved. "Open in browser" goes through
// the main process's confirmation, whose shell.openExternal is replaced by a fetch that follows
// the redirect to the Agent Host's loopback server, as the user's browser would.
// Screenshots go to tmp/evidence/T29/ with PIARC_EVIDENCE_TASK=T29.
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { browserDouble, PROVIDER, PROVIDER_FILE, startAuth, writeProvider } from './oauth.js';
import { settingsWindow } from './provider-settings.js';
import { expect, test } from './sessions.js';

const repoRoot = path.join(import.meta.dirname, '..', '..', '..');
const EVIDENCE = path.join(repoRoot, 'tmp', 'evidence', process.env.PIARC_EVIDENCE_TASK ?? 'L4');
test.use({ appEnv: { PIARC_TEST_OAUTH_PROVIDER: PROVIDER_FILE } });

async function shoot(page: Page, name: string): Promise<void> {
  await mkdir(EVIDENCE, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE, `${name}.png`) });
}

/** Opens "add a service" and picks the test provider's sign-in. */
async function signIn(settings: Page): Promise<void> {
  await settings.getByTestId('provider-add').click();
  await settings.getByTestId(`login-${PROVIDER}`).click();
  await expect(settings.getByTestId('login-dialog')).toBeVisible();
}

async function outcome(settings: Page, state: string): Promise<void> {
  await expect(settings.getByTestId('login-outcome')).toHaveAttribute('data-state', state, {
    timeout: 30_000,
  });
}

test('sign-in flows, refusal, expiry and cancel; model settings', async ({
  app,
  page,
  mock,
  userDataDir,
}) => {
  test.setTimeout(180_000);
  const auth = await startAuth();
  try {
    await writeProvider(auth, mock.baseUrl, 'authorizationCode');
    await browserDouble(app);
    const settings = await settingsWindow(page);
    // "Add a service" offers the sign-in; Anthropic's subscription sign-in is not offered.
    await settings.getByTestId('provider-add').click();
    await expect(settings.getByTestId(`login-provider-${PROVIDER}`)).toBeVisible();
    await expect(settings.getByTestId('login-provider-anthropic')).toHaveCount(0);
    await shoot(settings, 'login-providers');
    await settings.keyboard.press('Escape');
    const row = settings.getByTestId(`account-${PROVIDER}`);

    // Authorization code: the page opens in the browser (after the confirmation) and the
    // loopback callback finishes the sign-in.
    await signIn(settings);
    await expect(settings.getByTestId('login-auth-url')).toBeVisible();
    await shoot(settings, 'login-auth-url');
    await settings.getByTestId('login-open-browser').click();
    await outcome(settings, 'succeeded');
    await shoot(settings, 'login-succeeded');
    const opened = await app.evaluate(
      () => (globalThis as { __t29Opened?: string[] }).__t29Opened ?? [],
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain(`${auth.base}/authorize?`);
    await settings.getByTestId('login-close').click();
    await expect(row).toBeVisible();
    await settings.getByTestId(`logout-${PROVIDER}`).click();
    await expect(row).toHaveCount(0);

    // The user refuses at the authorization server.
    auth.decide('deny');
    await signIn(settings);
    await settings.getByTestId('login-open-browser').click();
    await outcome(settings, 'failed');
    await expect(settings.getByTestId('login-outcome')).toContainText('access_denied');
    await shoot(settings, 'login-denied');
    await settings.getByTestId('login-close').click();

    // Cancel while waiting for the browser: the step takes the focus, so Escape cancels.
    auth.decide('approve');
    await signIn(settings);
    await expect(settings.getByTestId('login-open-browser')).toBeFocused();
    await settings.keyboard.press('Escape');
    await outcome(settings, 'cancelled');
    await settings.getByTestId('login-close').click();

    // Device code: the code is shown while the Agent Host polls; then it expires once.
    await writeProvider(auth, mock.baseUrl, 'deviceCode');
    auth.decide('expire');
    await signIn(settings);
    await expect(settings.getByTestId('login-user-code')).toContainText('PIAR-C029');
    await shoot(settings, 'login-device-code');
    await outcome(settings, 'failed');
    await expect(settings.getByTestId('login-outcome')).toContainText('expired');
    await shoot(settings, 'login-expired');
    await settings.getByTestId('login-close').click();
    auth.decide('approve');
    await signIn(settings);
    await outcome(settings, 'succeeded');
    await settings.getByTestId('login-close').click();
    await expect(row).toBeVisible();

    // Per-model settings and the auxiliary model, saved to the user's settings.
    const key = `${PROVIDER}/oauth-model`;
    await settings.getByTestId(`model-edit-${key}`).click();
    const form = settings.getByTestId(`model-form-${key}`);
    await form.getByTestId('model-display-name').fill('OAuth model (work)');
    await form.getByTestId('model-context-window').fill('64000');
    await form.getByTestId('model-vision').selectOption('off');
    await form.getByTestId('model-tool-profile').selectOption('conservative');
    await shoot(settings, 'model-settings-form');
    await form.getByTestId('model-save').click();
    await expect(settings.getByTestId(`model-row-${key}`)).toContainText('OAuth model (work)');
    await expect(settings.getByTestId(`model-row-${key}`)).toContainText('64,000');
    await settings.getByTestId('auxiliary-model').selectOption(key);
    await expect(settings.getByTestId('auxiliary-model')).toHaveValue(key);
    await shoot(settings, 'model-settings-saved');
    const saved = JSON.parse(await readFile(path.join(userDataDir, 'settings.json'), 'utf8')) as {
      modelProviders?: { models?: Record<string, unknown>; auxiliary?: unknown };
    };
    expect(saved.modelProviders?.models?.[key]).toEqual({
      displayName: 'OAuth model (work)',
      contextWindow: 64_000,
      vision: false,
      toolProfile: 'conservative',
    });
    expect(saved.modelProviders?.auxiliary).toEqual({ provider: PROVIDER, id: 'oauth-model' });
    // No token in the settings file (the vault holds it).
    expect(JSON.stringify(saved)).not.toContain('piarc-t29-access');

    // ADR-0083: signing in again adds an account; the first one moves aside, comes back in
    // use, and the other one is removed (the native confirmation answers yes).
    await signIn(settings);
    await outcome(settings, 'succeeded');
    await settings.getByTestId('login-close').click();
    const aside = settings.locator(`[data-testid^="account-${PROVIDER}-"]`);
    await expect(aside).toHaveCount(1);
    await expect(row).toBeVisible();
    await shoot(settings, 'accounts-two');
    // The account set aside is the other one once the switch is done.
    const first = await aside.getAttribute('data-testid');
    await settings.locator(`[data-testid^="account-use-${PROVIDER}-"]`).click();
    await expect(aside).not.toHaveAttribute('data-testid', first ?? '');
    await expect(aside).toHaveCount(1);
    await settings.locator(`[data-testid^="account-remove-${PROVIDER}-"]`).click();
    await expect(aside).toHaveCount(0);
    await expect(row).toBeVisible();

    // Turned off, the provider stays listed and marked; on again.
    await settings.getByTestId(`provider-enabled-${PROVIDER}`).uncheck();
    await expect(row).toHaveClass(/is-off/u);
    await shoot(settings, 'provider-off');
    await settings.getByTestId(`provider-enabled-${PROVIDER}`).check();
    await expect(row).not.toHaveClass(/is-off/u);
  } finally {
    auth.stop();
  }
});
