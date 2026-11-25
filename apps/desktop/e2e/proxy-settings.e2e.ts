// ADR-0082: the proxy page. It shows the system's proxy as Electron resolves it (none on a test
// machine without one), refuses an address Core would refuse before saving, saves a manual
// address into the user's settings and goes back to detecting.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from './fixtures.js';
import { closeSettings, openSettings } from './settings-panel.js';

async function proxySetting(userDataDir: string): Promise<unknown> {
  const text = await readFile(path.join(userDataDir, 'settings.json'), 'utf8').catch(() => '{}');
  return (JSON.parse(text) as { proxy?: unknown }).proxy;
}

test('the proxy page detects, refuses a bad address, saves a manual one and goes back', async ({
  page,
  userDataDir,
}, testInfo) => {
  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-proxy').click();
  const panel = settings.getByTestId('proxy-settings');
  await expect(panel).toBeVisible();
  // Auto by default: the detected proxy (or none) shows once resolved.
  await expect(panel.getByTestId('proxy-mode-auto')).toBeChecked();
  await expect(panel.getByTestId('proxy-system')).not.toHaveText(/Detecting|正在检测/u);
  const systemLabel = panel.locator('.proxy-system-label');
  const detect = panel.getByTestId('proxy-detect');
  const labelBox = await systemLabel.boundingBox();
  const detectBox = await detect.boundingBox();
  if (labelBox === null || detectBox === null) throw new Error('proxy row is not visible');
  expect(
    Math.abs(labelBox.y + labelBox.height / 2 - (detectBox.y + detectBox.height / 2)),
  ).toBeLessThan(2);
  await panel.locator('.proxy-info').hover();
  const tip = page.locator('.tooltip[data-placed="true"]');
  await expect(tip).toContainText(/connect directly|直接连接/u);
  await page.mouse.move(0, 0);
  await expect(tip).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('proxy-auto.png') });

  await panel.getByText(/Set manually|手动设置/u).click();
  const address = panel.getByTestId('proxy-url');
  await address.fill('http://user:secret@127.0.0.1:7897');
  await panel.getByTestId('proxy-save').click();
  await expect(panel.getByTestId('proxy-error')).toContainText(
    /user name or password|用户名或密码/u,
  );
  expect(await proxySetting(userDataDir)).toBeUndefined();

  await address.fill('http://127.0.0.1:7897');
  await panel.getByTestId('proxy-save').click();
  await expect(panel.getByTestId('proxy-save')).toHaveText(/Saved|已保存/u);
  await expect
    .poll(() => proxySetting(userDataDir))
    .toEqual({ mode: 'manual', url: 'http://127.0.0.1:7897' });
  await page.screenshot({ path: testInfo.outputPath('proxy-manual.png') });

  await panel.getByText(/Detect automatically|自动检测/u).click();
  await expect
    .poll(() => proxySetting(userDataDir))
    .toEqual({ mode: 'auto', url: 'http://127.0.0.1:7897' });
  await expect(panel.getByTestId('proxy-system')).toBeVisible();
  await closeSettings(settings);
});
