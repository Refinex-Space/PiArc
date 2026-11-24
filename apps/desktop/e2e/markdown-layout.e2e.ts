// The document column must respond to the width of the Files pane, including narrow split views.
import { writeFile } from 'node:fs/promises';
import type { BrowserWindow } from 'electron';
import type { Locator } from '@playwright/test';
import { expect, test } from './sessions.js';
import { openSession, idle, prefer } from './t19.js';

async function paragraphInsets(element: Locator) {
  return element.evaluate((el) => {
    const viewport = el.closest('.markdown-reader,.cm-scroller');
    if (!viewport) throw Error('Missing document viewport');
    const outer = viewport.getBoundingClientRect(),
      inner = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return [
      inner.left - outer.left + parseFloat(style.paddingLeft),
      outer.left + viewport.clientWidth - inner.right + parseFloat(style.paddingRight),
    ];
  });
}

test('Markdown uses the available pane width with a single transparent command row and fine-line controls', async ({
  page,
  app,
  workspaces,
}, info) => {
  const win = await app.browserWindow(page);
  await win.evaluate((w: BrowserWindow) => {
    w.setContentSize(1600, 850);
  });
  await openSession(app, page, workspaces, 'Document layout', 't18-chat', 'Read the note', {
    'layout.md':
      '# Document layout\n\nA paragraph in the workspace.\n\n| Name | State |\n| --- | --- |\n| Example | Ready |\n',
  });
  await idle(page);
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'layout.md' }).click();
  const viewer = page.getByTestId('file-viewer'),
    row = viewer.locator('.file-viewer-toolbar'),
    modes = row.getByRole('radiogroup');
  await expect.soft(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect.soft(modes).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect.soft(row.locator('svg')).toHaveCount(6);
  const strokes = await row
    .locator('svg')
    .evaluateAll((icons) => icons.map((icon) => parseFloat(getComputedStyle(icon).strokeWidth)));
  expect.soft(Math.max(...strokes)).toBeLessThanOrEqual(1.5);
  const checkInsets = async (line: Locator) => {
    const insets = await paragraphInsets(line);
    for (const inset of insets) {
      expect.soft(inset).toBeGreaterThanOrEqual(8);
      expect.soft(inset).toBeLessThanOrEqual(32);
    }
  };
  const reading = viewer.locator('.markdown-reader article');
  await expect(reading).toBeVisible();
  await checkInsets(reading);
  await page.getByTestId('md-mode-edit').check();
  const editor = page.getByTestId('markdown-editor-input');
  await expect(editor).toBeVisible();
  await expect.soft(viewer.getByRole('group', { name: 'Markdown formatting' })).toHaveCount(0);
  await checkInsets(editor.locator('.cm-line').first());
  await page.screenshot({ path: info.outputPath('wide-editor.png') });
  await page.getByTestId('md-mode-split').check();
  await checkInsets(reading);
  await win.evaluate((w: BrowserWindow) => {
    w.setContentSize(960, 720);
  });
  await expect(viewer.locator('.markdown-workspace')).toHaveAttribute('data-stacked', 'true');
  await checkInsets(reading);
  await page.screenshot({ path: info.outputPath('narrow-split.png') });
  const active = modes.locator('input:checked');
  await active.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('md-mode-preview')).toBeChecked();
});

test('the document side outline stays centered, fades long outlines, and supports hover and keyboard navigation', async ({
  page,
  app,
  workspaces,
}, info) => {
  const lines = Array.from(
    { length: 180 },
    (_, i) => '#'.repeat((i % 3) + 1) + ' Chapter ' + String(i + 1) + '\n\nSection body\n',
  );
  await openSession(app, page, workspaces, 'Chapter index', 't18-chat', 'Read the document', {
    'guide.md': lines.join('\n') + '\n' + 'End of document.\n\n'.repeat(45),
  });
  await idle(page);
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'guide.md' }).click();
  const rail = page.getByTestId('md-outline-trigger'),
    popup = page.getByTestId('md-outline-popover');
  const viewport = page.locator('.markdown-workspace');
  await expect(rail).toBeVisible();
  const outer = await viewport.boundingBox(),
    box = await rail.boundingBox();
  if (!outer || !box) throw Error('Outline geometry missing');
  expect(Math.abs(outer.y + outer.height / 2 - (box.y + box.height / 2))).toBeLessThan(2);
  expect(box.height).toBeLessThanOrEqual(Math.min(190, outer.height * 0.4));
  expect(outer.x + outer.width - box.x - box.width).toBeLessThan(40);
  const marks = rail.locator('.md-outline-mark');
  expect(await marks.count()).toBeLessThan(80);
  expect(
    new Set(await marks.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width)))
      .size,
  ).toBeGreaterThan(1);
  await expect(rail.locator('.md-outline-marks')).toHaveCSS('mask-image', /gradient/);
  await expect(popup).toHaveCount(0);
  await rail.hover();
  await expect(popup).toBeVisible();
  await page.screenshot({ path: info.outputPath('document-outline.png') });
  await popup.getByRole('button', { name: 'Find a heading' }).click();
  await popup.getByRole('textbox').fill('Chapter 146');
  await popup.getByRole('button', { name: 'Chapter 146', exact: true }).click();
  await expect(popup).toHaveCount(0);
  await expect
    .poll(() => page.getByTestId('markdown-reader').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(500);
  await rail.hover();
  await expect(popup).toBeVisible();
  await page.getByTestId('markdown-reader').hover({ position: { x: 40, y: 60 } });
  await expect(popup).toHaveCount(0);
  await rail.focus();
  await page.keyboard.press('Enter');
  await expect(popup.getByRole('button', { name: 'Chapter 146', exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  );
  await page.keyboard.press('Escape');
  await expect(rail).toBeFocused();
  await page.getByTestId('markdown-reader').hover({ position: { x: 50, y: 60 } });
  await page.mouse.wheel(0, -200000);
  await expect(rail).toHaveAttribute('aria-description', 'Chapter 1');
  await page.getByTestId('md-mode-edit').check();
  await expect(rail).toBeVisible();
  await page.getByTestId('md-mode-source').check();
  await expect(rail).toBeVisible();
  await page.getByTestId('md-mode-split').check();
  await expect(rail).toBeVisible();
});

test('outline highlights retain a visible gap and its markers leave space beside the document scrollbar', async ({
  page,
  app,
  workspaces,
}, info) => {
  const content = Array.from(
    { length: 32 },
    (_, i) => '## Section ' + String(i + 1) + '\n\nParagraph.\n',
  ).join('\n');
  await openSession(app, page, workspaces, 'Outline details', 't18-chat', 'Read the sections', {
    'toc.md': content,
  });
  await idle(page);
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'toc.md' }).click();
  const trigger = page.getByTestId('md-outline-trigger'),
    popup = page.getByTestId('md-outline-popover');
  const geometry = [];
  for (const density of ['comfortable', 'compact'] as const) {
    await prefer(page, { key: 'appearance.density', value: density });
    await expect(page.locator('html')).toHaveAttribute('data-density', density);
    await expect(trigger).toBeVisible();
    const gap = await trigger.evaluate((el) => {
      const reader = el
        .closest('.markdown-workspace')
        ?.querySelector<HTMLElement>('.markdown-reader');
      const rail = el.querySelector('.md-outline-mark');
      if (!reader || !rail) throw Error('Missing document scroll viewport');
      return (
        reader.getBoundingClientRect().left +
        reader.clientWidth -
        rail.getBoundingClientRect().right
      );
    });
    expect.soft(gap, density + ' clearance from the scrollbar').toBeGreaterThanOrEqual(4);
    expect.soft(gap, density + ' clearance from the scrollbar').toBeLessThanOrEqual(13);
    await trigger.hover();
    const first = popup.getByRole('button', { name: 'Section 1', exact: true });
    const second = popup.getByRole('button', { name: 'Section 2', exact: true });
    await second.hover();
    await expect(first).toHaveAttribute('aria-current', 'location');
    for (const item of [first, second]) {
      await expect.soft(item).toHaveCSS('background-clip', 'padding-box');
      await expect.soft(item).toHaveCSS('border-top-width', '1px');
      await expect.soft(item).toHaveCSS('border-bottom-width', '1px');
    }
    const a = await first.boundingBox(),
      b = await second.boundingBox();
    if (!a || !b) throw Error('Missing outline rows');
    expect(Math.abs(b.y - a.y - a.height)).toBeLessThan(1);
    expect(a.height).toBeGreaterThanOrEqual(24);
    geometry.push({
      density,
      scrollbarClearance: gap,
      rowHeight: a.height,
      highlightGap: 2 + b.y - a.y - a.height,
    });
    if (density === 'comfortable') {
      const menu = await popup.boundingBox(),
        edge = await trigger.boundingBox();
      if (menu && edge) {
        const x = Math.max(0, Math.floor(menu.x - 6)),
          y = Math.max(0, Math.floor(menu.y - 6));
        const end = Math.min(
          await page.evaluate(() => innerWidth),
          Math.ceil(edge.x + edge.width + 32),
        );
        await page.screenshot({
          path: info.outputPath('outline-spacing.png'),
          clip: {
            x,
            y,
            width: end - x,
            height: Math.min(
              Math.ceil(menu.height + 12),
              (await page.evaluate(() => innerHeight)) - y,
            ),
          },
        });
      }
    }
    await page.keyboard.press('Escape');
  }
  await writeFile(info.outputPath('outline-spacing.json'), JSON.stringify(geometry, null, 2));
});
