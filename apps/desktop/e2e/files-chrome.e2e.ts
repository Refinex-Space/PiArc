// Measure the chrome as painted in the owning Electron window. The tree still exposes
// the entire virtual row as a pointer target, including its transparent vertical inset.
import type { BrowserWindow } from 'electron';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './sessions.js';
import { idle, openSession, prefer } from './t19.js';

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Expected a visible surface');
  return box;
}

test('the docked file title aligns with the workbench, row highlights are separated, and the filter has one focus ring', async ({
  app,
  page,
  workspaces,
}) => {
  const win = await app.browserWindow(page);
  await win.evaluate((owner: BrowserWindow) => {
    owner.setContentSize(1500, 850);
  });
  await openSession(app, page, workspaces, 'File chrome', 't18-chat', 'Browse the project', {
    'alpha.txt': 'Hello',
    'beta.txt': 'World',
  });
  await idle(page);
  const trigger = page.getByTestId('tool-files');
  await trigger.click();
  const heading = page.getByTestId('tile-header-files');
  const search = heading.getByRole('button', { name: 'Go to file or search' });
  const filter = page.getByRole('textbox', { name: 'Filter files' });
  const row = (name: string) => page.getByRole('treeitem', { name, exact: true });
  await row('alpha.txt').click();
  for (const density of ['comfortable', 'compact'] as const) {
    await prefer(page, { key: 'appearance.density', value: density });
    await expect(page.locator('html')).toHaveAttribute('data-density', density);
    const [primary, file] = await Promise.all([bounds(trigger), bounds(search)]);
    expect
      .soft(
        Math.abs(primary.y + primary.height / 2 - file.y - file.height / 2),
        density + ' header baseline',
      )
      .toBeLessThanOrEqual(0.5);
    await expect.soft(heading).toHaveCSS('border-bottom-width', '0px', { timeout: 300 });
    await row('beta.txt').hover();
    const paint = await page.getByRole('tree').evaluate((tree) => {
      const rows = [...tree.querySelectorAll('[role=treeitem]')].slice(0, 2);
      const edges = rows.map((row) => {
        const box = row.getBoundingClientRect(),
          css = getComputedStyle(row);
        const clipped = css.backgroundClip === 'padding-box';
        return {
          top: box.top + (clipped ? parseFloat(css.borderTopWidth) : 0),
          bottom: box.bottom - (clipped ? parseFloat(css.borderBottomWidth) : 0),
          height: box.height,
          color: css.backgroundColor,
        };
      });
      const [a, b] = edges;
      if (!a || !b) throw new Error('Missing adjacent file rows');
      return {
        gap: b.top - a.bottom,
        heights: edges.map((x) => x.height),
        colors: edges.map((x) => x.color),
      };
    });
    expect.soft(paint.gap, density + ' visible highlight spacing').toBeGreaterThanOrEqual(2);
    expect(Math.min(...paint.heights)).toBeGreaterThanOrEqual(24);
    expect(paint.colors).not.toContain('rgba(0, 0, 0, 0)');
  }
  await search.click();
  await expect(filter).toBeFocused();
  await expect.soft(filter).toHaveCSS('outline-style', 'none', { timeout: 300 });
  await expect(filter.locator('..')).toHaveCSS('outline-style', 'solid');
  await search.focus();
  await search.press('Enter');
  await expect(filter).toBeFocused();
  await expect.soft(filter).toHaveCSS('outline-style', 'none', { timeout: 300 });
  await expect(filter.locator('..')).toHaveCSS('outline-style', 'solid');
});

async function checkSubmenu(page: Page, row: Locator, direction: 'right' | 'left') {
  await row.click({ button: 'right' });
  const parent = page.getByTestId('file-actions-menu');
  const trigger = parent.getByRole('menuitem', { name: 'Copy', exact: true });
  await trigger.hover();
  const child = page.getByRole('menu', { name: 'Copy', exact: true });
  const [outer, nested, item] = await Promise.all([bounds(parent), bounds(child), bounds(trigger)]);
  const spacing =
    direction === 'right' ? nested.x - outer.x - outer.width : outer.x - nested.x - nested.width;
  expect.soft(spacing, direction + ' submenu gap').toBeCloseTo(4, 0);
  const y = Math.max(nested.y, item.y) + Math.min(item.height / 2, 12);
  await page.mouse.move(direction === 'right' ? outer.x + outer.width + 2 : outer.x - 2, y);
  await expect(child).toBeVisible();
  await child.getByRole('menuitem', { name: 'Relative path', exact: true }).hover();
  await expect(child).toBeVisible();
  await child.press('ArrowLeft');
  await expect(child).toHaveCount(0);
  await expect(parent).toBeFocused();
  await parent.press('ArrowRight');
  await expect(page.getByRole('menu', { name: 'Copy', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await parent.press('Escape');
  await expect(parent).toHaveCount(0);
}

test('cascading file menus respect the outer menu and the margins of both workbench and native tool window', async ({
  app,
  page,
  workspaces,
}) => {
  await openSession(app, page, workspaces, 'File menus', 't18-chat', 'Browse the project', {
    'notes.txt': 'Notes',
  });
  await idle(page);
  await page.getByTestId('tool-files').click();
  const row = page.getByRole('treeitem', { name: 'notes.txt', exact: true });
  await checkSubmenu(page, row, 'right');
  const popupReady = app.waitForEvent('window');
  await page.getByTestId('tile-popout-files').click();
  const popup = await popupReady;
  const native = await app.browserWindow(popup);
  await native.evaluate((owner: BrowserWindow) => {
    owner.setContentSize(560, 360);
  });
  const settings = popup.getByRole('button', { name: 'Files settings' });
  await settings.click();
  const menu = popup.getByRole('menu', { name: 'Files settings', exact: true });
  const box = await bounds(menu);
  const viewport = await popup.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect
    .soft(viewport.width - box.x - box.width, 'right viewport margin')
    .toBeGreaterThanOrEqual(8);
  expect.soft(box.y, 'top viewport margin').toBeGreaterThanOrEqual(8);
  expect
    .soft(viewport.height - box.y - box.height, 'bottom viewport margin')
    .toBeGreaterThanOrEqual(8);
  const size = menu.getByRole('menuitem', { name: 'Tab size' });
  await size.hover();
  const submenu = popup.getByRole('menu', { name: 'Tab size', exact: true });
  const child = await bounds(submenu);
  expect.soft(box.x - child.x - child.width, 'flipped menu gap').toBeCloseTo(4, 0);
  await submenu.press('Escape');
  await menu.press('Escape');
  // Both sides of a centred trigger can be narrower than the menu minimum. A click
  // then shows one list with a Back choice, while arrow keys still traverse a single tree.
  await native.evaluate((owner: BrowserWindow) => {
    owner.setContentSize(320, 260);
  });
  const narrowRow = popup.getByRole('treeitem', { name: 'notes.txt', exact: true });
  const rowBox = await bounds(narrowRow);
  await narrowRow.click({ button: 'right', position: { x: 100 - rowBox.x, y: rowBox.height / 2 } });
  const narrowParent = popup.getByTestId('file-actions-menu');
  const original = await bounds(narrowParent);
  await narrowParent.getByRole('menuitem', { name: 'Copy', exact: true }).click();
  const drill = popup.getByRole('menu', { name: 'Copy', exact: true });
  await expect(narrowParent).toBeHidden();
  await expect(drill).toBeVisible();
  expect((await bounds(drill)).x).toBeCloseTo(original.x, 0);
  await drill.getByRole('menuitem', { name: 'Back', exact: true }).click();
  await expect(narrowParent).toBeFocused();
  await narrowParent.press('ArrowRight');
  await expect(drill).toBeFocused();
  await drill.press('Escape');
  await narrowParent.press('Escape');
  // Put the actual context click inside the window gutter. The clipping will also be
  // exercised from the top edge of a file tab and the bottom-right of the viewer.
  await narrowRow.click({ button: 'right', position: { x: 1, y: rowBox.height / 2 } });
  expect((await bounds(narrowParent)).x).toBeCloseTo(8, 0);
  await narrowParent.press('Escape');
  await narrowRow.click();
  const tab = popup.getByRole('tab', { name: 'notes.txt' });
  await tab.click({ button: 'right', position: { x: 8, y: 1 } });
  expect((await bounds(narrowParent)).y).toBeCloseTo(8, 0);
  await narrowParent.press('Escape');
  const reader = popup.getByTestId('file-viewer');
  const readerBox = await bounds(reader);
  await reader.click({
    button: 'right',
    position: { x: readerBox.width - 18, y: readerBox.height - 16 },
  });
  const end = await bounds(narrowParent);
  const narrowViewport = await popup.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(narrowViewport.width - end.x - end.width).toBeCloseTo(8, 0);
  expect(narrowViewport.height - end.y - end.height).toBeCloseTo(8, 0);
  await narrowParent.press('Escape');
  await popup.getByTestId('tile-popout-files').click();
  await expect(row).toBeVisible();
});
