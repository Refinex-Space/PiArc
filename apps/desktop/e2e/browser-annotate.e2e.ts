// B3.3 and B3.5 of the built-in browser (design addendum section 3.3): Mod+Shift+X freezes the
// page (its view is hidden and its screenshot shows on `#browser-annotate`), the user draws with
// every tool, color and width, undoes, redoes and clears, comments on each numbered box and
// marker, and adds the drawn image with numbered items to the input; leaving with drawings asks
// first. The sent message numbers the items as the image does.
import type { Page } from '@playwright/test';

import { expect, test } from './sessions.js';
import { acceptImages, observe, openPage, serve } from './browser-b3.js';
import { idle, openSession, requests, userTexts } from './t19.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test.beforeEach(async ({ userDataDir }) => {
  await acceptImages(userDataDir);
});

const PAGE = {
  '/': {
    type: 'text/html; charset=utf-8',
    body: '<!doctype html><title>Annotate</title><main style="padding:40px"><h1>Pricing</h1><button>Buy</button></main>',
  },
};

/** Drags on the annotation canvas from `from` to `to` (fractions of its size). */
async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await page.getByTestId('browser-annotate-canvas').boundingBox();
  if (box === null) throw new Error('No canvas');
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width * ((from[0] + to[0]) / 2),
    box.y + box.height * ((from[1] + to[1]) / 2),
  );
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1]);
  await page.mouse.up();
}

async function clickCanvas(page: Page, at: [number, number]): Promise<void> {
  const box = await page.getByTestId('browser-annotate-canvas').boundingBox();
  if (box === null) throw new Error('No canvas');
  await page.mouse.click(box.x + box.width * at[0], box.y + box.height * at[1]);
}

test('annotating freezes the page, draws, numbers and goes to the input', async ({
  app,
  page,
  mock,
  workspaces,
}, info) => {
  test.setTimeout(180_000);
  const { id } = await openSession(app, page, workspaces, 'annotate 标注', 't19-chat', 'Hello');
  await idle(page);
  const server = await serve(PAGE);
  try {
    await openPage(page, server.origin, 'Annotate');
    await expect.poll(async () => (await observe(app, id)).tabs[0]?.visible).toBe(true);
    await page.getByTestId('browser-address').blur();
    await page.keyboard.press(`${MOD}+Shift+X`);
    const surface = page.getByTestId('browser-annotate');
    await expect(surface).toBeVisible();
    // Frozen: the page's view is hidden while the canvas shows its screenshot.
    await expect.poll(async () => (await observe(app, id)).tabs[0]?.visible).toBe(false);
    const canvas = page.getByTestId('browser-annotate-canvas');

    // Rectangle (1) in red, thin.
    await page.getByTestId('browser-annotate-width-2').click();
    await expect(page.getByTestId('browser-annotate-width-2')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await drag(page, [0.1, 0.1], [0.4, 0.3]);
    await expect(canvas).toHaveAttribute('data-shapes', '1');
    // Ellipse (2) in green, thick.
    await page.getByTestId('browser-annotate-tool-ellipse').click();
    await page.getByTestId('browser-annotate-color-success').click();
    await page.getByTestId('browser-annotate-width-8').click();
    await drag(page, [0.5, 0.1], [0.8, 0.3]);
    // Arrow, pen and redaction carry no number.
    await page.getByTestId('browser-annotate-tool-arrow').click();
    await page.getByTestId('browser-annotate-color-accent').click();
    await drag(page, [0.2, 0.6], [0.4, 0.5]);
    await page.getByTestId('browser-annotate-tool-pen').click();
    await page.getByTestId('browser-annotate-color-warning').click();
    await drag(page, [0.6, 0.6], [0.7, 0.7]);
    await page.getByTestId('browser-annotate-tool-redact').click();
    await drag(page, [0.8, 0.8], [0.95, 0.95]);
    // Text.
    await page.getByTestId('browser-annotate-tool-text').click();
    await page.getByTestId('browser-annotate-color-neutral').click();
    await clickCanvas(page, [0.1, 0.8]);
    await page.getByTestId('browser-annotate-text').fill('Too wide');
    await page.getByTestId('browser-annotate-text').press('Enter');
    // Marker (3).
    await page.getByTestId('browser-annotate-tool-marker').click();
    await page.getByTestId('browser-annotate-color-danger').click();
    await clickCanvas(page, [0.5, 0.5]);
    await expect(canvas).toHaveAttribute('data-shapes', '7');
    await expect(page.getByTestId('browser-annotate-comment')).toHaveCount(3);

    // Undo, redo, clear (undoable).
    await page.getByTestId('browser-annotate-undo').click();
    await expect(canvas).toHaveAttribute('data-shapes', '6');
    await page.getByTestId('browser-annotate-redo').click();
    await expect(canvas).toHaveAttribute('data-shapes', '7');
    await page.getByTestId('browser-annotate-clear').click();
    await expect(canvas).toHaveAttribute('data-shapes', '0');
    await page.getByTestId('browser-annotate-undo').focus();
    await page.keyboard.press(`${MOD}+Z`);
    await expect(canvas).toHaveAttribute('data-shapes', '7');

    // Comments per number.
    await page.getByTestId('browser-annotate-comment').nth(0).fill('Header is cramped');
    await page.getByTestId('browser-annotate-comment').nth(2).fill('Button too small');
    await page.screenshot({ path: info.outputPath('annotate.png') });

    // Esc asks before discarding; keep editing.
    await page.getByTestId('browser-annotate-comment').nth(0).focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('browser-annotate-discard')).toBeVisible();
    await page.getByRole('button', { name: /Keep editing|继续编辑/u }).click();
    await expect(page.getByTestId('browser-annotate-discard')).toHaveCount(0);
    await expect(surface).toBeVisible();

    // Add to conversation (3): one image, one context attachment, the page back.
    await page.getByTestId('browser-annotate-add').click();
    await expect(surface).toHaveCount(0);
    await expect.poll(async () => (await observe(app, id)).tabs[0]?.visible).toBe(true);
    await expect(page.getByTestId('pending-attachment')).toHaveCount(1);
    await expect(page.getByTestId('pending-browser-context')).toContainText('3');
    await expect(page.getByTestId('composer-input')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => userTexts((await requests(mock, 't19-chat')).at(-1)?.body ?? {}).join('\n'))
      .toContain('<browser-context nonce="');
    const sent = userTexts((await requests(mock, 't19-chat')).at(-1)?.body ?? {}).join('\n');
    expect(sent).toContain('[1] Header is cramped');
    expect(sent).toContain('[3] Button too small');
    expect(sent).toContain('[1] box: box at');
    expect(sent).toContain('[2] box: ellipse at');
    expect(sent).toContain('[3] marker: marker at');
  } finally {
    await server.close();
  }
});

test('leaving an annotation with drawings asks, and discarding adds nothing', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  const { id } = await openSession(
    app,
    page,
    workspaces,
    'annotate discard 丢弃',
    't18-chat',
    'Hello',
  );
  await idle(page);
  const server = await serve(PAGE);
  try {
    await openPage(page, server.origin, 'Annotate');
    await page.getByTestId('browser-annotate-toggle').click();
    await expect(page.getByTestId('browser-annotate')).toBeVisible();
    // Without drawings, cancel leaves at once.
    await page.getByTestId('browser-annotate-cancel').click();
    await expect(page.getByTestId('browser-annotate')).toHaveCount(0);
    // Mod+Shift+X with the focus in the page goes through the page's key map.
    await page.getByTestId('browser-viewport').focus();
    await page.keyboard.press('Enter');
    await app.evaluate(
      ({ webContents }, args) => {
        const contents = webContents
          .getAllWebContents()
          .find((c) => c.getURL().startsWith(args.origin));
        const modifiers: ('meta' | 'control' | 'shift')[] = [
          args.mac ? 'meta' : 'control',
          'shift',
        ];
        contents?.sendInputEvent({ type: 'keyDown', keyCode: 'X', modifiers });
        contents?.sendInputEvent({ type: 'keyUp', keyCode: 'X', modifiers });
      },
      { origin: server.origin, mac: process.platform === 'darwin' },
    );
    await expect(page.getByTestId('browser-annotate')).toBeVisible();
    await page.getByTestId('browser-annotate-tool-marker').click();
    await clickCanvas(page, [0.5, 0.5]);
    await page.getByTestId('browser-annotate-cancel').click();
    await expect(page.getByTestId('browser-annotate-discard')).toBeVisible();
    await page.getByTestId('browser-annotate-discard-confirm').click();
    await expect(page.getByTestId('browser-annotate')).toHaveCount(0);
    await expect(page.getByTestId('pending-browser-context')).toHaveCount(0);
    await expect.poll(async () => (await observe(app, id)).tabs[0]?.visible).toBe(true);
  } finally {
    await server.close();
  }
});
