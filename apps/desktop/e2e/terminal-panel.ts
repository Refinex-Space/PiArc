// Helpers for L4 tests of the terminal panel (T34): opening a session with the panel, reading
// the visible terminal through `window.__piarcTerminalPanel` (the screen rebuilt from frames)
// and Core's formatter, and pointing at cells.
import type { ElectronApplication, Page } from '@playwright/test';

import type { TerminalLabStats } from '../src/shared/terminal-lab.js';
import { expect } from './sessions.js';
import { idle, openSession } from './t19.js';
import { coreText } from './terminal.js';

/** Opens a workspace and a session (scenario `t34-panel`), then the panel with Ctrl+`. */
export async function openPanel(
  app: ElectronApplication,
  page: Page,
  workspaces: string,
  files: Record<string, string> = {},
): Promise<{ id: string; ws: string; terminal: number }> {
  const session = await openSession(
    app,
    page,
    workspaces,
    'terminal 终端',
    't34-panel',
    'Hello',
    files,
  );
  await idle(page);
  await page.keyboard.press('Control+Backquote');
  await expect(page.getByTestId('terminal-panel')).toBeVisible();
  const terminal = await visibleTerminal(page);
  // The shell is up once its prompt drew something.
  await expect.poll(() => panelScreen(page), { timeout: 20_000 }).not.toBe('');
  return { ...session, terminal };
}

/** The id of the terminal the panel shows. */
export async function visibleTerminal(page: Page): Promise<number> {
  await expect
    .poll(() => page.evaluate(() => globalThis.__piarcTerminalPanel?.terminalId() ?? null))
    .not.toBeNull();
  const id = await page.evaluate(() => globalThis.__piarcTerminalPanel?.terminalId() ?? null);
  if (id === null) throw new Error('no terminal on screen');
  return id;
}

/** The screen the panel rebuilt from frames. */
export function panelScreen(page: Page): Promise<string> {
  return page.evaluate(() => globalThis.__piarcTerminalPanel?.screenText() ?? '');
}

export function panelStats(page: Page): Promise<TerminalLabStats> {
  return page.evaluate(() => {
    const probe = globalThis.__piarcTerminalPanel;
    if (probe === undefined) throw new Error('no terminal on screen');
    return probe.stats();
  });
}

/** Types `command` into the focused terminal and presses Enter. */
export async function run(page: Page, command: string): Promise<void> {
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

/** Waits until the panel's screen satisfies `predicate`; returns it. */
export async function waitForPanel(
  page: Page,
  predicate: (text: string) => boolean,
  what: string,
  timeout = 15_000,
): Promise<string> {
  let last = '';
  await expect
    .poll(
      async () => {
        last = await panelScreen(page);
        return predicate(last);
      },
      { timeout, message: `${what}; the screen shows:\n${last}` },
    )
    .toBe(true);
  return last;
}

/**
 * Waits until the panel's screen equals Core's formatter text and stays so for `quietMs`:
 * the two views of one terminal at one moment. Returns the text.
 */
export async function settledPanel(
  app: ElectronApplication,
  page: Page,
  terminal: number,
  quietMs = 300,
): Promise<string> {
  let stable = '';
  let since = 0;
  await expect
    .poll(
      async () => {
        const [rebuilt, core] = await Promise.all([panelScreen(page), coreText(app, terminal)]);
        if (rebuilt !== core || rebuilt === '') {
          since = 0;
          return false;
        }
        if (rebuilt !== stable) {
          stable = rebuilt;
          since = Date.now();
          return false;
        }
        return Date.now() - since >= quietMs;
      },
      { timeout: 20_000, intervals: [50] },
    )
    .toBe(true);
  return stable;
}

/** The page position of the middle (or `fraction` across) of cell (`col`, `row`). */
export async function cellPoint(
  page: Page,
  col: number,
  row: number,
  fraction = 0.5,
): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('terminal-canvas').boundingBox();
  if (box === null) throw new Error('no terminal canvas');
  const cell = await page.evaluate(() => globalThis.__piarcTerminalPanel?.cell());
  if (cell === undefined) throw new Error('no terminal on screen');
  return {
    x: box.x + (col + fraction) * cell.width,
    y: box.y + (row + 0.5) * cell.height,
  };
}

/** The viewport row showing `line` (trailing spaces trimmed). */
export async function rowOf(page: Page, line: string): Promise<number> {
  const rows = (await panelScreen(page)).split('\n');
  const index = rows.findIndex((text) => text === line);
  if (index < 0) throw new Error(`"${line}" is not on screen`);
  return index;
}

/** Whether process `pid` still exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Main-process frame requests the windows made (all terminals). */
export function frameRequests(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => globalThis.__piarcTestHooks?.terminalForwardStats().requests ?? 0);
}

/** The selection rows the panel's view shows (`row: start-end`). */
export function selections(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => globalThis.__piarcTerminalPanel?.selections() ?? []);
}

/** The copy key of the platform. */
export const COPY = process.platform === 'darwin' ? 'Meta+C' : 'Control+Shift+C';
/** The paste key of the platform. */
export const PASTE = process.platform === 'darwin' ? 'Meta+V' : 'Control+V';
/** The modifier that opens links on click. */
export const LINK_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

interface Recorder {
  __terminalLinkCalls?: string[];
}

/**
 * Replaces the main process's confirmation dialog and `shell.openExternal` with recorders; the
 * dialog answers `response` (0 Open, 1 Cancel).
 */
export async function recordExternalLinks(
  app: ElectronApplication,
  response: 0 | 1,
): Promise<void> {
  await app.evaluate(({ dialog, shell }, answer) => {
    const recorder = globalThis as Recorder;
    recorder.__terminalLinkCalls ??= [];
    const calls = recorder.__terminalLinkCalls;
    dialog.showMessageBox = (...args: unknown[]) => {
      const options: unknown = args.at(-1);
      const detail =
        typeof options === 'object' && options !== null && 'detail' in options
          ? String(options.detail)
          : '';
      calls.push(`confirm ${detail}`);
      return Promise.resolve({ response: answer, checkboxChecked: false });
    };
    shell.openExternal = (url: string) => {
      calls.push(`open ${url}`);
      return Promise.resolve();
    };
  }, response);
}

export function linkCalls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as Recorder).__terminalLinkCalls ?? []);
}
