// Code blocks retain editable source in the Files tile. Only live mode decorates the fences.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './sessions.js';
import { openSession, idle } from './t19.js';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
test('a live code card hides both fences, copies only its body and searches the footer language without losing metadata', async ({
  page,
  app,
  workspaces,
}) => {
  const original = '# Note\n\n~~~ts title="标题"\nconst 值 = 3;\n~~~~\n\nEnd';
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'Document code card',
    't18-chat',
    'Review the block',
    { 'card.md': original },
  );
  await idle(page);
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'card.md' }).click();
  await page.getByTestId('md-mode-edit').check();
  const footer = page.locator('.md-code-footer');
  const language = footer.getByRole('combobox', { name: 'Code block language' });
  const editor = page.getByTestId('markdown-editor-input');
  await expect(editor).not.toContainText('~~~');
  await expect(language).toHaveValue('ts');
  const previous = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await footer.getByRole('button', { name: 'Copy code block' }).click();
    await expect(footer.getByRole('button', { name: 'Copied' })).toBeVisible();
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe('const 值 = 3;');
    await language.fill('rust');
    await footer.getByRole('option', { name: 'rust', exact: true }).click();
    await expect
      .poll(() => readFile(path.join(ws, 'card.md'), 'utf8'))
      .toBe(original.replace('~~~ts', '~~~rust'));
    await expect(editor).toBeFocused();
    await editor.press(mod + '+z');
    await expect.poll(() => readFile(path.join(ws, 'card.md'), 'utf8')).toBe(original);
    await page.getByTestId('md-mode-source').check();
    await expect(footer).toHaveCount(0);
    await expect(editor).toContainText('~~~ts title="标题"');
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), previous);
  }
});
