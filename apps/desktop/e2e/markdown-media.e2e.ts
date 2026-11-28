// Full-window image and diagram inspection in the real workbench and detached Files window.
import type { BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './sessions.js';
import { openSession, idle } from './t19.js';

const files = {
  'atlas.md':
    '# Illustrated notes\n\n![Survey map](assets/map.svg)\n\n## Diagram\n\n```mermaid\nflowchart LR\n  Read --> Review\n  Review --> Save\n```\n\nEnd.\n',
  'assets/map.svg':
    '<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1000" viewBox="0 0 1800 1000"><rect width="1800" height="1000" fill="#deeaf3"/><circle cx="900" cy="500" r="168" fill="#385f72"/><path d="M0 1000 540 320 1040 790 1510 270 1800 700" fill="none" stroke="#92ad81" stroke-width="40"/></svg>',
};
async function openDocument(page: Page) {
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'atlas.md', exact: true }).click();
}
test('local image fits the owning window, zooms at the pointer, pans and rotates with keyboard and mouse', async ({
  app,
  page,
  workspaces,
}, info) => {
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'Media canvas',
    't18-chat',
    'Inspect the illustrated notes',
    files,
  );
  await idle(page);
  const win = await app.browserWindow(page);
  await win.evaluate((w: BrowserWindow) => {
    w.setContentSize(1360, 840);
  });
  await openDocument(page);
  const image = page.getByTestId('markdown-reader').getByRole('img', { name: 'Survey map' });
  const trigger = image.locator('..');
  await image.click();
  const dialog = page.getByTestId('markdown-image-dialog'),
    canvas = dialog.getByTestId('media-canvas'),
    stage = dialog.getByTestId('media-stage');
  await expect(dialog).toBeVisible();
  await expect(canvas).toBeFocused();
  await expect
    .poll(() => stage.evaluate((el) => Number((el as HTMLElement).dataset.zoom)))
    .toBeLessThan(1);
  expect((await dialog.boundingBox())?.width).toBe(await page.evaluate(() => innerWidth));
  await canvas.press('1');
  await expect(stage).toHaveAttribute('data-zoom', '1');
  const center = await canvas.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width * 0.58, y: r.y + r.height * 0.55 };
  });
  const relative = () =>
    stage.evaluate((element, c) => {
      const s = Number((element as HTMLElement).dataset.zoom),
        r = element.getBoundingClientRect();
      return [(c.x - r.x) / s, (c.y - r.y) / s];
    }, center);
  const old = await relative();
  await page.mouse.move(center.x, center.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -160);
  await page.keyboard.up('Control');
  await expect
    .poll(() => stage.evaluate((el) => Number((el as HTMLElement).dataset.zoom)))
    .toBeGreaterThan(1);
  const anchored = await relative();
  expect(anchored[0]).toBeCloseTo(old[0] ?? 0, 0);
  expect(anchored[1]).toBeCloseTo(old[1] ?? 0, 0);
  const left = (await stage.boundingBox())?.x ?? 0;
  await page.mouse.down();
  await page.mouse.move(center.x + 44, center.y + 32, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await stage.boundingBox())?.x ?? 0).toBeGreaterThan(left + 35);
  await canvas.press('w');
  await expect(stage).toHaveAttribute('data-fit', 'width');
  await canvas.press('r');
  await expect(stage).toHaveAttribute('data-turns', '1');
  await canvas.press('Home');
  await expect(stage).toHaveAttribute('data-turns', '0');
  await expect(stage).toHaveAttribute('data-fit', 'window');
  await page.mouse.dblclick(center.x, center.y);
  await expect(stage).toHaveAttribute('data-zoom', '1');
  await page.screenshot({ path: info.outputPath('image-canvas.png') });
  await canvas.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await readFile(path.join(ws, 'atlas.md'), 'utf8')).toBe(files['atlas.md']);
});

test('Mermaid opens the passive drawing from reading, live and split panes and returns focus inside the detached window', async ({
  app,
  page,
  workspaces,
}, info) => {
  await openSession(
    app,
    page,
    workspaces,
    'Document media',
    't18-chat',
    'Inspect the diagram',
    files,
  );
  await idle(page);
  await openDocument(page);
  const button = (p: Page) => p.locator('.markdown-diagram-open:visible').last();
  for (const mode of ['preview', 'edit', 'split']) {
    await page.getByTestId('md-mode-' + mode).check();
    const trigger = button(page);
    await expect(trigger).toBeVisible();
    await trigger.click();
    const dialog = page.getByTestId('markdown-image-dialog');
    await expect(dialog.locator('img')).toHaveAttribute('src', /^data:image\/svg\+xml/u);
    await expect(dialog.getByTestId('media-stage')).toHaveAttribute('data-kind', 'diagram');
    await dialog.getByRole('button', { name: 'Fit to width', exact: true }).click();
    await expect(dialog.getByTestId('media-stage')).toHaveAttribute('data-fit', 'width');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(trigger).toBeFocused();
  }
  const opened = app.waitForEvent('window');
  await page.getByTestId('tile-popout-files').click();
  const child = await opened;
  const trigger = button(child);
  await trigger.click();
  const dialog = child.getByTestId('markdown-image-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('markdown-image-dialog')).toHaveCount(0);
  const zoom = dialog.getByTestId('media-zoom');
  await zoom.selectOption('4');
  await expect(dialog.getByTestId('media-stage')).toHaveAttribute('data-zoom', '4');
  await child.screenshot({ path: info.outputPath('detached-diagram.png') });
  await child.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await child.getByTestId('tile-popout-files').click();
});

test('a Markdown context menu inspects a local image and a diagram from source without changing the document', async ({
  app,
  page,
  workspaces,
}) => {
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'Media at cursor',
    't18-chat',
    'Inspect from source',
    files,
  );
  await idle(page);
  await openDocument(page);
  const reader = page.getByTestId('markdown-reader');
  await reader.getByRole('img', { name: 'Survey map' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'View image', exact: true }).click();
  const dialog = page.getByTestId('markdown-image-dialog');
  await expect(dialog.getByTestId('media-stage')).toHaveAttribute('data-kind', 'image');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByTestId('md-mode-source').check();
  const editor = page.getByTestId('markdown-editor-input');
  await editor
    .locator('.cm-line')
    .filter({ hasText: 'Read --> Review' })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'View diagram', exact: true }).click();
  await expect(dialog.getByTestId('media-stage')).toHaveAttribute('data-kind', 'diagram');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(editor).toBeFocused();
  await editor.locator('.cm-line').filter({ hasText: '![Survey map]' }).click();
  await editor.press('Home');
  await editor.press('ArrowRight');
  await editor.press('ArrowRight');
  await editor.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'View image', exact: true }).click();
  await expect(dialog.getByTestId('media-stage')).toHaveAttribute('data-kind', 'image');
  await page.keyboard.press('Escape');
  expect(await readFile(path.join(ws, 'atlas.md'), 'utf8')).toBe(files['atlas.md']);
});
