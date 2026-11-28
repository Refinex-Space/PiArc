// ADR-0111: the About page and in-app updates against a signed release on a local mock of
// GitHub's downloads. "Check for Updates…" in the app menu opens the page and checks; the
// newer release shows with its notes, downloads with progress, verifies and is ready; the
// sidebar shows the quiet notice; a source-tree run explains that it installs by hand; the
// automatic check is a user setting; an unreachable feed names the reason.
// Screenshots go to tmp/evidence/<task>/ with PIARC_EVIDENCE_TASK set (e.g. `about`).
//
// The dev form only: the packaged form would really replace its bundle and quit.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test as base } from './fixtures.js';
import { closeSettings } from './settings-panel.js';
import { startMockReleases, updateEnv, type MockReleases } from './updates.js';

const test = base.extend<{ releases: MockReleases }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here.
  releases: async ({}, use) => {
    const releases = await startMockReleases('1.1.0');
    await use(releases);
    await releases.stop();
  },
  appEnv: async ({ releases }, use) => {
    await use(await updateEnv(releases.releases));
  },
});

async function autoCheckSetting(userDataDir: string): Promise<unknown> {
  const text = await readFile(path.join(userDataDir, 'settings.json'), 'utf8').catch(() => '{}');
  return (JSON.parse(text) as { updates?: { autoCheck?: unknown } }).updates?.autoCheck;
}

test('About finds, downloads and verifies a newer release through the menu', async ({
  app,
  page,
  appForm,
  releases,
  userDataDir,
}, testInfo) => {
  test.skip(appForm !== 'dev', 'the packaged form would replace its own bundle');
  // The app menu's "Check for Updates…" opens About and starts a check.
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('app.checkUpdates')?.click();
  });
  const about = page.getByTestId('about-page');
  await expect(about).toBeVisible();
  await expect(about.getByTestId('about-version')).toContainText(/Version 0\.0\.0|版本 0\.0\.0/u);
  const status = about.getByTestId('about-update');
  await expect(status).toContainText(/PiArc 1\.1\.0 (is available|可用)/u);
  await expect(about.getByTestId('about-notes')).toContainText(/In-app updates|应用内更新/u);
  const versions = about.getByTestId('about-versions');
  await expect(versions).toContainText('Electron');
  await expect(versions).toContainText('libghostty-vt');
  await page.screenshot({ path: testInfo.outputPath('about-available.png') });

  // Download slowly enough to see the progress, then it verifies and is ready.
  await releases.control('slow 16000');
  await about.getByTestId('about-download').click();
  await expect(about.getByTestId('about-progress')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('about-downloading.png') });
  await expect(status).toContainText(/ready to install|已可安装/u, { timeout: 30_000 });
  await expect(about.getByTestId('about-install')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('about-ready.png') });
  // Only this platform's files were fetched, through the latest link and the asset host.
  const requests = await releases.requests();
  expect(requests).toContain('/releases/latest/download/piarc-release-manifest.json');
  expect(requests.filter((r) => r.startsWith('/assets/1.1.0/')).length).toBeGreaterThan(1);

  // A source-tree run cannot replace itself: it says so and offers the release page.
  await about.getByTestId('about-install').click();
  await expect(about.getByTestId('about-manual')).toContainText(
    /cannot install updates itself|无法自行安装更新/u,
  );

  // The automatic check is the user's setting.
  // A controlled switch: it flips once the preference is saved.
  const autoCheck = about.getByTestId('about-auto-check');
  await autoCheck.click();
  await expect.poll(() => autoCheckSetting(userDataDir)).toBe(false);
  await expect(autoCheck).not.toBeChecked();
  await autoCheck.click();
  await expect.poll(() => autoCheckSetting(userDataDir)).toBe(true);
  await expect(autoCheck).toBeChecked();

  // Outside settings, the sidebar's quiet notice offers the restart.
  await closeSettings(page);
  const notice = page.getByTestId('sidebar-update');
  await expect(notice).toContainText(/Restart to update to 1\.1\.0|重启以更新到 1\.1\.0/u);
  await page.screenshot({ path: testInfo.outputPath('sidebar-ready.png') });
});

test.describe('an unreachable feed', () => {
  test.use({
    // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here.
    appEnv: async ({}, use) => {
      await use(await updateEnv('https://localhost:9/releases'));
    },
  });

  test('names the reason and offers to check again', async ({ page, appForm }, testInfo) => {
    test.skip(appForm !== 'dev', 'one form is enough for the page');
    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-about').click();
    const about = page.getByTestId('about-page');
    await about.getByTestId('about-check').click();
    await expect(about.getByTestId('about-update')).toContainText(
      /Could not check for updates|无法检查更新/u,
    );
    await expect(about.getByTestId('about-problem')).toContainText(
      /could not be reached|连不上发布服务器/u,
    );
    await page.screenshot({ path: testInfo.outputPath('about-failed.png') });
  });
});
