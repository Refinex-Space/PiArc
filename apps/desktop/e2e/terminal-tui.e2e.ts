// T10-A07: full-screen programs drawn from Core's frames. For vim (alternate screen, syntax
// colors; on Windows the one Git ships) and a program that redraws the whole screen (top on
// macOS, htop is not installed; a PowerShell process table on Windows), the test waits until
// the screen the page rebuilt from frames equals Core's formatter output and stays so, then
// saves the screenshot next to both texts.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from './fixtures.js';
import { openTerminal, powershell, settledScreen, waitForScreen, WINDOWS } from './terminal.js';

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

/** vim: on PATH on macOS; on Windows `<git>\usr\bin\vim.exe` of the `git` on PATH. */
function vim(): string {
  if (!WINDOWS) {
    return 'vim';
  }
  // `git --exec-path` is <git>\mingw64\libexec\git-core.
  const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  return path.join(execPath, '..', '..', '..', 'usr', 'bin', 'vim.exe');
}

/** Redraws a process table every two seconds, like top. Ctrl+C ends it. */
const PROCESS_TABLE = [
  'while ($true) {',
  '  $all = Get-Process',
  '  $table = $all | Sort-Object CPU -Descending | Select-Object -First 20 Id, ProcessName, CPU, WS |',
  '    Format-Table -AutoSize | Out-String',
  '  Clear-Host',
  '  "Processes: $($all.Count)"',
  '  $table',
  '  Start-Sleep -Seconds 2',
  '}',
].join('\n');

test('vim renders on the alternate screen', async ({ app, page }, testInfo) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'piarc-vim-'));
  try {
    const file = path.join(dir, 'main.rs');
    await writeFile(file, SOURCE, 'utf8');
    const id = await openTerminal(app, page, {
      cols: 90,
      rows: 24,
      program: vim(),
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
    ...(WINDOWS ? powershell(PROCESS_TABLE) : { program: 'top', args: ['-s', '2', '-o', 'cpu'] }),
  });
  await waitForScreen(page, (text) =>
    WINDOWS
      ? text.includes('ProcessName') && text.includes('Processes:')
      : text.includes('PID') && text.includes('COMMAND'),
  );
  const text = await settledScreen(app, page, id, 300, 15_000);
  expect(text).toMatch(/Processes:/);
  await page.getByTestId('terminal-host').screenshot({ path: testInfo.outputPath('top.png') });
  await writeFile(testInfo.outputPath('top.formatter.txt'), `${text}\n`, 'utf8');
  await page.keyboard.press(WINDOWS ? 'Control+C' : 'q');
});
