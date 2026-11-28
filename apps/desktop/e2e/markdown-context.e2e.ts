// Use native selection gestures, not synthetic selectionchange or synthetic menu clicks.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { BrowserWindow } from 'electron';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './sessions.js';
import { idle, openSession } from './t19.js';
import { readClipboard, withSavedClipboard } from './transcript.js';
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const text = '# Project heading\n\nSelection sample for editing.\n\nSecond paragraph.\n';
async function dragText(page: Page, target: Locator) {
  const box = await target.evaluate((el) => {
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    return { left: r.left, right: r.right, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.left + 1, box.y);
  await page.mouse.down();
  await page.mouse.move(box.right - 1, box.y, { steps: 12 });
  await page.mouse.up();
  return box;
}
test('reading selection floats on first open, copies and attaches the selected quotation, and offers reading-specific context actions', async ({
  page,
  app,
  workspaces,
}, info) => {
  const win = await app.browserWindow(page);
  await win.evaluate((w: BrowserWindow) => {
    w.setContentSize(1520, 900);
  });
  await openSession(app, page, workspaces, 'Selection menu', 't18-chat', 'Review the file', {
    'note.md': text,
    '.claude/rules/readonly.md': '# Protected guide\n\nRead-only paragraph.\n',
  });
  await idle(page);
  await page.getByTestId('tool-files').click();
  await page.getByRole('treeitem', { name: 'note.md' }).click();
  const reader = page.getByTestId('markdown-reader'),
    heading = reader.getByRole('heading', { name: 'Project heading' });
  await expect(heading).toBeVisible();
  const bar = page.getByTestId('markdown-reader-tools');
  await withSavedClipboard(app, async () => {
    const bounds = await dragText(page, heading);
    await expect(bar).toBeVisible();
    const box = await bar.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: info.outputPath('reader-selection.png') });
    await bar.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect.poll(() => readClipboard(app)).toBe('Project heading');
    await dragText(page, heading);
    await page.mouse.click((bounds.left + bounds.right) / 2, bounds.y, { button: 'right' });
    const menu = page.getByRole('menu', { name: 'Markdown actions', exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Format', exact: true })).toHaveCount(0);
    await menu.getByTestId('menu-md-attach').click();
    await expect(page.getByTestId('composer-input').locator('.snippet-chip')).toContainText(
      'note.md#L1',
    );
  });
  const filter = page.getByRole('textbox', { name: 'Filter files' });
  await filter.fill('readonly.md');
  await page.getByRole('treeitem', { name: '.claude/rules/readonly.md', exact: true }).click();
  const locked = page.getByTestId('markdown-reader').filter({ visible: true });
  const protectedTitle = locked.getByRole('heading', { name: 'Protected guide' });
  await expect(protectedTitle).toBeVisible();
  await dragText(page, protectedTitle);
  const readTools = page.getByTestId('markdown-reader-tools');
  await expect(readTools).toBeVisible();
  await expect(readTools.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
});
test('editor menu restores context, applies grouped commands and accepts paste only from the physical menu action', async ({
  page,
  app,
  workspaces,
}, info) => {
  const win = await app.browserWindow(page);
  await win.evaluate((w: BrowserWindow) => {
    w.setContentSize(1520, 900);
  });
  const { id, ws } = await openSession(
    app,
    page,
    workspaces,
    'Editor actions',
    't18-chat',
    'Edit the file',
    { 'note.md': text },
  );
  await idle(page);
  await page.getByTestId('tool-files').click();
  await page.getByRole('treeitem', { name: 'note.md' }).click();
  await page.getByTestId('md-mode-source').check();
  const field = page.getByTestId('markdown-editor-input');
  const line = field.locator('.cm-line').filter({ hasText: 'for editing.' });
  await expect(line).toBeVisible();
  await line.dblclick({ position: { x: 18, y: 8 } });
  const bar = page.getByRole('toolbar', { name: 'Format selection' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button')).toHaveCount(13);
  await page.screenshot({ path: info.outputPath('editor-selection.png') });
  await bar.locator('[data-command=bold]').click();
  await expect(line).toContainText('**');
  await field.press(mod + '+z');
  await expect(line).not.toContainText('**');
  await line.click({ button: 'right', position: { x: 18, y: 8 } });
  let menu = page.getByRole('menu', { name: 'Markdown actions', exact: true });
  await menu.getByTestId('menu-md-format').hover();
  await page.getByTestId('menu-md-italic').click();
  await expect(line).toContainText('*');
  await field.press(mod + '+z');
  await withSavedClipboard(app, async () => {
    await app.evaluate(({ clipboard }) => clipboard.writeText('Inserted through native paste'));
    await field.click();
    await field.press(mod + '+End');
    await field.press('End');
    // An arbitrary renderer call cannot convert an unrelated recent click into a clipboard read.
    await expect(
      page.evaluate((id) => window.piarc.projectFileAction(id, 'note.md', 'pasteMarkdown'), id),
    ).rejects.toThrow();
    await field.press('Shift+F10');
    menu = page.getByRole('menu', { name: 'Markdown actions', exact: true });
    await expect(menu).toBeVisible();
    await menu.getByTestId('menu-md-paste').click();
    await expect(field).toContainText('Inserted through native paste');
    await expect
      .poll(() => readFile(path.join(ws, 'note.md'), 'utf8'))
      .toContain('Inserted through native paste');
    await expect(page.getByTestId('file-viewer')).not.toHaveAttribute('data-dirty', 'true');
    await expect(
      page.evaluate((id) => window.piarc.projectFileAction(id, 'note.md', 'pasteMarkdown'), id),
    ).rejects.toThrow();
  });
});
