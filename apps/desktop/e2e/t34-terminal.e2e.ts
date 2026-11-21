// T34: the terminal panel with the real Core, Agent Host and mock provider. Each test opens a
// session and the panel (Ctrl+`), then works the terminal the way a person does: keys, the
// mouse and the clipboard reach Core through the page, and the screen the page rebuilt from
// frames (`window.__piarcTerminalPanel`) is compared with Core's formatter. The terminals run
// the user's login shell in the session's directory. Screenshots go to tmp/evidence/T34/ with
// PIARC_EVIDENCE_TASK=T34.
import AxeBuilder from '@axe-core/playwright';

import { expect, test } from './sessions.js';
import { idle, requests, screenshots, typeInComposer, userTexts } from './t19.js';
import { coreText } from './terminal.js';
import {
  cellPoint,
  COPY,
  isAlive,
  LINK_MODIFIER,
  linkCalls,
  openPanel,
  panelScreen,
  panelStats,
  recordExternalLinks,
  rowOf,
  run,
  selections,
  visibleTerminal,
  waitForPanel,
} from './terminal-panel.js';
import { readClipboard, withSavedClipboard } from './transcript.js';

// The session terminal runs the user's shell: these cases type POSIX shell commands, vim and
// top. The Windows variants (PowerShell or cmd, Git's vim) are W3's (PLAN I142).
test.skip(process.platform === 'win32', 'POSIX shell commands; the Windows variants are W3');

test('Ctrl+` opens a terminal in the session directory; tabs open, rename, switch and close', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(120_000);
  const { ws, terminal } = await openPanel(app, page, workspaces);
  await expect(page.getByTestId('terminal-input')).toBeFocused();
  await run(page, 'pwd');
  await waitForPanel(page, (text) => text.split('\n').includes(ws), 'the session directory');
  // A job the shell started: closing the tab must end it too.
  await run(page, 'sleep 600 & echo PID=$!');
  const screen = await waitForPanel(page, (text) => /^PID=\d+$/m.test(text), 'the job id');
  const pid = Number(/^PID=(\d+)$/m.exec(screen)?.[1]);
  expect(isAlive(pid)).toBe(true);

  await page.getByTestId('terminal-new').click();
  await expect(page.getByTestId('terminal-tab')).toHaveCount(2);
  await expect.poll(() => visibleTerminal(page)).not.toBe(terminal);
  await waitForPanel(page, (text) => text !== '', 'the second shell');
  await run(page, 'echo second-$((1+1))');
  await waitForPanel(page, (text) => text.split('\n').includes('second-2'), 'the second tab');

  // Renamed tabs keep their name; the program's title is used otherwise.
  await page.getByTestId('terminal-tab').nth(1).dblclick();
  await page.getByTestId('terminal-rename').fill('build 构建');
  await page.getByTestId('terminal-rename').press('Enter');
  await expect(page.getByTestId('terminal-tab').nth(1).locator('.terminal-tab-name')).toHaveText(
    'build 构建',
  );

  // Back to the first tab: one full frame brings its screen back.
  await page.getByTestId('terminal-tab').nth(0).click();
  await expect.poll(() => visibleTerminal(page)).toBe(terminal);
  await waitForPanel(page, (text) => text.includes(`PID=${String(pid)}`), 'the first screen');
  expect((await panelStats(page)).resets).toBe(1);
  await screenshots(page, info, 'tabs');

  // Closing the tab ends the shell and the job it started.
  await page.getByTestId('terminal-tab-close').nth(0).click();
  await expect(page.getByTestId('terminal-tab')).toHaveCount(1);
  await expect.poll(() => isAlive(pid), { timeout: 10_000 }).toBe(false);

  // Ctrl+` closes the panel and opens it again with the remaining terminal.
  await page.keyboard.press('Control+Backquote');
  await expect(page.getByTestId('terminal-panel')).toHaveCount(0);
  await page.keyboard.press('Control+Backquote');
  await expect(page.getByTestId('terminal-tab')).toHaveCount(1);
  await expect(page.getByTestId('terminal-tab').locator('.terminal-tab-name')).toHaveText(
    'build 构建',
  );
  await waitForPanel(page, (text) => text.split('\n').includes('second-2'), 'the build tab');
});

test('dragging, double and triple clicks select; Mod+C copies; the selection goes into the message', async ({
  app,
  page,
  workspaces,
  mock,
}, info) => {
  test.setTimeout(120_000);
  await openPanel(app, page, workspaces);
  await run(page, "printf 'alpha beta gamma\\nsecond line here\\n'");
  await waitForPanel(page, (text) => text.split('\n').includes('second line here'), 'the output');
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
    await page.keyboard.press(COPY);
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

  // The selection becomes a chip in the message and its text goes to the model.
  await page.getByTestId('terminal-attach').click();
  await expect(page.getByTestId('terminal-status')).toContainText(
    /added to the message|附加到消息/,
  );
  await expect(page.locator('.snippet-chip')).toContainText('1 line');
  await screenshots(page, info, 'attached');
  await typeInComposer(page, ' What is this?');
  await page.keyboard.press('Enter');
  // The second reply means the second request was made.
  await expect(page.getByText('Got the terminal output.')).toBeVisible({ timeout: 30_000 });
  await idle(page);
  const sent = await requests(mock, 't34-panel');
  const texts = userTexts(sent.at(-1)?.body ?? {});
  expect(texts.at(-1)).toContain('```text\nsecond line here\n```');
  // Typing in the terminal clears the selection.
  await page.getByTestId('terminal-canvas').click();
  await page.keyboard.type('x');
  await expect.poll(() => selections(page)).toEqual([]);
});

test('the find bar highlights every match, steps through them and shows the count', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(120_000);
  await openPanel(app, page, workspaces);
  // The command line itself never contains the word.
  await run(page, "printf 'n%sdle %s\\n' ee one ee two ee three");
  await waitForPanel(page, (text) => text.split('\n').includes('needle three'), 'the output');
  await page.getByTestId('terminal-find').click();
  await page.getByTestId('terminal-find-input').fill('needle');
  const count = page.getByTestId('terminal-find-count');
  await expect(count).toHaveText(/1 of 3|第 1 个，共 3 个/);
  const highlights = () => page.evaluate(() => globalThis.__piarcTerminalPanel?.highlights() ?? []);
  const three = await rowOf(page, 'needle three');
  await expect
    .poll(highlights)
    .toEqual([`${String(three - 2)}: 0-5`, `${String(three - 1)}: 0-5`, `${String(three)}: 0-5*`]);
  await screenshots(page, info, 'find');
  await page.getByTestId('terminal-find-input').press('Enter');
  await expect(count).toHaveText(/2 of 3|第 2 个，共 3 个/);
  await expect.poll(highlights).toContain(`${String(three - 1)}: 0-5*`);
  await page.getByTestId('terminal-find-input').press('Shift+Enter');
  await expect(count).toHaveText(/1 of 3|第 1 个，共 3 个/);
  await page.getByTestId('terminal-find-next').click();
  await expect(count).toHaveText(/3 of 3|第 3 个，共 3 个/);
  await page.getByTestId('terminal-find-input').fill('haystack');
  await expect(count).toHaveText(/No matches|没有匹配/);
  await page.getByTestId('terminal-find-input').press('Escape');
  await expect(page.getByTestId('terminal-find-bar')).toHaveCount(0);
  await expect.poll(highlights).toEqual([]);
  await expect(page.getByTestId('terminal-input')).toBeFocused();
});

test('OSC 8 links and plain URLs show their address and open only when confirmed', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(120_000);
  await openPanel(app, page, workspaces);
  await run(
    page,
    "printf '\\033]8;;https://example.com/osc8\\033\\\\docs\\033]8;;\\033\\\\ and %s\\n' https://example.org/plain",
  );
  const line = 'docs and https://example.org/plain';
  await waitForPanel(page, (text) => text.split('\n').includes(line), 'the links');
  const row = await rowOf(page, line);
  const click = async (col: number) => {
    const point = await cellPoint(page, col, row);
    await page.keyboard.down(LINK_MODIFIER);
    await page.mouse.move(point.x, point.y);
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up(LINK_MODIFIER);
  };

  // Cancelled: the address was shown, nothing opened.
  await recordExternalLinks(app, 1);
  await click(1);
  await expect.poll(() => linkCalls(app)).toEqual(['confirm https://example.com/osc8']);
  // Confirmed: opened.
  await recordExternalLinks(app, 0);
  await click(1);
  await expect
    .poll(() => linkCalls(app))
    .toEqual([
      'confirm https://example.com/osc8',
      'confirm https://example.com/osc8',
      'open https://example.com/osc8',
    ]);
  await click(15);
  await expect
    .poll(async () => (await linkCalls(app)).slice(3))
    .toEqual(['confirm https://example.org/plain', 'open https://example.org/plain']);
  // Hovering with the modifier underlines the link under the pointer.
  const point = await cellPoint(page, 2, row);
  await page.keyboard.down(LINK_MODIFIER);
  await page.mouse.move(point.x, point.y);
  await expect(page.getByTestId('terminal-canvas')).toHaveCSS('cursor', 'pointer');
  await page.screenshot({ path: info.outputPath('link-hover.png') });
  await page.keyboard.up(LINK_MODIFIER);
  // A click without the modifier selects instead of opening.
  await page.mouse.click(point.x, point.y);
  expect(await linkCalls(app)).toHaveLength(5);
});

test('a user terminal is not shared until the switch is turned on', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(120_000);
  const { terminal } = await openPanel(app, page, workspaces);
  const shared = () =>
    app.evaluate(
      (_electron, id) =>
        (
          JSON.parse(globalThis.__piarcTestHooks?.core.terminalInfo(id) ?? '{}') as {
            shared?: boolean;
          }
        ).shared,
      terminal,
    );
  const toggle = page.getByTestId('terminal-share');
  await expect(toggle).not.toBeChecked();
  expect(await shared()).toBe(false);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(shared).toBe(true);
  await screenshots(page, info, 'shared');
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(shared).toBe(false);
});

test('after a reload one frame brings the screen back and the shell is the same', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  const { id, terminal } = await openPanel(app, page, workspaces);
  await run(page, 'echo SHELL_PID=$$');
  const before = await waitForPanel(page, (text) => /^SHELL_PID=\d+$/m.test(text), 'the pid');
  const pid = /^SHELL_PID=(\d+)$/m.exec(before)?.[1];
  await run(page, "printf 'before-%s\\n' reload");
  await waitForPanel(page, (text) => text.includes('before-reload'), 'the marker');

  await page.reload();
  await page.locator(`[data-testid="session-row"][data-session-id="${id}"]`).click();
  // The panel was open: it comes back with the session's terminal.
  await expect.poll(() => visibleTerminal(page)).toBe(terminal);
  await expect.poll(async () => (await panelStats(page)).framesReceived).toBeGreaterThan(0);
  const first = await panelStats(page);
  expect(first.resets).toBe(1);
  expect(await panelScreen(page)).toContain('before-reload');
  await page.getByTestId('terminal-canvas').click();
  await run(page, 'echo SHELL_PID=$$');
  await waitForPanel(
    page,
    (text) => text.split('\n').filter((l) => l === `SHELL_PID=${String(pid)}`).length === 2,
    'the same shell',
  );
});

test('the terminal is focusable, labeled, and its screen can be read as text', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(120_000);
  const { terminal } = await openPanel(app, page, workspaces);
  await run(page, "printf 'screen %s 中文\\n' reader");
  await waitForPanel(page, (text) => text.includes('screen reader 中文'), 'the output');
  const input = page.getByRole('textbox', { name: /Terminal|终端/ });
  await expect(input).toBeFocused();
  await expect(page.getByRole('group', { name: /Terminal|终端/ })).toBeVisible();
  await page.getByTestId('terminal-view-text').click();
  const text = page.getByTestId('terminal-screen-text');
  await expect(text).toBeFocused();
  await expect
    .poll(async () => (await text.textContent()) ?? '')
    .toBe(await coreText(app, terminal));
  await screenshots(page, info, 'screen-text');
  const dialog = await new AxeBuilder({ page })
    // Electron cannot open the extra page axe merges results in; run axe in this page.
    .setLegacyMode(true)
    .include('[data-testid="terminal-text-dialog"]')
    .analyze();
  expect(dialog.violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('terminal-text-dialog')).toHaveCount(0);
  const panel = await new AxeBuilder({ page })
    // Electron cannot open the extra page axe merges results in; run axe in this page.
    .setLegacyMode(true)
    .include('[data-testid="terminal-panel"]')
    .analyze();
  expect(panel.violations).toEqual([]);
});
