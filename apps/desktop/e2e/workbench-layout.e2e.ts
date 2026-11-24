// Reference geometry in CSS pixels; a populated session also exercises the two navigation stacks.
import type { BrowserWindow } from 'electron';
import { expect, makeWorkspace, openFolder, startSession, test } from './sessions.js';
import { idle, prefer } from './t19.js';

test('the composer stays on its reading axis through navigation and panel toggles', async ({
  app,
  page,
  workspaces,
}, info) => {
  const owner = await app.browserWindow(page);
  await owner.evaluate((win: BrowserWindow) => {
    win.setContentSize(1324, 820);
  });
  await prefer(page, { key: 'language', value: 'en' });
  const folder = await makeWorkspace(workspaces, 'Workbench');
  await openFolder(page, app, folder);
  await expect(page.locator('.composer-box')).toHaveCSS('width', '768px');
  await expect(page.locator('.composer-box')).toHaveCSS('height', '46px');
  await expect(page.locator('.environment-card')).toHaveCSS('width', '320px');
  await expect(page.getByTestId('panel-area-dock')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('new-session.png') });
  await startSession(page, 'Check the workspace', 't18-chat');
  await idle(page);
  const heading = page.getByTestId('conversation-title');
  await heading.click();
  const name = page.getByTestId('rename-input');
  await name.fill('Workbench review');
  await name.press('Enter');
  await expect(heading).toHaveText('Workbench review');
  await expect(heading).toBeFocused();
  await expect(page.getByTestId('session-title')).toContainText('Workbench review');
  await page.screenshot({ path: info.outputPath('session-details.png') });
  await page.getByTestId('tool-rail').click();
  await expect(page.getByTestId('panel-area-rail')).toHaveCount(0);
  await expect(page.locator('.composer-box')).toHaveCSS('width', '768px');
  await page.getByTestId('new-session').click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(heading).toHaveText('Workbench review');
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(page.getByTestId('expand-sidebar')).toBeVisible();
});
