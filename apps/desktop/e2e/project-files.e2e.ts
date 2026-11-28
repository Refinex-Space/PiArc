// Real session checkout, real file IPC, browser layout and scoped preview document.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { expect, test } from './sessions.js';
import { openSession, idle } from './t19.js';

const project = {
  'README.md': '# Project atlas\n\n| Name | Role |\n|---|---|\n| Alpha | Release |\n',
  'src/example.ts': 'export const label = "project atlas";\nexport const total = 23;\n',
  'index.html':
    '<!doctype html><html><head><link rel="stylesheet" href="layout.css"></head><body><h1>Local document</h1><p id="state">Static view</p><a href="README.md">Project guide</a><script src="local.js"></script></body></html>',
  'layout.css': 'h1 { color: rgb(18, 71, 95); }',
  'local.js': 'document.getElementById("state").textContent = "Interactive view";',
};

test('browse, pin, search, attach, save and retain a draft across a native file window', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(100_000);
  const win = await app.browserWindow(page);
  await win.evaluate((w: BrowserWindow) => {
    w.setContentSize(1550, 900);
  });
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'Project files',
    't18-chat',
    'Browse local files',
    project,
  );
  await idle(page);
  await page.getByTestId('tool-files').click();
  const tree = page.getByRole('tree'),
    row = (file: string) => tree.locator('[data-file-path="' + file + '"]').first();
  await row('README.md').dblclick();
  await expect(page.getByRole('heading', { name: 'Project atlas' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Alpha' })).toBeVisible();
  await row('src').click();
  await row('src/example.ts').click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await row('src/example.ts').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Attach as context' }).click();
  await expect(
    page.getByTestId('composer-input').locator('[data-piarc-mention="src/example.ts"]'),
  ).toBeVisible();
  await page.getByRole('textbox', { name: 'Filter files' }).fill('?project atlas');
  await expect(tree.getByText('project atlas', { exact: true }).first()).toBeVisible();
  await page.getByRole('textbox', { name: 'Filter files' }).fill('');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByTestId('file-editor');
  await editor.fill('export const saved = 42;\n');
  await expect
    .poll(() => readFile(path.join(ws, 'src/example.ts'), 'utf8'))
    .toBe('export const saved = 42;\n');
  await page.getByRole('button', { name: 'Files settings' }).click();
  await page.getByRole('menuitem', { name: 'Auto save', exact: true }).click();
  await editor.fill('unsaved file draft');
  const opening = app.waitForEvent('window');
  await page.getByTestId('tile-popout-files').click();
  const popup = await opening;
  await expect(popup.getByTestId('file-editor')).toHaveValue('unsaved file draft');
  await popup.getByTestId('tile-popout-files').click();
  await page.getByTestId('tile-close-files').click();
  await expect(page.getByRole('dialog')).toContainText('Discard unsaved changes');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor).toHaveValue('unsaved file draft');
  await page.screenshot({ path: info.outputPath('files-editor-and-draft.png') });
  await writeFile(path.join(ws, 'src/example.ts'), 'external writer\n');
  await editor.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await expect(page.getByTestId('file-viewer').filter({ visible: true })).toContainText(
    /changed on disk/i,
  );
  expect(await readFile(path.join(ws, 'src/example.ts'), 'utf8')).toBe('external writer\n');
  await page.getByTestId('tile-close-files').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByTestId('project-files')).toHaveCount(0);
});

test('static and offline interactive HTML previews load local styles and release their document on close', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(70_000);
  const win = await app.browserWindow(page);
  await win.evaluate((w: BrowserWindow) => {
    w.setContentSize(1550, 860);
  });
  await openSession(
    app,
    page,
    workspaces,
    'Document preview',
    't18-chat',
    'Open the project',
    project,
  );
  await idle(page);
  await page.getByTestId('tool-files').click();
  await page.locator('[data-file-path="index.html"]').click();
  const iframe = page.frameLocator('iframe[title="index.html"]');
  await expect(iframe.getByRole('heading', { name: 'Local document' })).toBeVisible();
  await expect(iframe.locator('#state')).toHaveText('Static view');
  await expect(iframe.locator('h1')).toHaveCSS('color', 'rgb(18, 71, 95)');
  await page.getByRole('button', { name: 'Run local page' }).click();
  await expect(iframe.locator('#state')).toHaveText('Interactive view');
  expect(await iframe.locator('body').evaluate(() => typeof window.piarc)).toBe('undefined');
  await page.screenshot({ path: info.outputPath('local-html-preview.png') });
  await iframe.getByRole('link', { name: 'Project guide' }).click();
  await expect(page.getByRole('heading', { name: 'Project atlas' })).toBeVisible();
  await page.getByTestId('tile-close-files').click();
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('open a project image, export original bytes, browse files added on disk and open a folder terminal', async ({
  app,
  page,
  workspaces,
}, info) => {
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'Local files',
    't18-chat',
    'Use the file tools',
    { 'src/name.txt': 'file' },
  );
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcWQAAAAASUVORK5CYII=',
    'base64',
  );
  await idle(page);
  const win = await app.browserWindow(page);
  await win.evaluate((w: BrowserWindow) => {
    w.setContentSize(1550, 860);
  });
  await page.getByTestId('tool-files').click();
  await expect(page.getByRole('treeitem', { name: 'src', exact: true })).toBeVisible();
  await writeFile(path.join(ws, 'sample.png'), png);
  await page.getByRole('treeitem', { name: 'sample.png' }).click();
  const image = page.getByRole('img', { name: 'sample.png', exact: true });
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
  const destination = path.join(workspaces, 'image copy.png');
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target });
  }, destination);
  await page.getByRole('button', { name: 'Files settings' }).click();
  await page.getByRole('menuitem', { name: 'Download file' }).click();
  await expect.poll(() => readFile(destination).catch(() => Buffer.alloc(0))).toEqual(png);
  await page.screenshot({ path: info.outputPath('project-image.png') });
  await page.getByRole('treeitem', { name: 'src', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open in terminal', exact: true }).click();
  await expect(page.getByTestId('terminal-tab')).toHaveCount(1);
  await expect(page.getByTestId('terminal-input')).toBeVisible();
});

function samplePdf() {
  const stream = 'BT /F1 18 Tf 30 100 Td (Project PDF preview) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + String(stream.length) + ' >>\nstream\n' + stream + '\nendstream',
  ];
  let data = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [i, obj] of objects.entries()) {
    offsets.push(data.length);
    data += String(i + 1) + ' 0 obj\n' + obj + '\nendobj\n';
  }
  const xref = data.length;
  return (
    data +
    'xref\n0 6\n0000000000 65535 f \n' +
    offsets.map((n) => String(n).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' +
    String(xref) +
    '\n%%EOF\n'
  );
}
test('project PDF and audio render in the Files tile with a real document and a decodable local wave', async ({
  app,
  page,
  workspaces,
}, info) => {
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'Documents',
    't18-chat',
    'Read the documents',
    { 'sample.pdf': samplePdf() },
  );
  const wave = Buffer.alloc(44 + 16000);
  wave.write('RIFF');
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24);
  wave.writeUInt32LE(16000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(16000, 40);
  await writeFile(path.join(ws, 'tone.wav'), wave);
  await idle(page);
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'tone.wav' }).click();
  const audio = page.locator('audio[controls]');
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration)).toBe(1);
  await page.getByRole('treeitem', { name: 'sample.pdf' }).click();
  await expect(page.locator('audio')).toHaveCount(0);
  // Chromium commits the PDF stream to its original URL underneath the built-in
  // reader. Checking that nested frame distinguishes a rendered PDF from an empty viewer.
  await expect
    .poll(() =>
      app.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .some((wc) =>
            wc.mainFrame.framesInSubtree.some(
              (frame) =>
                frame.parent?.url ===
                  'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html' &&
                frame.url.startsWith('piarc-document://') &&
                frame.url.endsWith('/sample.pdf'),
            ),
          ),
      ),
    )
    .toBe(true);
  await page.screenshot({ path: info.outputPath('pdf-viewer.png') });
});

test('a large checkout remains navigable by filename and line with bounded DOM rows', async ({
  app,
  page,
  workspaces,
}, info) => {
  const source = Array.from(
    { length: 8000 },
    (_, i) => 'export const field' + String(i) + ' = ' + String(i) + ';',
  ).join('\n');
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'Large project',
    't18-chat',
    'Browse the large checkout',
    { 'large.ts': source },
  );
  for (let batch = 0; batch < 12; batch++) {
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        writeFile(
          path.join(ws, 'note-' + String(batch * 50 + i).padStart(4, '0') + '.txt'),
          'Project note\n',
        ),
      ),
    );
  }
  await idle(page);
  const win = await app.browserWindow(page);
  await win.evaluate((w: BrowserWindow) => {
    w.setContentSize(1550, 900);
  });
  const start = performance.now();
  await page.getByTestId('tool-files').click();
  await expect(page.getByRole('treeitem', { name: 'large.ts', exact: true })).toBeVisible();
  const listing = performance.now() - start;
  expect(await page.getByRole('treeitem').count()).toBeLessThan(60);
  const input = page.getByRole('textbox', { name: 'Filter files' });
  const search = performance.now();
  await input.fill('note-0599');
  await page.getByRole('treeitem', { name: 'note-0599.txt', exact: true }).click();
  await expect(page.locator('[data-source-line="1"]')).toContainText('Project note');
  const opening = performance.now() - search;
  await input.fill('');
  await page.getByRole('treeitem', { name: 'large.ts', exact: true }).click();
  const first = page.locator('[data-source-line="1"]');
  await expect(first).toContainText('field0');
  const scroller = page.locator('.file-source-scroll');
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator('[data-source-line="8000"]')).toContainText('field7999');
  const mounted = await page.locator('[data-source-line]').count();
  expect(mounted).toBeLessThan(100);
  await writeFile(
    info.outputPath('files-performance.json'),
    JSON.stringify(
      {
        rootFiles: 601,
        sourceLines: 8000,
        listingMs: Math.round(listing),
        filterAndOpenMs: Math.round(opening),
        mountedSourceRows: mounted,
      },
      null,
      2,
    ),
  );
});
