// The first-run guide (ADR-0110): it opens by itself on a fresh data directory, "Set up later"
// stays done after a restart, a custom endpoint is connected for real against a local vendor
// stand-in (model list, a wrong key, then a working one, then a first turn), a sign-in through
// the mock authorization server finishes it, and Settings and the new session page open its
// "Connect a model" again. Built-in providers would reach the real vendor: their save-then-test
// path is the component test `onboarding/ConnectModel.test.tsx`.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import type { ElectronApplication, Page } from '@playwright/test';

import { browserDouble, PROVIDER, PROVIDER_FILE, startAuth, writeProvider } from './oauth.js';
import { closeSettings, openSettings } from './settings-panel.js';
import { expect, makeWorkspace, openFolder, relaunch, startSession, test } from './sessions.js';
import { prefer } from './t19.js';

const EVIDENCE = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'tmp',
  'evidence',
  process.env.PIARC_EVIDENCE_TASK ?? 'onboarding',
);
const GOOD_KEY = 'sk-onboarding-good-0001';
const WRONG_KEY = 'sk-onboarding-wrong-0002';

/** A fresh data directory: no first-run mark and no model. */
const firstRun = test.extend({
  userDataDir: async ({ userDataDir }, use) => {
    await writeFile(path.join(userDataDir, 'settings.json'), '{}');
    await use(userDataDir);
  },
});
firstRun.use({ seedMockModel: false });

async function shoot(page: Page, name: string): Promise<void> {
  await mkdir(EVIDENCE, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE, `${name}.png`) });
}

/** Resizes the window's content and checks that nothing scrolls sideways. */
async function narrow(app: ElectronApplication, page: Page, width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
    },
    { width, height },
  );
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
  const overflow = await page.evaluate(() => {
    const scroll = document.querySelector('.onboarding-scroll');
    return scroll === null ? -1 : scroll.scrollWidth - scroll.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
}

async function userSettings(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

interface Vendor {
  readonly baseUrl: string;
  readonly calls: { method: string; url: string; auth: string | null }[];
  close(): Promise<void>;
}

/**
 * An OpenAI-compatible vendor on loopback: `/v1/models` lists two models, chat completions
 * stream "OK" for the good key and answer 401, echoing the key, for any other.
 */
async function startVendor(): Promise<Vendor> {
  const calls: Vendor['calls'] = [];
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? null;
    calls.push({ method: req.method ?? '', url: req.url ?? '', auth });
    req.resume();
    req.on('end', () => {
      if (auth !== `Bearer ${GOOD_KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `invalid key ${auth ?? ''}` } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'stub-a' }, { id: 'stub-b' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (body: unknown) => {
          res.write(`data: ${JSON.stringify(body)}\n\n`);
        };
        const base = { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'stub-b' };
        chunk({
          ...base,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }],
        });
        chunk({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        });
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

firstRun(
  'a first run opens the welcome; "Set up later" lands on the new session page and stays done',
  async ({ page, appForm, app, userDataDir }) => {
    test.setTimeout(90_000);
    const guide = page.getByTestId('onboarding');
    await expect(guide).toBeVisible();
    await expect(guide).toHaveAttribute('data-step', 'welcome');
    // The workbench under it is inert: shortcuts and Escape change nothing.
    await expect(page.getByTestId('app-shell')).toHaveAttribute('inert', '');
    await page.keyboard.press('Escape');
    await expect(guide).toHaveAttribute('data-step', 'welcome');
    await expect(page.getByTestId('onboarding-mascot')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'PiArc' })).toBeFocused();
    for (const language of ['en', 'zh-CN'] as const) {
      await prefer(page, { key: 'language', value: language });
      for (const theme of ['light', 'dark'] as const) {
        await prefer(page, { key: 'appearance.theme', value: theme });
        await shoot(page, `welcome-${language}-${theme}`);
      }
    }
    await prefer(page, { key: 'appearance.theme', value: 'light' });
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('onboarding-start')).toBeFocused();
    // The smallest main window (960 × 600): the mascot, the name and both actions fit.
    await narrow(app, page, 960, 600);
    await expect(page.getByTestId('onboarding-mascot')).toBeInViewport();
    await expect(page.getByTestId('onboarding-later')).toBeInViewport();
    await shoot(page, 'welcome-zh-CN-narrow');
    await narrow(app, page, 1200, 800);
    await prefer(page, { key: 'language', value: 'en' });
    await page.getByTestId('onboarding-later').click();
    await expect(guide).toHaveCount(0);
    await expect(page.getByTestId('home')).toBeVisible();
    await expect(page.getByTestId('app-shell')).not.toHaveAttribute('inert', '');
    await expect
      .poll(async () => (await userSettings(userDataDir)).onboarding)
      .toEqual({
        completed: true,
      });

    await app.close();
    const again = await relaunch(appForm, userDataDir);
    try {
      await expect(again.page.getByTestId('home')).toBeVisible();
      await expect(again.page.getByTestId('onboarding')).toHaveCount(0);
      await expect(again.page.getByTestId('onboarding-cover')).toHaveCount(0);
    } finally {
      await again.app.close();
    }
  },
);

firstRun(
  'a custom endpoint: its models, a wrong key, a working one, then a first turn',
  async ({ page, app, workspaces, userDataDir }) => {
    test.setTimeout(150_000);
    const vendor = await startVendor();
    try {
      await prefer(page, { key: 'language', value: 'en' });
      await page.getByTestId('onboarding-start').click();
      const guide = page.getByTestId('onboarding');
      await expect(guide).toHaveAttribute('data-step', 'connect');
      await expect(page.getByRole('heading', { name: 'Connect a model' })).toBeFocused();
      await expect(page.getByTestId('onboarding-card')).toBeVisible();
      for (const theme of ['light', 'dark'] as const) {
        await prefer(page, { key: 'appearance.theme', value: theme });
        await shoot(page, `connect-en-${theme}`);
      }
      await prefer(page, { key: 'language', value: 'zh-CN' });
      await shoot(page, 'connect-zh-CN-dark');
      await prefer(page, { key: 'appearance.theme', value: 'light' });
      await shoot(page, 'connect-zh-CN-light');
      await narrow(app, page, 960, 600);
      await shoot(page, 'connect-zh-CN-narrow');
      await narrow(app, page, 1200, 800);
      await prefer(page, { key: 'language', value: 'en' });

      await page.getByTestId('onboarding-tile-custom').click();
      await page.getByTestId('onboarding-url').fill(vendor.baseUrl);
      await page.getByTestId('onboarding-key').fill(GOOD_KEY);
      await page.getByTestId('onboarding-discover').click();
      await page.getByTestId('onboarding-chip-stub-b').click();
      await expect(page.getByTestId('onboarding-model')).toHaveValue('stub-b');
      await shoot(page, 'connect-custom-models');

      // Changing the address drops the key typed for the old one.
      await page.getByTestId('onboarding-url').fill(`${vendor.baseUrl}/`);
      await expect(page.getByTestId('onboarding-key')).toHaveValue('');
      await page.getByTestId('onboarding-url').fill(vendor.baseUrl);
      await page.getByTestId('onboarding-model').fill('stub-b');

      await page.getByTestId('onboarding-key').fill(WRONG_KEY);
      await page.getByTestId('onboarding-submit').click();
      const failed = page.getByTestId('onboarding-failed');
      await expect(failed).toBeVisible({ timeout: 60_000 });
      await expect(failed).toContainText('401');
      // The vendor echoes the key it was sent; the answer shown never carries it.
      await expect(failed).not.toContainText(WRONG_KEY);
      await expect(page.getByTestId('onboarding-key')).toBeFocused();
      await shoot(page, 'connect-custom-failed');

      await page.getByTestId('onboarding-key').fill(GOOD_KEY);
      await page.getByTestId('onboarding-submit').click();
      const connected = page.getByTestId('onboarding-connected');
      await expect(connected).toBeVisible({ timeout: 60_000 });
      await expect(connected).toContainText('stub-b');
      await shoot(page, 'connect-custom-connected');
      expect(vendor.calls.some((c) => c.method === 'POST' && c.auth === `Bearer ${GOOD_KEY}`)).toBe(
        true,
      );
      await page.getByTestId('onboarding-submit').click();
      await expect(guide).toHaveCount(0);

      const saved = await readFile(path.join(userDataDir, 'settings.json'), 'utf8');
      expect(saved).not.toContain(GOOD_KEY);
      expect(saved).not.toContain(WRONG_KEY);
      expect((JSON.parse(saved) as { onboarding?: unknown }).onboarding).toEqual({
        completed: true,
      });

      const ws = await makeWorkspace(workspaces, 'onboarding 引导', { 'note.txt': 'hi' });
      await openFolder(page, app, ws);
      await expect(page.getByTestId('home-model')).toBeVisible();
      await startSession(page, 'Say OK', 'unused');
      await expect(page.getByTestId('agent-message').filter({ hasText: 'OK' })).toBeVisible({
        timeout: 60_000,
      });
    } finally {
      await vendor.close();
    }
  },
);

firstRun.describe('sign in', () => {
  firstRun.use({ appEnv: { PIARC_TEST_OAUTH_PROVIDER: PROVIDER_FILE } });
  firstRun('a sign-in from the guide finishes it', async ({ page, app, mock }) => {
    test.setTimeout(120_000);
    const auth = await startAuth();
    try {
      await writeProvider(auth, mock.baseUrl, 'authorizationCode');
      await browserDouble(app);
      await prefer(page, { key: 'language', value: 'en' });
      await page.getByTestId('onboarding-start').click();
      await page.getByTestId('onboarding-tile-login').click();
      await page.getByTestId(`onboarding-login-${PROVIDER}`).click();
      await page.getByTestId('login-open-browser').click();
      await expect(page.getByTestId('login-outcome')).toHaveAttribute('data-state', 'succeeded', {
        timeout: 60_000,
      });
      await page.getByTestId('login-close').click();
      await expect(page.getByTestId('onboarding-connected')).toBeVisible();
      await shoot(page, 'connect-signed-in');
      await page.getByTestId('onboarding-submit').click();
      await expect(page.getByTestId('onboarding')).toHaveCount(0);
    } finally {
      auth.stop();
    }
  });
});

test.describe('opened again', () => {
  test.use({ seedMockModel: false });
  test('Settings and the new session page open "Connect a model"; Back and Escape close it', async ({
    page,
    app,
    workspaces,
  }) => {
    test.setTimeout(90_000);
    await prefer(page, { key: 'language', value: 'en' });
    // A user who finished the guide does not see it again by itself.
    await expect(page.getByTestId('home')).toBeVisible();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);

    const settings = await openSettings(page);
    await settings.getByTestId('settings-nav-providers').click();
    await settings.getByTestId('provider-quick-setup').click();
    await expect(page.getByTestId('settings-window')).toHaveCount(0);
    const guide = page.getByTestId('onboarding');
    await expect(guide).toHaveAttribute('data-step', 'connect');
    await expect(page.getByTestId('onboarding-back')).toHaveText('Close');
    await page.getByTestId('onboarding-back').click();
    await expect(guide).toHaveCount(0);

    const ws = await makeWorkspace(workspaces, 'onboarding again', { 'a.txt': 'a' });
    await openFolder(page, app, ws);
    // No model anywhere: the model button connects one.
    const connect = page.getByTestId('home-connect-model');
    await expect(connect).toBeVisible({ timeout: 30_000 });
    await connect.click();
    await expect(guide).toHaveAttribute('data-step', 'connect');
    await page.keyboard.press('Escape');
    await expect(guide).toHaveCount(0);
    await expect(connect).toBeFocused();
    await closeSettingsIfOpen(page);
  });
});

async function closeSettingsIfOpen(page: Page): Promise<void> {
  if ((await page.getByTestId('settings-window').count()) > 0) await closeSettings(page);
}
