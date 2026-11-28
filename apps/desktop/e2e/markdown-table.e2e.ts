import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { expect, test } from './sessions.js';
import { openSession, idle } from './t19.js';
import { readClipboard, withSavedClipboard } from './transcript.js';
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const text =
  '# Ship log\n\n| Name | Ship date  |\n| :----- | -----: |\n| A\\|B |  first  |\n| C | second |\n\nEnd\n';
// Always allow the isolated test window to close after a failed assertion.
test.beforeEach(async ({ app }) => {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 1;
  });
});

test('Markdown table handles, axis context menus, selection and editor history operate on the displayed source', async ({
  page,
  app,
  workspaces,
}, info) => {
  test.setTimeout(80_000);
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'Table editing',
    't18-chat',
    'Open my table',
    { 'table.md': text },
  );
  await idle(page);
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'table.md', exact: true }).click();
  await page.getByTestId('md-mode-edit').check();
  const widget = page.locator('.md-live-table'),
    field = (r: number, c: number) =>
      widget.getByRole('textbox', {
        name: 'Row ' + String(r) + ', column ' + String(c),
        exact: true,
      });
  const grip = (name: string) => widget.locator('[data-table-control="' + name + '"]');
  const source = () => readFile(path.join(ws, 'table.md'), 'utf8');
  await field(3, 2).hover();
  for (const key of ['row', 'column', 'corner', 'append-row', 'append-column'])
    await expect(grip(key)).toBeVisible();
  await page.screenshot({ path: info.outputPath('table-hover.png') });
  const bounds = await field(3, 2).boundingBox(),
    row = await grip('row').boundingBox();
  if (!bounds || !row) throw Error('Expected table geometry');
  expect(row.x + row.width).toBeLessThan(bounds.x);
  expect(Math.abs(row.y + row.height / 2 - bounds.y - bounds.height / 2)).toBeLessThanOrEqual(2);
  await field(2, 2).hover();
  await grip('row').click();
  await expect(widget.locator('td[data-table-selected]')).toHaveCount(2);
  const rowsMenu = page.getByRole('menu', { name: 'Row actions', exact: true });
  await rowsMenu.getByRole('menuitem', { name: 'Duplicate row', exact: true }).click();
  const duplicate = text.replace('| C |', '| A\\|B |  first  |\n| C |');
  await expect.poll(source).toBe(duplicate);
  await field(2, 2).press(mod + '+z');
  await expect.poll(source).toBe(text);
  await field(2, 2).click({ button: 'right' });
  await page.locator('.md-table-menu-tabs').getByRole('button', { name: 'Column actions' }).click();
  await page
    .getByRole('menu', { name: 'Column actions' })
    .getByRole('menuitem', { name: 'Column alignment' })
    .hover();
  const options = page.getByRole('menu', { name: 'Column alignment' });
  await expect(options).toBeVisible();
  const parent = await page.locator('.md-table-popover:not(.md-table-submenu)').boundingBox(),
    child = await options.boundingBox();
  if (!parent || !child) throw Error('Expected alignment flyout bounds');
  expect(child.x >= parent.x + parent.width + 3 || parent.x >= child.x + child.width + 3).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('table-column-menu.png') });
  await options.getByRole('menuitemradio', { name: 'Center column' }).click();
  await expect
    .poll(source)
    .toBe(text.replace('-----:', ' :-----:').replace('|  :-----:', '| :-----:'));
  await field(2, 2).press(mod + '+z');
  await expect.poll(source).toBe(text);
  await field(2, 2).focus();
  await field(2, 2).press('Alt+Shift+t');
  await expect(rowsMenu).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menu', { name: 'Column actions' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(field(2, 2)).toBeFocused();
  await field(3, 2).hover();
  await grip('append-row').click();
  await expect(widget.locator('tbody tr')).toHaveCount(3);
  await expect.poll(source).toContain('| C | second |\n|  |  |');
  await field(4, 2).focus();
  await field(4, 2).press('Tab');
  await expect(field(5, 1)).toBeFocused();
  await field(5, 1).hover();
  await grip('corner').click();
  await page
    .getByRole('menu', { name: 'Table actions' })
    .getByRole('menuitem', { name: 'Resize table' })
    .click();
  const form = page.getByRole('form', { name: 'Resize table' });
  await form.getByLabel('Rows', { exact: true }).fill('3');
  await form.getByLabel('Columns', { exact: true }).fill('3');
  await form.getByRole('button', { name: 'Resize', exact: true }).click();
  await expect(widget.locator('thead th')).toHaveCount(3);
  await expect(widget.locator('tbody tr')).toHaveCount(2);
  const resized = text
    .split('\n')
    .map((line) =>
      line.startsWith('|') ? line + (line.startsWith('| :') ? ' --- |' : '  |') : line,
    )
    .join('\n');
  await expect.poll(source).toBe(resized);
  await expect(page.getByTestId('file-viewer')).not.toHaveAttribute('data-dirty', 'true');
});
test('table grip drag moves a body row; selecting multiple cells clears only their contents and can be undone', async ({
  page,
  app,
  workspaces,
}) => {
  test.setTimeout(65_000);
  const { ws } = await openSession(app, page, workspaces, 'Table drag', 't18-chat', 'Move rows', {
    'table.md': text,
  });
  await idle(page);
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'table.md', exact: true }).click();
  await page.getByTestId('md-mode-edit').check();
  const table = page.locator('.md-live-table'),
    input = (r: number, c: number) =>
      table.getByRole('textbox', {
        name: 'Row ' + String(r) + ', column ' + String(c),
        exact: true,
      });
  const source = () => readFile(path.join(ws, 'table.md'), 'utf8');
  await input(2, 1).hover();
  const a = await table.locator('[data-table-control=row]').boundingBox(),
    b = await input(3, 1).boundingBox();
  if (!a || !b) throw Error('Missing table drag targets');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(source)
    .toBe(
      text.replace('| A\\|B |  first  |\n| C | second |', '| C | second |\n| A\\|B |  first  |'),
    );
  await input(3, 1).press(mod + '+z');
  await expect.poll(source).toBe(text);
  await input(2, 1).click();
  await input(2, 1).press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(table.locator('td[data-table-selected]')).toHaveCount(4);
  await page.keyboard.press('Delete');
  await expect.poll(source).not.toContain('A\\|B');
  await expect(table.locator('thead th')).toHaveCount(2);
  await input(2, 1).press(mod + '+z');
  await expect.poll(source).toBe(text);
  await expect(page.getByTestId('file-viewer')).not.toHaveAttribute('data-dirty', 'true');
});

test('a nested Markdown table copies a selected column, applies a heading row and pastes a rectangular clipboard in one undo step', async ({
  app,
  page,
  workspaces,
}) => {
  const original =
    '# Nested\n\n> - Item\n>\n>   | Name | Value |\n>   | ---- | :---- |\n>   | A\\|B | One |\n>   | C | Two |\n\nEnd\n';
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'Table clipboard',
    't18-chat',
    'Inspect the table',
    { 'nested.md': original },
  );
  await idle(page);
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'nested.md', exact: true }).click();
  await page.getByTestId('md-mode-edit').check();
  const table = page.locator('.md-live-table'),
    cell = (row: number, col: number) =>
      table.getByRole('textbox', {
        name: 'Row ' + String(row) + ', column ' + String(col),
        exact: true,
      });
  const disk = () => readFile(path.join(ws, 'nested.md'), 'utf8');
  await withSavedClipboard(app, async () => {
    await cell(2, 1).hover();
    await table.locator('[data-table-control=column]').click();
    await page
      .getByRole('menu', { name: 'Column actions' })
      .getByRole('menuitem', { name: 'Copy selection', exact: true })
      .click();
    await expect.poll(() => readClipboard(app)).toBe('Name\nA|B\nC');
    await cell(2, 1).hover();
    await table.locator('[data-table-control=row]').click();
    await page
      .getByRole('menu', { name: 'Row actions' })
      .getByRole('menuitemcheckbox', { name: 'Heading row' })
      .click();
    await expect.poll(disk).toBe(original.replace('| A\\|B | One |', '| **A\\|B** | **One** |'));
    await cell(2, 1).press(mod + '+z');
    await expect.poll(disk).toBe(original);
    await app.evaluate(({ clipboard }) => clipboard.writeText('First\tWest\nSecond\tEast'));
    await cell(2, 1).focus();
    await cell(2, 1).press(mod + '+v');
    await expect
      .poll(disk)
      .toBe(
        original
          .replace('| A\\|B | One |', '| First | West |')
          .replace('| C | Two |', '| Second | East |'),
      );
    await cell(2, 1).press(mod + '+z');
    await expect.poll(disk).toBe(original);
    await expect(page.getByTestId('file-viewer')).not.toHaveAttribute('data-dirty', 'true');
  });
});

test('Markdown tables fill the column with a rounded single-pixel frame and wrap long cells in all views', async ({
  app,
  page,
  workspaces,
}, info) => {
  const longPath = '/architecture/' + 'workspace-directory/'.repeat(5) + 'design.md';
  const longWord = 'Supercalifragilistic'.repeat(7);
  const ideographs = '即时编辑与预览'.repeat(14);
  const row = [longPath, longWord, ideographs, 'Code', 'Pending', 'May', 'Ship', 'Ready'];
  const original =
    '| A | B | C | D | E | F | G | H |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| ' +
    row.join(' | ') +
    ' |\n';
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'Table layout',
    't18-chat',
    'Review the layout',
    { 'table.md': original },
  );
  await idle(page);
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'table.md', exact: true }).click();
  const win = await app.browserWindow(page);
  for (const width of [1500, 900]) {
    await win.evaluate((w: BrowserWindow, width) => {
      w.setContentSize(width, 840);
    }, width);
    for (const mode of ['edit', 'preview', 'split'] as const) {
      await page.getByTestId('md-mode-' + mode).check();
      const table =
        mode === 'edit'
          ? page.locator('.md-live-table table')
          : page.getByTestId('markdown-reader').locator('table');
      await expect(table).toBeVisible();
      await expect(table).toHaveCSS('border-top-left-radius', '4px');
      const metrics = await table.evaluate((element: HTMLTableElement) => {
        const frame = getComputedStyle(element);
        const parent = element.parentElement;
        const body = element.rows[1];
        const first = element.rows[0]?.cells[0];
        const second = element.rows[0]?.cells[1];
        const below = body?.cells[0];
        if (!parent || !body || !first || !second || !below)
          throw Error('Missing rendered table cells');
        const a = getComputedStyle(first);
        const b = getComputedStyle(second);
        const c = getComputedStyle(below);
        const bodies = Array.from(body.cells)
          .slice(0, 3)
          .map((cell) => {
            const text = cell.querySelector('.md-cell-display') ?? cell;
            const range = element.ownerDocument.createRange();
            range.selectNodeContents(text);
            return {
              text: text.textContent,
              lines: range.getClientRects().length,
              overflow: cell.scrollWidth - cell.clientWidth,
            };
          });
        return {
          radius: [
            frame.borderTopRightRadius,
            frame.borderBottomRightRadius,
            frame.borderBottomLeftRadius,
          ],
          border: [
            frame.borderTopWidth,
            frame.borderRightWidth,
            frame.borderBottomWidth,
            frame.borderLeftWidth,
          ],
          verticalRule: parseFloat(a.borderRightWidth) + parseFloat(b.borderLeftWidth),
          horizontalRule: parseFloat(a.borderBottomWidth) + parseFloat(c.borderTopWidth),
          outerCellBorders: [a.borderTopWidth, a.borderLeftWidth, c.borderBottomWidth],
          overflow: parent.scrollWidth - parent.clientWidth,
          widthDifference: Math.abs(parent.clientWidth - element.getBoundingClientRect().width),
          bodies,
        };
      });
      expect(metrics.radius).toEqual(['4px', '4px', '4px']);
      expect(metrics.border).toEqual(['1px', '1px', '1px', '1px']);
      expect(metrics.verticalRule).toBe(1);
      expect(metrics.horizontalRule).toBe(1);
      expect(metrics.outerCellBorders).toEqual(['0px', '0px', '0px']);
      expect(metrics.overflow).toBeLessThanOrEqual(0);
      expect(metrics.widthDifference).toBeLessThanOrEqual(1);
      expect(metrics.bodies.map((cell) => cell.text)).toEqual(row.slice(0, 3));
      for (const cell of metrics.bodies) {
        expect(cell.lines).toBeGreaterThan(1);
        expect(cell.overflow).toBeLessThanOrEqual(0);
      }
      if (width === 900)
        await page.screenshot({ path: info.outputPath('table-narrow-' + mode + '.png') });
    }
  }
  await page.getByTestId('md-mode-edit').check();
  const widget = page.locator('.md-live-table');
  const field = widget.getByRole('textbox', { name: 'Row 2, column 1', exact: true });
  await field.hover();
  await widget.locator('[data-table-control=row]').click({ trial: true });
  const updated = longPath + longWord;
  await field.fill(updated);
  await expect(field).toHaveValue(updated);
  const size = await field.evaluate((el: HTMLTextAreaElement) => ({
    lines: el.clientHeight / parseFloat(getComputedStyle(el).lineHeight),
    hiddenWidth: el.scrollWidth - el.clientWidth,
    hiddenHeight: el.scrollHeight - el.clientHeight,
  }));
  expect(size.lines).toBeGreaterThan(1);
  expect(size.hiddenWidth).toBeLessThanOrEqual(0);
  expect(size.hiddenHeight).toBeLessThanOrEqual(1);
  await field.press('Tab');
  await expect(widget.getByRole('textbox', { name: 'Row 2, column 2', exact: true })).toBeFocused();
  await expect
    .poll(() => readFile(path.join(ws, 'table.md'), 'utf8'))
    .toBe(original.replace(longPath, updated));
  await expect(page.getByTestId('file-viewer')).not.toHaveAttribute('data-dirty', 'true');
});

test('a 32-column Markdown table retains its headers and input controls when one glyph per column no longer fits', async ({
  app,
  page,
  workspaces,
}) => {
  const headers = Array.from({ length: 32 }, (_, i) => '字段' + String(i + 1));
  const data = headers.map((_, i) => '单元' + String(i + 1));
  await openSession(app, page, workspaces, 'Dense table', 't18-chat', 'Inspect the table', {
    'dense.md': [headers, headers.map(() => '---'), data]
      .map((row) => '| ' + row.join(' | ') + ' |')
      .join('\n'),
  });
  await idle(page);
  const win = await app.browserWindow(page);
  await win.evaluate((window: BrowserWindow) => {
    window.setContentSize(900, 800);
  });
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'dense.md', exact: true }).click();
  for (const mode of ['preview', 'split', 'edit']) {
    await page.getByTestId('md-mode-' + mode).check();
    const table =
      mode === 'edit'
        ? page.locator('.md-live-table table')
        : page.getByTestId('markdown-reader').locator('table');
    await expect(table).toBeVisible();
    await expect(table.locator('tbody td').nth(29)).toHaveAttribute(
      'data-table-heading',
      headers[29] ?? '',
    );
    await expect(table.getByRole('columnheader')).toHaveCount(32);
    const sizes = await table.evaluate((t: HTMLTableElement) => {
      const frame = t.parentElement,
        body = t.rows[1];
      if (!frame || !body) throw Error('Missing dense table body');
      return {
        outside: frame.scrollWidth - frame.clientWidth,
        overflow: Array.from(body.cells).some((c) => c.scrollWidth > c.clientWidth),
        font: getComputedStyle(body).fontSize,
        cellFont: getComputedStyle(body.cells.item(29) ?? body).fontSize,
        tracks: new Set(Array.from(body.cells).map((c) => c.offsetTop)).size,
      };
    });
    expect(sizes.outside).toBe(0);
    expect(sizes.overflow).toBe(false);
    expect(sizes.font).toBe(sizes.cellFont);
    expect(sizes.tracks).toBeGreaterThan(1);
  }
  const widget = page.locator('.md-live-table');
  const field = widget.getByRole('textbox', { name: 'Row 2, column 30', exact: true });
  await field.click();
  await field.press('Tab');
  await expect(
    widget.getByRole('textbox', { name: 'Row 2, column 31', exact: true }),
  ).toBeFocused();
  await widget.locator('[data-table-control=column]').click();
  await expect(page.getByRole('menu', { name: 'Column actions', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
});
