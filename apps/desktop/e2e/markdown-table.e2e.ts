import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
