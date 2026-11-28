import type { Page } from '@playwright/test';

export async function openSettings(page: Page): Promise<Page> {
  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-window').waitFor();
  return page;
}

export async function closeSettings(page: Page): Promise<void> {
  await page.getByTestId('settings-close').click();
  await page.getByTestId('settings-window').waitFor({ state: 'detached' });
}
