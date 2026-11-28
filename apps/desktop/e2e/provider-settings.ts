import { openSettings } from './settings-panel.js';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect } from './sessions.js';
import { prefer } from './t19.js';

export async function settingsWindow(main: Page) {
  await prefer(main, { key: 'language', value: 'en' });
  const settings = await openSettings(main);
  await settings.getByTestId('settings-nav-providers').click();
  await settings.getByTestId('catalog-refresh').uncheck();
  return settings;
}

export async function addEndpoint(
  settings: Page,
  id: string,
  url: string,
  api: string,
  models: string,
) {
  await settings.getByTestId('provider-add').click();
  await settings.getByTestId('provider-choice-custom').click();
  await settings.getByTestId('provider-id').fill(id);
  await settings.getByTestId('provider-url').fill(url);
  await settings.getByTestId('provider-api').selectOption(api);
  await settings.getByTestId('provider-models').fill(models);
  await settings.getByTestId('provider-key').fill(randomUUID());
  await settings.getByTestId('provider-save').click();
  await expect(settings.getByTestId(`provider-row-${id}`)).toBeVisible();
}
