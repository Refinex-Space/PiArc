// Markdown authoring through the actual Files tile and the existing Core save boundary.
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { expect, test, stubFolderDialog } from './sessions.js';
import { openSession, idle } from './t19.js';
import { closeSettings, openSettings } from './settings-panel.js';
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const article = [
  '# Field notes',
  '',
  'A reference with inline math $x^2$ and a footnote[^a].',
  '',
  '> [!TIP]',
  '> Review the sample before editing.',
  '',
  '## Checklist',
  '',
  '- [ ] Verify the draft',
  '',
  '| Label | State |',
  '| --- | --- |',
  '| Alpha | Ready |',
  '',
  '```mermaid',
  'flowchart LR',
  '  Read --> Edit',
  '```',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  Reader->>Editor: Open document',
  '```',
  '',
  '[^a]: A local footnote.',
  '',
].join('\n');

// Keep a failure with an edited test document from opening an unattended quit dialog.
test.beforeEach(async ({ app }) => {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 1;
  });
});

test('Markdown reading, live editing, source and split view share one draft, history and rendered figures', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(100000);
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'Markdown notes',
    't18-chat',
    'Read the notes',
    { 'docs/note.md': article },
  );
  await idle(page);
  const win = await app.browserWindow(page);
  await win.evaluate((w: BrowserWindow) => {
    w.setContentSize(1550, 880);
  });
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'docs', exact: true }).click();
  await page.getByRole('treeitem', { name: 'docs/note.md', exact: true }).click();
  const reader = page.getByTestId('markdown-reader');
  await expect(reader.getByRole('heading', { name: 'Field notes' })).toBeVisible();
  await expect(reader.locator('math')).toHaveCount(1);
  await expect(reader.locator('.markdown-callout')).toContainText('Review the sample');
  await expect(reader.getByRole('cell', { name: 'Alpha' })).toBeVisible();
  const diagrams = reader.locator('figure.markdown-diagram');
  const diagram = diagrams.first().getByRole('img', { name: 'Mermaid diagram' });
  await diagrams.first().scrollIntoViewIfNeeded();
  await expect
    .poll(() => diagram.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await diagrams.nth(1).scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      diagrams
        .nth(1)
        .locator('img')
        .evaluate((el: HTMLImageElement) => el.naturalWidth),
    )
    .toBeGreaterThan(0);
  await reader.getByRole('checkbox').check();
  await expect
    .poll(() => readFile(path.join(ws, 'docs', 'note.md'), 'utf8'))
    .toContain('- [x] Verify');
  await page.getByRole('button', { name: 'Files settings' }).click();
  await page.getByRole('menuitem', { name: 'Auto save', exact: true }).click();
  await page.getByTestId('md-mode-edit').check();
  const field = page.getByTestId('markdown-editor-input');
  await field.click();
  await field.press(mod + '+End');
  await field.press('End');
  await field.press('Enter');
  await page.keyboard.insertText('Draft across modes');
  await page.getByTestId('md-mode-preview').check();
  await expect(reader).toContainText('Draft across modes');
  expect(await readFile(path.join(ws, 'docs', 'note.md'), 'utf8')).not.toContain(
    'Draft across modes',
  );
  await page.getByTestId('md-mode-source').check();
  await field.click();
  await field.press(mod + '+z');
  await expect(field).not.toContainText('Draft across modes');
  await field.press(mod + '+Shift+z');
  await expect(field).toContainText('Draft across modes');
  await page.getByTestId('md-mode-split').check();
  await expect(reader).toContainText('Draft across modes');
  await expect(field).toBeVisible();
  const divider = page.getByRole('separator', { name: 'Resize Markdown editor and preview' });
  await divider.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '55');
  await divider.dblclick();
  await expect(divider).toHaveAttribute('aria-valuenow', '50');
  const launch = app.waitForEvent('window');
  await page.getByTestId('tile-popout-files').click();
  const popup = await launch;
  await expect(popup.getByTestId('markdown-reader')).toContainText('Draft across modes');
  await popup.getByTestId('tile-popout-files').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(() => readFile(path.join(ws, 'docs', 'note.md'), 'utf8'))
    .toContain('Draft across modes');
  await page.screenshot({ path: info.outputPath('markdown-split.png') });
});

test('Markdown image settings control the real paste destination and the inline preview', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(75000);
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'Local Markdown images',
    't18-chat',
    'Insert local images',
    { 'guide.md': '# Images\n' },
  );
  await idle(page);
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'guide.md', exact: true }).click();
  await page.getByTestId('md-mode-edit').check();
  await openSettings(page);
  await page.getByTestId('settings-nav-markdown').click();
  await expect(page.getByTestId('settings-nav-markdown')).toBeVisible();
  await page.getByTestId('markdown-image-location').selectOption('relative');
  await page.getByLabel('Relative folder', { exact: true }).fill('pictures');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  await closeSettings(page);
  const field = page.getByTestId('markdown-editor-input');
  await field.click();
  await field.press(mod + '+End');
  await field.press('End');
  await field.press('Enter');
  await field.evaluate(async (el) => {
    const canvas = document.createElement('canvas');
    canvas.width = 6;
    canvas.height = 4;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.fillStyle = 'green';
    context.fillRect(0, 0, 6, 4);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error('No PNG produced'));
      });
    });
    const data = new DataTransfer();
    data.items.add(new File([blob], 'sample image.png', { type: 'image/png' }));
    el.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
  });
  await expect
    .poll(() => readFile(path.join(ws, 'guide.md'), 'utf8'))
    .toMatch(/!\[.*?\]\([^)]*pictures\/[^)]+\.png\)/u);
  expect(await readdir(path.join(ws, 'pictures'))).toHaveLength(1);
  await page.getByTestId('md-mode-preview').check();
  const image = page.getByTestId('markdown-reader').locator('img');
  await expect
    .poll(() => image.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight]))
    .toEqual([6, 4]);
  await page.screenshot({ path: info.outputPath('local-image-preview.png') });
});

test('an explicitly selected local image folder receives the file and revoking it disables its preview', async ({
  app,
  page,
  workspaces,
}) => {
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'Local assets',
    't18-chat',
    'Prepare images',
    { 'note.md': '# Notes\n' },
  );
  const directory = path.join(workspaces, 'illustrations'),
    original = path.join(workspaces, 'map.png');
  await mkdir(directory);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGMwrPCHIwbiOACRYw+BvTjSqgAAAABJRU5ErkJggg==',
    'base64',
  );
  await writeFile(original, png);
  await idle(page);
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'note.md', exact: true }).click();
  await page.getByTestId('md-mode-edit').check();
  await openSettings(page);
  await page.getByTestId('settings-nav-markdown').click();
  await stubFolderDialog(app, directory);
  await page.getByTestId('markdown-image-location').selectOption('selected');
  await expect(page.getByTestId('settings-window')).toContainText(directory);
  await page.getByTestId('markdown-image-link').selectOption('absolute');
  await closeSettings(page);
  // Wait for the native fixture to finish before measuring the usual autosave deadline.
  // No keyboard or pointer event is sent to the renderer while the chooser owns input.
  await app.evaluate(({ dialog }, chosen) => {
    const closed = Promise.withResolvers<boolean>();
    (globalThis as { __piarcImageDialogClosed?: Promise<boolean> }).__piarcImageDialogClosed =
      closed.promise;
    dialog.showOpenDialog = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5600));
      closed.resolve(true);
      return { canceled: false, filePaths: [chosen] };
    };
  }, original);
  const editor = page.getByTestId('markdown-editor-input');
  await editor.click();
  await editor.press(mod + '+End');
  await editor.press('End');
  await editor.press('Enter');
  await editor.press('Shift+F10');
  const menu = page.getByRole('menu', { name: 'Markdown actions', exact: true });
  await menu.getByRole('menuitem', { name: 'Insert', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Insert images', exact: true }).click();
  await app.evaluate(
    () => (globalThis as { __piarcImageDialogClosed?: Promise<boolean> }).__piarcImageDialogClosed,
  );
  await expect
    .poll(() => readFile(path.join(ws, 'note.md'), 'utf8'))
    .toMatch(/!\[map\]\(file:\/\//u);
  const names = await readdir(directory);
  expect(names).toHaveLength(1);
  expect(await readFile(path.join(directory, names[0] ?? ''))).toEqual(png);
  await page.getByTestId('md-mode-preview').check();
  await expect
    .poll(() =>
      page
        .getByTestId('markdown-reader')
        .getByRole('img')
        .evaluate((e: HTMLImageElement) => e.naturalWidth),
    )
    .toBe(4);
  await page.getByTestId('md-mode-edit').check();
  await openSettings(page);
  await page.getByTestId('settings-nav-markdown').click();
  await page.getByRole('button', { name: 'Forget folder' }).click();
  await closeSettings(page);
  await page.getByTestId('md-mode-preview').check();
  await expect(page.getByTestId('markdown-reader')).toContainText('Image unavailable');
});

test('the document slash menu, selection toolbar and code language picker edit the same Markdown source', async ({
  app,
  page,
  workspaces,
}) => {
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'Editing commands',
    't18-chat',
    'Open the editor',
    { 'commands.md': 'Plain text\n\n```js\nlet value = 20;\n```\n\n' },
  );
  await idle(page);
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'commands.md' }).click();
  await page.getByTestId('md-mode-source').check();
  const field = page.getByTestId('markdown-editor-input');
  await field.click();
  await field.press(mod + '+Home');
  await field.press('Home');
  await field.press('Shift+End');
  const toolbar = page.getByRole('toolbar', { name: 'Format selection' });
  await toolbar.getByRole('button', { name: 'Selection · Bold', exact: true }).click();
  await expect
    .poll(() => readFile(path.join(ws, 'commands.md'), 'utf8'))
    .toContain('**Plain text**');
  const picker = page.getByRole('combobox', { name: 'Code block language', exact: true });
  await expect(picker).toHaveCount(0);
  await page.getByTestId('md-mode-edit').check();
  await picker.fill('typescr');
  await picker.press('Enter');
  await expect
    .poll(() => readFile(path.join(ws, 'commands.md'), 'utf8'))
    .toContain('```typescript\nlet value = 20;');
  await field.focus();
  await field.press(mod + '+End');
  await field.press('End');
  await field.press('Enter');
  await page.keyboard.type('/table', { delay: 15 });
  await expect(page.getByRole('listbox', { name: 'Insert Markdown' })).toBeVisible();
  await field.press('Enter');
  await expect
    .poll(() => readFile(path.join(ws, 'commands.md'), 'utf8'))
    .toMatch(/\|[^\n]*\|\n\|[ :-]+\|/u);
});

test('source and split editors expose cell edits in the body menu and find and replace from the keyboard', async ({
  app,
  page,
  workspaces,
}) => {
  const source = '| Name | Date |\n| --- | --- |\n| Tea | Monday |\n| Coffee | Friday |';
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'Source table',
    't18-chat',
    'Open the table',
    { 'calendar.md': source },
  );
  await idle(page);
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'calendar.md' }).click();
  for (const mode of ['source', 'split'] as const) {
    await page.getByTestId('md-mode-' + mode).check();
    const editor = page.getByTestId('markdown-editor-input');
    await editor.click();
    await editor.press(mod + '+End');
    await editor.press('End');
    await editor.press('ArrowLeft');
    await editor.press('ArrowLeft');
    await editor.press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Table actions', exact: true }).hover();
    const actions = page.getByRole('menu', { name: 'Table actions', exact: true });
    await expect(actions.getByRole('menuitem', { name: 'Move row down' })).toBeDisabled();
    await actions.getByRole('menuitem', { name: 'Insert row below' }).click();
    const disk = () => readFile(path.join(ws, 'calendar.md'), 'utf8');
    await expect.poll(disk).toMatch(/\| Coffee \| Friday \|\n\| *\| *\|$/u);
    await editor.press(mod + '+z');
    await expect.poll(disk).toBe(source);
    await editor.press(mod + '+f');
    const find = page.getByRole('textbox', { name: 'Find', exact: true });
    await expect(find).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Replace', exact: true })).toBeVisible();
    await page.locator('.cm-search').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('.md-edit-toolbar')).toHaveCount(0);
  }
});

test('the grouped block menu accepts pinyin, navigates diagram types and renders the inserted document', async ({
  app,
  page,
  workspaces,
}, info) => {
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'Block menu',
    't18-chat',
    'Open authoring',
    { 'article.md': '# Notes\n\n' },
  );
  await idle(page);
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'article.md' }).click();
  await page.getByTestId('md-mode-edit').check();
  const editor = page.getByTestId('markdown-editor-input');
  await editor.click();
  await editor.press(mod + '+End');
  await editor.press('End');
  await editor.press('Enter');
  await editor.press('/');
  const list = page.getByRole('listbox', { name: 'Insert Markdown' });
  await expect(list.getByRole('group')).toHaveCount(3);
  const folder = list.getByRole('option', { name: 'Mermaid diagram', exact: true });
  await folder.hover();
  const child = page.getByRole('listbox', { name: 'Mermaid diagram', exact: true });
  await expect(child.getByRole('option')).toHaveCount(8);
  await page.screenshot({ path: info.outputPath('slash-diagrams.png') });
  await editor.press('ArrowLeft');
  await expect(child).toHaveCount(0);
  await editor.press('ArrowRight');
  await editor.press('ArrowDown');
  await editor.press('Tab');
  await expect
    .poll(() => readFile(path.join(ws, 'article.md'), 'utf8'))
    .toContain('sequenceDiagram');
  await editor.press(mod + '+End');
  await editor.press('End');
  await editor.press('Enter');
  await page.keyboard.insertText('、');
  // insertText follows Electron's committed-text path, including non-ASCII triggers.
  await page.keyboard.type('jg');
  await expect(page.getByRole('option', { name: 'Warning', exact: true })).toBeVisible();
  await editor.press('Enter');
  await expect.poll(() => readFile(path.join(ws, 'article.md'), 'utf8')).toContain('[!WARNING]');
  await page.getByTestId('md-mode-preview').check();
  await expect(
    page.getByTestId('markdown-reader').locator('figure.markdown-diagram img'),
  ).toBeVisible();
});

test('every authored Mermaid template renders offline as an image in the reading pane', async ({
  app,
  page,
  workspaces,
}) => {
  const kinds = ['flowchart', 'sequence', 'class', 'state', 'er', 'gantt', 'pie', 'mindmap'];
  await openSession(app, page, workspaces, 'Diagram templates', 't18-chat', 'Open diagrams', {
    'diagrams.md': '# Diagrams\n\n',
  });
  await idle(page);
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'diagrams.md' }).click();
  await page.getByTestId('md-mode-source').check();
  const field = page.getByTestId('markdown-editor-input');
  await field.click();
  for (const kind of kinds) {
    await field.press(mod + '+End');
    await field.press('End');
    await field.press('Enter');
    await page.keyboard.type('/' + kind);
    const option = page
      .getByRole('listbox', { name: 'Insert Markdown' })
      .getByRole('option')
      .first();
    await expect(option).toHaveAttribute('data-command', 'diagram-' + kind);
    await field.press('Enter');
  }
  await page.getByTestId('md-mode-preview').check();
  const figures = page.getByTestId('markdown-reader').locator('figure.markdown-diagram');
  await expect(figures).toHaveCount(kinds.length);
  for (const [i, kind] of kinds.entries()) {
    const figure = figures.nth(i);
    await figure.scrollIntoViewIfNeeded();
    await expect
      .poll(
        () =>
          figure
            .locator('img')
            .evaluateAll((images) =>
              images.some((image) => (image as HTMLImageElement).naturalWidth > 0),
            ),
        { message: kind, timeout: 15000 },
      )
      .toBe(true);
  }
});
