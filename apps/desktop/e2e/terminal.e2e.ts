// T10 terminal prototype (ADR-0017): frames pulled per animation frame, none while hidden
// (A06), keys encoded by Core with the terminal's modes, and the input-method textarea and
// preedit at the cursor (A11). Programs run in a real PTY; the shell is /bin/sh, so these
// tests run on macOS (ConPTY is W0's).
import type { CDPSession } from '@playwright/test';

import { expect, test } from './fixtures.js';
import {
  coreStats,
  labStats,
  openTerminal,
  PLAIN_SHELL,
  screenText,
  waitForScreen,
} from './terminal.js';

test.skip(process.platform === 'win32', 'ConPTY and Windows shells are verified in W0');

test('output appears in frames pulled per animation frame', async ({ app, page }, testInfo) => {
  const id = await openTerminal(app, page, { cols: 60, rows: 12, ...PLAIN_SHELL });
  await page.keyboard.type('echo hello-$((6*7))');
  await page.keyboard.press('Enter');
  await waitForScreen(page, (text) => text.split('\n').includes('hello-42'));
  const stats = await labStats(page);
  expect(stats.resets).toBe(1);
  expect(stats.errors).toBe(0);
  expect(stats.framesReceived).toBeGreaterThan(stats.resets);
  // Frames flow while nothing changes, but carry nothing: an unchanged terminal costs a header.
  await page.waitForTimeout(500);
  const idle = await labStats(page);
  expect(idle.framesReceived - stats.framesReceived).toBeGreaterThan(10);
  expect(idle.bytes - stats.bytes).toBeLessThanOrEqual(
    (idle.framesReceived - stats.framesReceived) * 14 + 4096,
  );
  expect((await coreStats(app, id)).frames).toBeGreaterThanOrEqual(idle.framesReceived);
  await page.getByTestId('terminal-host').screenshot({ path: testInfo.outputPath('shell.png') });
});

test('a hidden terminal produces no frames', async ({ app, page }) => {
  const id = await openTerminal(app, page, {
    cols: 40,
    rows: 8,
    program: '/bin/sh',
    args: ['-c', 'n=0; while :; do n=$((n+1)); echo tick $n; sleep 0.02; done'],
  });
  await waitForScreen(page, (text) => text.includes('tick'));
  await page.evaluate(() => {
    globalThis.__piarcTerminalLab?.setHidden(true);
  });
  // Let a request that was already in flight land.
  await page.waitForTimeout(300);
  const before = await coreStats(app, id);
  const pageBefore = await labStats(page);
  await page.waitForTimeout(1500);
  const after = await coreStats(app, id);
  const pageAfter = await labStats(page);
  // The program kept writing and Core kept parsing...
  expect(after.bytesRead).toBeGreaterThan(before.bytesRead);
  // ...but nobody asked for a frame and none was produced.
  expect(after.frames - before.frames).toBe(0);
  expect(pageAfter.framesRequested - pageBefore.framesRequested).toBe(0);
  const screenWhileHidden = await screenText(page);
  await page.evaluate(() => {
    globalThis.__piarcTerminalLab?.setHidden(false);
  });
  // Shown again: the next frame brings the screen up to date.
  await waitForScreen(page, (text) => text !== screenWhileHidden && text.includes('tick'));
  expect((await coreStats(app, id)).frames).toBeGreaterThan(after.frames);
});

test('keys are encoded by Core with the terminal modes', async ({ app, page }) => {
  // cat -v shows control characters; the program first turns on application cursor keys.
  await openTerminal(app, page, {
    cols: 40,
    rows: 6,
    program: '/bin/sh',
    args: ['-c', "printf '\\033[?1hready\\n'; exec cat -v"],
  });
  // Only press once the mode is set: Core encodes with the modes at the time of the key.
  await waitForScreen(page, (text) => text.startsWith('ready'));
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+C');
  // DECCKM is on: ArrowUp is ESC O A, which cat -v prints as ^[OA.
  await waitForScreen(page, (text) => text.includes('^[OA'));
});

async function compose(cdp: CDPSession, text: string): Promise<void> {
  await cdp.send('Input.imeSetComposition', {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
}

test('the input method composes at the cursor and commits through Core', async ({
  app,
  page,
}, testInfo) => {
  await openTerminal(app, page, { cols: 40, rows: 6, ...PLAIN_SHELL });
  await waitForScreen(page, (text) => text.startsWith('$'));
  await page.keyboard.type('echo ');
  // The screen text drops trailing spaces, so wait for the cursor: "$ echo " ends at column 7.
  await expect
    .poll(() => page.evaluate(() => globalThis.__piarcTerminalLab?.cursorCell().x))
    .toBe(7);
  const lab = () =>
    page.evaluate(() => {
      const api = globalThis.__piarcTerminalLab;
      if (api === undefined) {
        throw new Error('not the terminal prototype page');
      }
      return { cursor: api.cursorRect(), textarea: api.textareaRect(), preedit: api.preedit() };
    });
  const start = await lab();
  // The textarea that receives the input method sits on the cursor cell, so the system places
  // its candidate window there.
  expect(start.textarea.left).toBeCloseTo(start.cursor.left, 0);
  expect(start.textarea.top).toBeCloseTo(start.cursor.top, 0);
  const cell = {
    x: Math.round(start.cursor.left),
    y: Math.round(start.cursor.top),
    width: Math.round(start.cursor.width * 6),
    height: Math.round(start.cursor.height),
  };
  const before = await page.screenshot({ clip: cell });
  const cdp = await page.context().newCDPSession(page);
  await compose(cdp, 'ni');
  await compose(cdp, '你好');
  const composing = await lab();
  expect(composing.preedit).toBe('你好');
  // Nothing reached the program yet: the preedit is drawn by the page, not echoed by the PTY.
  expect(await screenText(page)).toBe('$ echo');
  const during = await page.screenshot({ clip: cell });
  expect(during.equals(before)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('ime-preedit.png') });
  await cdp.send('Input.insertText', { text: '你好' });
  await waitForScreen(page, (text) => text.startsWith('$ echo 你好'));
  // Two wide characters: the cursor, and the textarea with it, move four cells right (the
  // shell may echo them in more than one write, so wait for the final position).
  await expect
    .poll(async () => {
      const now = await lab();
      return Math.round((now.cursor.left - start.cursor.left) / start.cursor.width);
    })
    .toBe(4);
  const committed = await lab();
  expect(committed.preedit).toBe('');
  expect(committed.textarea.left).toBeCloseTo(committed.cursor.left, 0);
  await page.keyboard.press('Enter');
  await waitForScreen(page, (text) => text.split('\n').includes('你好'));
  await page.screenshot({ path: testInfo.outputPath('ime-committed.png') });
});
