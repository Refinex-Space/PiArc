// B3.4 of the built-in browser (design addendum section 3.3): the screenshot menu takes the
// visible area, the full page, a region the user drags on the frozen page, or one element picked
// with a real click; each result can be copied (the main process writes the PNG to the
// clipboard), saved through the native save dialog, or added to the conversation.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './sessions.js';
import { acceptImages, clickInPage, openPage, serve } from './browser-b3.js';
import { idle, openSession } from './t19.js';
import { withSavedClipboard } from './transcript.js';

test.beforeEach(async ({ userDataDir }) => {
  await acceptImages(userDataDir);
});

const PAGE = {
  '/': {
    type: 'text/html; charset=utf-8',
    body: '<!doctype html><title>Long page</title><main><button id="target" style="margin:40px;width:120px;height:40px">Buy</button><div style="height:3000px"></div><footer>End</footer></main>',
  },
};

async function shotMenu(
  page: Page,
  item: 'visible' | 'full' | 'region' | 'element',
): Promise<void> {
  await page.getByTestId('browser-screenshot').click();
  await expect(page.getByTestId('browser-shot-menu')).toBeVisible();
  await page.getByTestId(`browser-shot-${item}`).click();
}

/** The natural size of the screenshot result's thumbnail. */
async function shotSize(page: Page): Promise<{ width: number; height: number }> {
  return page
    .getByTestId('browser-shot')
    .locator('img')
    .evaluate((image: HTMLImageElement) => ({
      width: image.naturalWidth,
      height: image.naturalHeight,
    }));
}

/** Whether the element is on screen where it is drawn: not clipped or covered by anything else. */
async function reachable(page: Page, testId: string): Promise<boolean> {
  return page.getByTestId(testId).evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit !== null && element.contains(hit);
  });
}

test('visible, full page, region and element screenshots; copy, save and add', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(180_000);
  await openSession(app, page, workspaces, 'screenshot 截图', 't18-chat', 'Hello');
  await idle(page);
  const server = await serve(PAGE);
  try {
    await openPage(page, server.origin, 'Long page');
    const viewport = await page.getByTestId('browser-viewport').boundingBox();
    if (viewport === null) throw new Error('No viewport');

    // Visible area: the viewport's size (times the device pixel ratio).
    await shotMenu(page, 'visible');
    await expect(page.getByTestId('browser-shot')).toHaveAttribute('data-kind', 'visible');
    const visible = await shotSize(page);
    expect(visible.width).toBeGreaterThanOrEqual(Math.floor(viewport.width));
    // Copy puts an image on the clipboard.
    await withSavedClipboard(app, async () => {
      await page.getByTestId('browser-shot-copy').click();
      await expect
        .poll(() =>
          app.evaluate(async ({ clipboard }) =>
            (await clipboard.read()).some((item) => item.types.includes('image/png')),
          ),
        )
        .toBe(true);
    });
    // Save… writes the PNG where the native dialog says.
    const target = path.join(workspaces, 'shot 截图.png');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: file });
    }, target);
    await page.getByTestId('browser-shot-save').click();
    await expect
      .poll(async () =>
        (await readFile(target).catch(() => Buffer.alloc(0))).subarray(1, 4).toString(),
      )
      .toBe('PNG');

    // Full page: taller than the viewport.
    await shotMenu(page, 'full');
    await expect(page.getByTestId('browser-shot')).toHaveAttribute('data-kind', 'full');
    expect((await shotSize(page)).height).toBeGreaterThan(visible.height);
    // The result shows all of itself: nothing clipped (the transcript's screenshot card once lent
    // it a 160 × 120 box), and × where it is drawn closes it.
    const bar = page.getByTestId('browser-shot');
    expect(
      await bar.evaluate(
        (element) =>
          element.scrollHeight <= element.clientHeight + 1 &&
          element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    for (const id of [
      'browser-shot-copy',
      'browser-shot-save',
      'browser-shot-add',
      'browser-shot-close',
    ]) {
      expect(await reachable(page, id), id).toBe(true);
    }
    await page.screenshot({ path: info.outputPath('screenshot-full.png') });
    const close = await page.getByTestId('browser-shot-close').boundingBox();
    if (close === null) throw new Error('No close button');
    await page.mouse.click(close.x + close.width / 2, close.y + close.height / 2);
    await expect(bar).toHaveCount(0);

    // Region: drag on the frozen page.
    await shotMenu(page, 'region');
    const surface = page.getByTestId('browser-annotate');
    await expect(surface).toHaveAttribute('data-mode', 'region');
    const canvas = await page.getByTestId('browser-annotate-canvas').boundingBox();
    if (canvas === null) throw new Error('No canvas');
    await page.mouse.move(canvas.x + 10, canvas.y + 10);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 110, canvas.y + 60);
    await page.mouse.move(canvas.x + 210, canvas.y + 110);
    await page.mouse.up();
    // The region stays outlined on the frozen page with its card beside it.
    const regionCard = page.getByTestId('browser-region-card');
    await expect(regionCard).toBeVisible();
    await expect(page.getByTestId('browser-region-comment')).toBeFocused();
    const placed = await regionCard.boundingBox();
    if (placed === null) throw new Error('No region card');
    expect(
      placed.y >= canvas.y + 110 - 1 ||
        placed.x >= canvas.x + 210 - 1 ||
        placed.y + placed.height <= canvas.y + 10 + 1,
    ).toBe(true);
    await page.screenshot({ path: info.outputPath('screenshot-region.png') });
    // Copy: the region's pixels.
    const scale = visible.width / canvas.width;
    await withSavedClipboard(app, async () => {
      await regionCard.getByTestId('browser-shot-copy').click();
      // The PNG on the clipboard: its size from the header.
      const size = () =>
        app.evaluate(async ({ clipboard }) => {
          const item = (await clipboard.read()).find((each) => each.types.includes('image/png'));
          if (item === undefined) return { width: 0, height: 0 };
          const view = new DataView(await (await item.getType('image/png')).arrayBuffer());
          return { width: view.getUint32(16), height: view.getUint32(20) };
        });
      await expect.poll(async () => (await size()).width).toBeGreaterThan(0);
      const region = await size();
      expect(Math.abs(region.width - 200 * scale)).toBeLessThanOrEqual(2 * scale + 1);
      expect(Math.abs(region.height - 100 * scale)).toBeLessThanOrEqual(2 * scale + 1);
    });
    // Esc leaves; nothing went to the conversation.
    await page.keyboard.press('Escape');
    await expect(surface).toHaveCount(0);

    // Element: one real click picks it; the image is the element with its margin.
    await shotMenu(page, 'element');
    await clickInPage(app, server.origin, '#target');
    await expect(page.getByTestId('browser-shot')).toHaveAttribute('data-kind', 'element');
    const element = await shotSize(page);
    expect(element.width).toBeGreaterThan(0);
    expect(element.width).toBeLessThan(visible.width);
    // The picker ended after the one element.
    await expect(page.getByTestId('browser-pick-toggle')).toHaveAttribute('aria-pressed', 'false');
    await page.screenshot({ path: info.outputPath('screenshot-element.png') });

    // Add to the conversation: one image and the page's context attachment.
    await page.getByTestId('browser-shot-add').click();
    await expect(page.getByTestId('browser-shot')).toHaveCount(0);
    await expect(page.getByTestId('pending-attachment')).toHaveCount(1);
    await expect(page.getByTestId('pending-browser-context')).toHaveCount(1);
    await expect(page.getByTestId('composer-input')).toBeFocused();

    // A region with a comment: Enter in its card adds both.
    // Adding moved the focus to the conversation; the preview may still be on screen.
    if (!(await page.getByTestId('browser-screenshot').isVisible())) {
      await page.getByTestId('tool-preview').click();
    }
    await shotMenu(page, 'region');
    await expect(surface).toHaveAttribute('data-mode', 'region');
    await page.mouse.move(canvas.x + 20, canvas.y + 20);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 120, canvas.y + 80);
    await page.mouse.up();
    await expect(page.getByTestId('browser-region-comment')).toBeFocused();
    await page.keyboard.type('Too much space here');
    await page.keyboard.press('Enter');
    await expect(surface).toHaveCount(0);
    await expect(page.getByTestId('pending-attachment')).toHaveCount(2);
    await expect(page.getByTestId('pending-browser-context').last()).toContainText('1');
  } finally {
    await server.close();
  }
});
