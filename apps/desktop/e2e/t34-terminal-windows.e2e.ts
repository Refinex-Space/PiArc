// W3 (I142): the T34 terminal panel cases on Windows. The session terminal runs the user's
// shell, `%COMSPEC%` (cmd.exe) in ConPTY; escapes and process lists come from PowerShell, the
// full-screen programs are the vim and less Git for Windows ships. Commands print text that
// differs from the typed line (`^` escapes, loops), so exact-line checks see only the output.
// Screenshots and formatter texts go to tmp/evidence/W3/ with PIARC_EVIDENCE_TASK=W3.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from './sessions.js';
import { idle, requests, screenshots, typeInComposer, userTexts } from './t19.js';
import {
  cellPoint,
  COPY,
  frameRequests,
  growDock,
  isAlive,
  LINK_MODIFIER,
  linkCalls,
  openPanel,
  panelScreen,
  panelStats,
  PASTE,
  recordExternalLinks,
  rowOf,
  run,
  selections,
  settledPanel,
  visibleTerminal,
  waitForPanel,
} from './terminal-panel.js';
import { readClipboard, withSavedClipboard } from './transcript.js';

test.skip(process.platform !== 'win32', 'Windows commands; the POSIX cases are t34-terminal*');

/** A program Git for Windows ships (`<git>\usr\bin\<name>.exe`), quoted for cmd. */
function gitProgram(name: string): string {
  // `git --exec-path` is <git>\mingw64\libexec\git-core.
  const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  return `"${path.join(execPath, '..', '..', '..', 'usr', 'bin', `${name}.exe`)}"`;
}

/** PowerShell running `script` (no double quotes in it) from cmd. */
const ps = (script: string) => `powershell -NoProfile -NoLogo -Command "${script}"`;

const VIM = () => `${gitProgram('vim')} -u NONE -N --cmd "set encoding=utf-8"`;

const lines = (text: string) => text.split('\n').map((l) => l.trimEnd());

/**
 * The panel with cmd's prompt shortened to `$ `: the session directory of these tests is long
 * and has CJK characters, and where such a prompt wraps with a wide character at the edge,
 * conhost and Core place the next cell differently (registered by W3); the cases here test
 * other things.
 */
async function openCmd(...args: Parameters<typeof openPanel>): ReturnType<typeof openPanel> {
  const opened = await openPanel(...args);
  await run(args[1], 'prompt $$$S& cls');
  await waitForPanel(
    args[1],
    (text) => lines(text).filter(Boolean).join() === '$',
    'the short prompt',
  );
  return opened;
}

/** PowerShell starts cold under an antivirus scan: its output takes longer than a command's. */
const PS_WAIT = 45_000;

test('Ctrl+` opens cmd in the session directory; closing a tab ends what it started', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(120_000);
  const { ws, terminal } = await openCmd(app, page, workspaces);
  await expect(page.getByTestId('terminal-input')).toBeFocused();
  await run(page, 'cd');
  await waitForPanel(page, (text) => lines(text).includes(ws), 'the session directory');
  // A process the shell started outside itself: closing the tab must end it too (Job Object).
  await run(
    page,
    ps(
      "$p = Start-Process ping -ArgumentList '-n','600','127.0.0.1' -WindowStyle Hidden -PassThru; 'PID=' + $p.Id",
    ),
  );
  const screen = await waitForPanel(page, (text) => /^PID=\d+$/m.test(text), 'the job id', PS_WAIT);
  const pid = Number(/^PID=(\d+)$/m.exec(screen)?.[1]);
  expect(isAlive(pid)).toBe(true);

  await page.getByTestId('terminal-new').click();
  await expect(page.getByTestId('terminal-tab')).toHaveCount(2);
  await expect.poll(() => visibleTerminal(page)).not.toBe(terminal);
  await waitForPanel(page, (text) => text !== '', 'the second shell');
  await run(page, 'for /L %i in (2,1,2) do @echo second-%i');
  await waitForPanel(page, (text) => lines(text).includes('second-2'), 'the second tab');
  await page.getByTestId('terminal-tab').nth(1).dblclick();
  await page.getByTestId('terminal-rename').fill('build 构建');
  await page.getByTestId('terminal-rename').press('Enter');
  await page.getByTestId('terminal-tab').nth(0).click();
  await expect.poll(() => visibleTerminal(page)).toBe(terminal);
  await waitForPanel(page, (text) => text.includes(`PID=${String(pid)}`), 'the first screen');
  expect((await panelStats(page)).resets).toBe(1);
  await screenshots(page, info, 'tabs');
  await page.getByTestId('terminal-tab-close').nth(0).click();
  await expect(page.getByTestId('terminal-tab')).toHaveCount(1);
  await expect.poll(() => isAlive(pid), { timeout: 10_000 }).toBe(false);
});

test('selection copies with Ctrl+C or Ctrl+Shift+C; without one Ctrl+C interrupts; Ctrl+V pastes', async ({
  app,
  page,
  workspaces,
  mock,
}, info) => {
  test.setTimeout(120_000);
  await openCmd(app, page, workspaces);
  await run(page, 'echo alpha beta gamma& echo second line here');
  await waitForPanel(page, (text) => lines(text).includes('second line here'), 'the output');
  const row = await rowOf(page, 'alpha beta gamma');

  await withSavedClipboard(app, async () => {
    const from = await cellPoint(page, 6, row, 0.1);
    const to = await cellPoint(page, 15, row, 0.9);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => selections(page)).toEqual([`${String(row)}: 6-15`]);
    await screenshots(page, info, 'selection');
    // Ctrl+C with a selection copies instead of interrupting.
    await page.keyboard.press('Control+C');
    await expect.poll(() => readClipboard(app)).toBe('beta gamma');
    const word = await cellPoint(page, 2, row);
    await page.mouse.dblclick(word.x, word.y);
    await expect.poll(() => selections(page)).toEqual([`${String(row)}: 0-4`]);
    await page.keyboard.press(COPY);
    await expect.poll(() => readClipboard(app)).toBe('alpha');
    const line = await cellPoint(page, 3, row + 1);
    await page.mouse.click(line.x, line.y, { clickCount: 3 });
    await expect.poll(() => selections(page)).toEqual([`${String(row + 1)}: 0-15`]);
    await page.keyboard.press(COPY);
    await expect.poll(() => readClipboard(app)).toBe('second line here');
  });

  await page.getByTestId('terminal-attach').click();
  await expect(page.locator('.snippet-chip')).toContainText('1 line');
  await typeInComposer(page, ' What is this?');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('agent-message').getByText('Got the terminal output.')).toBeVisible(
    { timeout: 30_000 },
  );
  await idle(page);
  const sent = await requests(mock, 't34-panel');
  expect(userTexts(sent.at(-1)?.body ?? {}).at(-1)).toContain('```text\nsecond line here\n```');

  // Typing clears the selection; Ctrl+C without one reaches the program.
  await page.getByTestId('terminal-canvas').click();
  await run(page, 'ping -n 30 127.0.0.1');
  await expect.poll(() => selections(page)).toEqual([]);
  await waitForPanel(page, (text) => text.includes('TTL='), 'ping running');
  await page.keyboard.press('Control+C');
  await run(page, 'for /L %i in (7,1,7) do @echo after-ctrl-c-%i');
  await waitForPanel(page, (text) => lines(text).includes('after-ctrl-c-7'), 'the interrupt');
  // Ctrl+V pastes the clipboard as input.
  await withSavedClipboard(app, async () => {
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), 'echo pasted-^text');
    await page.keyboard.press(PASTE);
    await page.keyboard.press('Enter');
    await waitForPanel(page, (text) => lines(text).includes('pasted-text'), 'the paste');
  });
});

test('the find bar counts matches; links open only when confirmed', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  await openCmd(app, page, workspaces);
  await run(page, 'for %w in (one two three) do @echo ne^edle %w');
  await waitForPanel(page, (text) => lines(text).includes('needle three'), 'the output');
  await page.getByTestId('terminal-find').click();
  await page.getByTestId('terminal-find-input').fill('needle');
  const count = page.getByTestId('terminal-find-count');
  await expect(count).toHaveText(/1 of 3|第 1 个，共 3 个/);
  await page.getByTestId('terminal-find-input').press('Enter');
  await expect(count).toHaveText(/2 of 3|第 2 个，共 3 个/);
  await page.getByTestId('terminal-find-input').press('Escape');
  await expect(page.getByTestId('terminal-input')).toBeFocused();

  // An OSC 8 link (conhost keeps it in its buffer and passes it on) and a plain URL.
  await run(
    page,
    ps(
      "$e = [char]27; Write-Host ($e + ']8;;https://example.com/osc8' + $e + '\\docs' + $e + ']8;;' + $e + '\\ and https://example.org/plain')",
    ),
  );
  const line = 'docs and https://example.org/plain';
  // Rows are counted once cmd's next prompt is out: it scrolls the small viewport.
  await waitForPanel(
    page,
    (text) => lines(text).includes(line) && lines(text).filter(Boolean).at(-1) === '$',
    'the links',
    PS_WAIT,
  );
  const row = await rowOf(page, line);
  const click = async (col: number) => {
    const point = await cellPoint(page, col, row);
    await page.keyboard.down(LINK_MODIFIER);
    await page.mouse.move(point.x, point.y);
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up(LINK_MODIFIER);
  };
  // Cancelled: the address was shown, nothing opened; confirmed: opened.
  await recordExternalLinks(app, 1);
  await click(15);
  await expect.poll(() => linkCalls(app)).toEqual(['confirm https://example.org/plain']);
  await recordExternalLinks(app, 0);
  await click(15);
  await expect
    .poll(async () => (await linkCalls(app)).slice(1))
    .toEqual(['confirm https://example.org/plain', 'open https://example.org/plain']);
  await click(1);
  await expect
    .poll(async () => (await linkCalls(app)).slice(3))
    .toEqual(['confirm https://example.com/osc8', 'open https://example.com/osc8']);
});

test('after a reload one frame brings the screen back and cmd is the same process', async ({
  page,
  app,
  workspaces,
}) => {
  test.setTimeout(120_000);
  const { id, terminal } = await openCmd(app, page, workspaces);
  const shellPid = ps(
    "'SHELL_PID=' + (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)).ParentProcessId",
  );
  await run(page, shellPid);
  const before = await waitForPanel(
    page,
    (text) => /^SHELL_PID=\d+$/m.test(text),
    'the pid',
    PS_WAIT,
  );
  const pid = /^SHELL_PID=(\d+)$/m.exec(before)?.[1];
  await run(page, 'echo before-^reload');
  await waitForPanel(page, (text) => lines(text).includes('before-reload'), 'the marker');
  await page.reload();
  await page.locator(`[data-testid="session-row"][data-session-id="${id}"]`).click();
  await expect.poll(() => visibleTerminal(page)).toBe(terminal);
  await expect.poll(async () => (await panelStats(page)).framesReceived).toBeGreaterThan(0);
  expect((await panelStats(page)).resets).toBe(1);
  expect(await panelScreen(page)).toContain('before-reload');
  await page.getByTestId('terminal-canvas').click();
  await run(page, shellPid);
  await waitForPanel(
    page,
    (text) => lines(text).filter((l) => l === `SHELL_PID=${String(pid)}`).length === 2,
    'the same shell',
    PS_WAIT,
  );
});

test('vim, a PowerShell process table and less render as Core says, before and after a resize', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(180_000);
  const { terminal } = await openCmd(app, page, workspaces, {
    'main.rs': '// 中文注释 😀\nfn main() {\n    println!("hi");\n}\n',
    'long.txt': Array.from(
      { length: 200 },
      (_, i) => `line ${String(i + 1)} of the long file`,
    ).join('\n'),
  });
  await growDock(page, 260);
  await page.getByTestId('terminal-canvas').click();
  const evidence = async (name: string) => {
    const text = await settledPanel(app, page, terminal);
    await writeFile(info.outputPath(`${name}.formatter.txt`), text);
    await page.getByTestId('terminal-surface').screenshot({ path: info.outputPath(`${name}.png`) });
    return text;
  };
  const cols = () =>
    app.evaluate(
      (_electron, id) =>
        (
          JSON.parse(globalThis.__piarcTestHooks?.core.terminalInfo(id) ?? '{}') as {
            cols?: number;
          }
        ).cols,
      terminal,
    );

  await run(page, `${VIM()} -c "syntax on" -c "set number" main.rs`);
  await waitForPanel(page, (text) => text.includes('中文注释'), 'vim');
  expect(await evidence('vim')).toMatch(/^~/m);
  const before = await cols();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (window === undefined) throw new Error('no window');
    const [width = 0, height = 0] = window.getSize();
    window.setSize(width - 240, height - 60);
  });
  await expect.poll(cols).toBeLessThan(before ?? 0);
  expect(await evidence('vim-resized')).toContain('fn main() {');
  await page.keyboard.type(':q!');
  await page.keyboard.press('Enter');
  await waitForPanel(page, (text) => !text.includes('中文注释'), 'vim gone');

  await run(
    page,
    ps(
      'for ($i = 0; $i -lt 3; $i++) { $t = Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Id, ProcessName, CPU | Format-Table -AutoSize | Out-String; Clear-Host; $t; Start-Sleep -Seconds 2 }',
    ),
  );
  await waitForPanel(page, (text) => text.includes('ProcessName'), 'the process table', PS_WAIT);
  await evidence('process-table');
  // Three redraws, then the script ends by itself (Ctrl+C is covered by the tick loop below).
  await run(page, 'cls');
  await waitForPanel(page, (text) => !text.includes('ProcessName'), 'the table gone', PS_WAIT);

  await run(page, `${gitProgram('less')} long.txt`);
  await waitForPanel(page, (text) => text.includes('line 1 of the long file'), 'less');
  expect(await evidence('less')).not.toContain('line 200 of');
  await page.keyboard.press('G');
  await waitForPanel(page, (text) => text.includes('line 200 of the long file'), 'the end');
  await evidence('less-end');
  await page.keyboard.press('q');
});

test('vim gets arrow keys, mouse clicks and bracketed paste through ConPTY', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  const { ws } = await openCmd(app, page, workspaces, { 'notes.txt': 'one\ntwo\nthree\n' });
  await run(page, `${VIM()} -c "set mouse=a" notes.txt`);
  await waitForPanel(page, (text) => lines(text).includes('three'), 'vim');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('x');
  await waitForPanel(page, (text) => lines(text).includes('wo'), 'the arrow key');
  const point = await cellPoint(page, 2, await rowOf(page, 'three'));
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press('x');
  await waitForPanel(page, (text) => lines(text).includes('thee'), 'the click');
  await withSavedClipboard(app, async () => {
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), 'pasted 1\npasted 2');
    await page.keyboard.press('o');
    await page.keyboard.press(PASTE);
    await waitForPanel(page, (text) => lines(text).includes('pasted 2'), 'the paste');
  });
  await expect(page.getByTestId('terminal-paste-dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.type(':wq');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await readFile(path.join(ws, 'notes.txt'), 'utf8')).replace(/\r\n/g, '\n'))
    .toBe('one\nwo\nthee\npasted 1\npasted 2\n');
});

test('a hidden panel and a minimized window pull no frames; shown again they catch up', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  await openCmd(app, page, workspaces);
  await run(page, ps("$n = 0; while ($true) { $n++; 'tick-' + $n; Start-Sleep -Milliseconds 50 }"));
  await waitForPanel(page, (text) => /tick-\d+/.test(text), 'the ticks');
  const lastTick = async () => {
    const ticks = [...(await panelScreen(page)).matchAll(/tick-(\d+)/g)].map((m) => Number(m[1]));
    return Math.max(0, ...ticks);
  };
  const pullsWhileAway = async () => {
    await page.waitForTimeout(300);
    const start = await frameRequests(app);
    await page.waitForTimeout(1000);
    return (await frameRequests(app)) - start;
  };
  await page.keyboard.press('Control+Backquote');
  await expect(page.getByTestId('terminal-panel')).toHaveCount(0);
  expect(await pullsWhileAway()).toBe(0);
  const seen = await lastTick();
  await page.keyboard.press('Control+Backquote');
  await expect.poll(lastTick).toBeGreaterThan(seen + 10);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => !w.isDestroyed())
      ?.minimize();
  });
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isMinimized()),
      ),
    )
    .toBe(true);
  expect(await pullsWhileAway()).toBe(0);
  const minimized = await lastTick();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => !w.isDestroyed())
      ?.restore();
  });
  await expect.poll(lastTick, { timeout: 10_000 }).toBeGreaterThan(minimized + 10);
  await page.getByTestId('terminal-canvas').click();
  await page.keyboard.press('Control+C');
  // Stopped: cmd's prompt comes back and the count stays.
  await waitForPanel(
    page,
    (text) => lines(text).filter(Boolean).at(-1) === '$',
    'the prompt',
    PS_WAIT,
  );
  const stopped = await lastTick();
  await page.waitForTimeout(500);
  expect(await lastTick()).toBe(stopped);
});

test('the input method composes at the cursor and commits once in cmd', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(120_000);
  await openCmd(app, page, workspaces);
  await run(page, 'echo ready-^ime');
  await waitForPanel(page, (text) => lines(text).includes('ready-ime'), 'the prompt');
  await page.keyboard.type('echo ');
  const probe = () =>
    page.evaluate(() => {
      const api = globalThis.__piarcTerminalPanel;
      if (api === undefined) throw new Error('no terminal on screen');
      return { cursor: api.cursorRect(), textarea: api.textareaRect(), preedit: api.preedit() };
    });
  let last = -1;
  await expect
    .poll(async () => {
      const x = (await probe()).cursor.left;
      const still = x === last;
      last = x;
      return still;
    })
    .toBe(true);
  const start = await probe();
  expect(start.textarea.left).toBeCloseTo(start.cursor.left, 0);
  const screenBefore = await panelScreen(page);
  const cdp = await page.context().newCDPSession(page);
  for (const text of ['ni', '你好']) {
    await cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  }
  expect((await probe()).preedit).toBe('你好');
  expect(await panelScreen(page)).toBe(screenBefore);
  await page.screenshot({ path: info.outputPath('ime-preedit.png') });
  await cdp.send('Input.insertText', { text: '你好' });
  await expect
    .poll(async () => {
      const now = await probe();
      return Math.round((now.cursor.left - start.cursor.left) / start.cursor.width);
    })
    .toBe(4);
  await page.keyboard.press('Enter');
  const screen = await waitForPanel(page, (text) => lines(text).includes('你好'), 'the text');
  expect(screen).not.toContain('你好你好');
  await page.screenshot({ path: info.outputPath('ime-committed.png') });
});
