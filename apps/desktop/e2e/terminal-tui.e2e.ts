// T10-A07: full-screen programs drawn from Core's frames. For vim (alternate screen, syntax
// colors) and top (htop is not installed; top redraws the whole screen every second), the test
// waits until the screen the page rebuilt from frames equals Core's formatter output and stays
// so, then saves the screenshot next to both texts.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from './fixtures.js';
import { openTerminal, settledScreen, waitForScreen } from './terminal.js';

test.skip(process.platform === 'win32', 'ConPTY and Windows programs are verified in W0');

const SOURCE = [
  '// PiArc terminal check: 中文注释 and emoji 😀',
  'fn main() {',
  '    let greeting = "hello";',
  '    for i in 0..3 {',
  '        println!("{greeting} {i}");',
  '    }',
  '}',
  '',
].join('\n');

test('vim renders on the alternate screen', async ({ app, page }, testInfo) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'piarc-vim-'));
  try {
    const file = path.join(dir, 'main.rs');
    await writeFile(file, SOURCE, 'utf8');
    const id = await openTerminal(app, page, {
      cols: 90,
      rows: 24,
      program: 'vim',
      args: ['-u', 'NONE', '-i', 'NONE', '-N', '-c', 'syntax on', '-c', 'set number', file],
      cwd: dir,
    });
    await waitForScreen(page, (text) => text.includes('fn main()') && text.includes('main.rs'));
    const text = await settledScreen(app, page, id);
    expect(text).toContain('中文注释');
    expect(text.split('\n').filter((line) => line === '~').length).toBeGreaterThan(5);
    await page.getByTestId('terminal-host').screenshot({ path: testInfo.outputPath('vim.png') });
    await writeFile(testInfo.outputPath('vim.formatter.txt'), `${text}\n`, 'utf8');
    await page.keyboard.type(':q!');
    await page.keyboard.press('Enter');
    await waitForScreen(page, (screen) => !screen.includes('fn main()'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('top redraws the whole screen', async ({ app, page }, testInfo) => {
  const id = await openTerminal(app, page, {
    cols: 100,
    rows: 30,
    program: 'top',
    args: ['-s', '2', '-o', 'cpu'],
  });
  await waitForScreen(page, (text) => text.includes('PID') && text.includes('COMMAND'));
  const text = await settledScreen(app, page, id, 300, 15_000);
  expect(text).toMatch(/Processes:/);
  await page.getByTestId('terminal-host').screenshot({ path: testInfo.outputPath('top.png') });
  await writeFile(testInfo.outputPath('top.formatter.txt'), `${text}\n`, 'utf8');
  await page.keyboard.press('q');
});
