// ADR-0104: the accent on the Appearance page. Graphite by default; a preset from the menu
// changes the accent colors app-wide and is saved; "Custom" starts from the accent in use, takes
// a hex color (an invalid one is not saved) and applies it, corrected for contrast; the high-
// contrast mode keeps the default accent.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { COLORS } from '../src/shared/design-tokens.js';
import { expect, test } from './fixtures.js';
import { closeSettings, openSettings } from './settings-panel.js';

async function appearance(userDataDir: string): Promise<Record<string, unknown>> {
  const text = await readFile(path.join(userDataDir, 'settings.json'), 'utf8').catch(() => '{}');
  return (JSON.parse(text) as { appearance?: Record<string, unknown> }).appearance ?? {};
}

function accentState(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    return {
      accent: root.dataset.accent ?? '',
      solid: style.getPropertyValue('--piarc-accent-solid').trim(),
      onAccent: style.getPropertyValue('--piarc-text-on-accent').trim(),
      running: style.getPropertyValue('--piarc-agent-status-running').trim(),
    };
  });
}

test('the accent menu applies presets and a corrected custom color', async ({
  page,
  userDataDir,
}, testInfo) => {
  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-appearance').click();
  const row = settings.getByTestId('setting-accent');
  await expect(row).toBeVisible();
  const trigger = row.getByTestId('accent-select');
  await expect(trigger).toHaveAttribute('data-accent', 'graphite');
  await expect(trigger).toContainText(/Default|默认/u);
  await settings
    .locator('label')
    .filter({ has: settings.getByTestId('theme-light') })
    .click();
  await expect.poll(async () => (await accentState(page)).accent).toBe('graphite');
  const graphite = await accentState(page);

  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveCount(8);
  await page.screenshot({ path: testInfo.outputPath('accent-menu.png') });
  await menu.getByTestId('accent-orange').click();
  await expect.poll(async () => (await accentState(page)).accent).toBe('orange');
  const orange = await accentState(page);
  expect(orange.solid).not.toBe(graphite.solid);
  // Status dots do not follow the accent.
  expect(orange.running).toBe(graphite.running);
  await expect.poll(() => appearance(userDataDir)).toMatchObject({ accent: 'orange' });

  await trigger.click();
  await page.getByRole('menu').getByTestId('accent-custom').click();
  await expect
    .poll(() => appearance(userDataDir))
    .toMatchObject({
      accent: 'custom',
      accentColor: orange.solid,
    });
  const hex = row.getByTestId('accent-color-input');
  await expect(hex).toHaveValue(orange.solid);
  await expect(row.getByTestId('accent-color-picker')).toBeAttached();

  await hex.fill('#12');
  await expect(hex).toHaveAttribute('aria-invalid', 'true');
  await hex.fill('#FFE600');
  await expect.poll(() => appearance(userDataDir)).toMatchObject({ accentColor: '#ffe600' });
  await expect.poll(async () => (await accentState(page)).accent).toBe('custom');
  const custom = await accentState(page);
  // A light yellow is moved until it reads on white, and carries black text.
  expect(custom.solid).not.toBe('#ffe600');
  expect(custom.onAccent).toBe('#000000');
  await page.screenshot({ path: testInfo.outputPath('accent-custom-light.png') });

  await settings
    .locator('label')
    .filter({ has: settings.getByTestId('theme-dark') })
    .click();
  await expect.poll(async () => (await accentState(page)).solid).not.toBe(custom.solid);
  await page.screenshot({ path: testInfo.outputPath('accent-custom-dark.png') });

  // High contrast keeps the default accent.
  await settings
    .locator('label')
    .filter({ has: settings.getByTestId('contrast-high') })
    .click();
  await expect
    .poll(async () => (await accentState(page)).solid)
    .toBe(COLORS.darkHighContrast['accent.solid']);
  await closeSettings(settings);
});
