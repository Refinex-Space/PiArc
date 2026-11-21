// T34: full-screen programs, input and visibility in the terminal panel. vim, top (htop is not
// installed on the test machine; top redraws the whole screen the same way) and less render
// as Core's formatter says, before and after the window is resized; vim gets arrow keys, mouse
// clicks and bracketed paste through Core's encoders; a hidden panel and a minimized window
// pull no frames; the input method composes at the cursor and commits once. Screenshots and
// formatter texts go to tmp/evidence/T34/ with PIARC_EVIDENCE_TASK=T34.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from './sessions.js';
import {
  frameRequests,
  growDock,
  openPanel,
  panelScreen,
  PASTE,
  rowOf,
  run,
  settledPanel,
  cellPoint,
  waitForPanel,
} from './terminal-panel.js';
import { withSavedClipboard } from './transcript.js';

const SOURCE = [
  '// PiArc terminal panel: 中文注释 and emoji 😀',
  'fn main() {',
  '    let greeting = "hello";',
  '    for i in 0..3 {',
  '        println!("{greeting} {i}");',
  '    }',
  '}',
  '',
].join('\n');

const LONG = Array.from({ length: 200 }, (_, i) => `line ${String(i + 1)} of the long file`).join(
  '\n',
);

/** vim without the user's configuration, UTF-8 whatever the locale (I38). */
const VIM = "vim -u NONE -N --cmd 'set encoding=utf-8'";

/** Columns of terminal `id` as Core sees them. */
function coreCols(
  app: Parameters<typeof frameRequests>[0],
  id: number,
): Promise<number | undefined> {
  return app.evaluate(
    (_electron, terminal) =>
      (
        JSON.parse(globalThis.__piarcTestHooks?.core.terminalInfo(terminal) ?? '{}') as {
          cols?: number;
        }
      ).cols,
    id,
  );
}

test('vim, top and less render as Core says, before and after a resize', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(180_000);
  const { terminal } = await openPanel(app, page, workspaces, {
    'main.rs': SOURCE,
    'long.txt': LONG,
  });
  // Room for top's process table and a page of less.
  await growDock(page, 260);
  await page.getByTestId('terminal-canvas').click();
  const evidence = async (name: string) => {
    const text = await settledPanel(app, page, terminal);
    await writeFile(info.outputPath(`${name}.formatter.txt`), text);
    await page.getByTestId('terminal-surface').screenshot({ path: info.outputPath(`${name}.png`) });
    return text;
  };

  await run(page, `${VIM} -c 'syntax on' -c 'set number' main.rs`);
  await waitForPanel(page, (text) => text.includes('中文注释'), 'vim');
  const vim = await evidence('vim');
  expect(vim).toContain('fn main() {');
  expect(vim).toMatch(/^~/m);

  // A narrower window: Core gets the new grid, vim redraws, the screens agree again.
  const before = await coreCols(app, terminal);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (window === undefined) throw new Error('no window');
    const [width = 0, height = 0] = window.getSize();
    window.setSize(width - 240, height - 60);
  });
  await expect.poll(() => coreCols(app, terminal)).toBeLessThan(before ?? 0);
  const resized = await evidence('vim-resized');
  expect(resized).toContain('fn main() {');
  await page.keyboard.type(':q!');
  await page.keyboard.press('Enter');
  await waitForPanel(page, (text) => !text.includes('中文注释'), 'vim gone');

  await run(page, 'top -s 2 -o cpu');
  await waitForPanel(page, (text) => text.includes('PID') && text.includes('COMMAND'), 'top');
  await evidence('top');
  await page.keyboard.press('q');
  await waitForPanel(page, (text) => !text.includes('COMMAND'), 'top gone');

  await run(page, 'less long.txt');
  await waitForPanel(page, (text) => text.includes('line 1 of the long file'), 'less');
  const less = await evidence('less');
  expect(less).not.toContain('line 200 of');
  await page.keyboard.press('G');
  await waitForPanel(page, (text) => text.includes('line 200 of the long file'), 'the end');
  await evidence('less-end');
  await page.keyboard.press('q');
});

test('vim gets arrow keys, mouse clicks and bracketed paste through Core', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  const { ws } = await openPanel(app, page, workspaces, { 'notes.txt': 'one\ntwo\nthree\n' });
  await run(page, `${VIM} -c 'set mouse=a' notes.txt`);
  await waitForPanel(page, (text) => text.split('\n').includes('three'), 'vim');
  // Arrow key, then x: the first character of the second line goes.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('x');
  await waitForPanel(page, (text) => text.split('\n').includes('wo'), 'the arrow key');
  // A click puts vim's cursor on "three", column 2: x removes the "r".
  const point = await cellPoint(page, 2, await rowOf(page, 'three'));
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press('x');
  await waitForPanel(page, (text) => text.split('\n').includes('thee'), 'the click');
  // Two pasted lines arrive bracketed: vim inserts them as they are, without asking.
  await withSavedClipboard(app, async () => {
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), 'pasted 1\npasted 2');
    await page.keyboard.press('o');
    await page.keyboard.press(PASTE);
    await waitForPanel(page, (text) => text.split('\n').includes('pasted 2'), 'the paste');
  });
  await expect(page.getByTestId('terminal-paste-dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.type(':wq');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => readFile(path.join(ws, 'notes.txt'), 'utf8'))
    .toBe('one\nwo\nthee\npasted 1\npasted 2\n');

  // The wrapping itself, seen by a program that asked for it and prints what it reads.
  await run(page, "printf '\\033[?2004h'; stty -echo; cat -v");
  await withSavedClipboard(app, async () => {
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), 'alpha\nbeta');
    await page.keyboard.press(PASTE);
  });
  await page.keyboard.press('Enter');
  await waitForPanel(
    page,
    (text) => text.includes('^[[200~alpha') && text.includes('beta^[[201~'),
    'the bracketed paste',
  );
  await page.keyboard.press('Control+C');
});

test('a hidden panel and a minimized window pull no frames; shown again they catch up', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  await openPanel(app, page, workspaces);
  await run(page, 'n=0; while :; do n=$((n+1)); echo tick-$n; sleep 0.05; done');
  await waitForPanel(page, (text) => /tick-\d+/.test(text), 'the ticks');
  const lastTick = async () => {
    const ticks = [...(await panelScreen(page)).matchAll(/tick-(\d+)/g)].map((m) => Number(m[1]));
    return Math.max(0, ...ticks);
  };
  /** Requests during one second, after letting one in flight land. */
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
});

test('the input method composes at the cursor and commits once', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(120_000);
  await openPanel(app, page, workspaces);
  await run(page, "printf 'ready-%s\\n' ime");
  await waitForPanel(page, (text) => text.includes('ready-ime'), 'the prompt');
  await page.keyboard.type('echo ');
  const probe = () =>
    page.evaluate(() => {
      const api = globalThis.__piarcTerminalPanel;
      if (api === undefined) throw new Error('no terminal on screen');
      return { cursor: api.cursorRect(), textarea: api.textareaRect(), preedit: api.preedit() };
    });
  // Wait for the echo of the space: the cursor stops moving.
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
  expect(start.textarea.top).toBeCloseTo(start.cursor.top, 0);
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
  // The preedit is the page's drawing: nothing reached the shell yet.
  expect(await panelScreen(page)).toBe(screenBefore);
  await page.screenshot({ path: info.outputPath('ime-preedit.png') });
  await cdp.send('Input.insertText', { text: '你好' });
  // Two wide characters: the cursor and the textarea move four cells right.
  await expect
    .poll(async () => {
      const now = await probe();
      return Math.round((now.cursor.left - start.cursor.left) / start.cursor.width);
    })
    .toBe(4);
  const committed = await probe();
  expect(committed.preedit).toBe('');
  expect(committed.textarea.left).toBeCloseTo(committed.cursor.left, 0);
  await page.keyboard.press('Enter');
  // Written once: the output line is the text itself, not twice over.
  const screen = await waitForPanel(
    page,
    (text) => text.split('\n').includes('你好'),
    'the committed text',
  );
  expect(screen).not.toContain('你好你好');
  await page.screenshot({ path: info.outputPath('ime-committed.png') });
});
