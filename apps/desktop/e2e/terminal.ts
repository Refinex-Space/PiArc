// Helpers for L4 tests of the terminal prototype page (`#/terminal-lab`, T10): opening it,
// starting a terminal through the main-process test hooks and reading the page and Core
// counters.
import type { ElectronApplication, Page } from '@playwright/test';

import { TERMINAL_LAB_HASH, type TerminalLabStats } from '../src/shared/terminal-lab.js';
import type { TerminalCoreStats, TestTerminalOptions } from '../src/shared/test-hooks.js';
import { expectTestHooks } from './core.js';

/** A prompt that does not depend on the user's shell setup. */
export const PLAIN_SHELL: Pick<TestTerminalOptions, 'program' | 'args' | 'env'> = {
  program: '/bin/sh',
  args: [],
  env: { PS1: '$ ', ENV: '' },
};

/**
 * Reloads the window on the prototype page without its own shell, starts a terminal with
 * `options` owned by that window and shows it. Resolves the terminal id.
 */
export async function openTerminal(
  app: ElectronApplication,
  page: Page,
  options: Omit<TestTerminalOptions, 'cellWidth' | 'cellHeight'>,
): Promise<number> {
  await expectTestHooks(app);
  await page.evaluate((hash) => {
    window.location.hash = `${hash}?manual`;
    window.location.reload();
  }, TERMINAL_LAB_HASH);
  await page.getByTestId('terminal-lab').waitFor();
  await page.waitForFunction(() => globalThis.__piarcTerminalLab !== undefined);
  const windowId = await app.evaluate(({ webContents }) => {
    const lab = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().includes('terminal-lab'));
    if (lab === undefined) {
      throw new Error('no terminal-lab window');
    }
    return lab.id;
  });
  const id = await app.evaluate(
    (_electron, { windowId: owner, terminal }) => {
      const hooks = globalThis.__piarcTestHooks;
      if (hooks === undefined) {
        throw new Error('no Core test hooks');
      }
      return hooks.createTerminal(owner, { cellWidth: 8, cellHeight: 17, ...terminal });
    },
    { windowId, terminal: options },
  );
  await page.evaluate((terminalId) => {
    lab().attach(terminalId);
    lab().focus();
    function lab() {
      const api = globalThis.__piarcTerminalLab;
      if (api === undefined) {
        throw new Error('not the terminal prototype page');
      }
      return api;
    }
  }, id);
  return id;
}

/** The screen the page rebuilt from frames. */
export function screenText(page: Page): Promise<string> {
  return page.evaluate(() => globalThis.__piarcTerminalLab?.screenText() ?? '');
}

/** Polls the page's screen until `predicate` holds. */
export async function waitForScreen(
  page: Page,
  predicate: (text: string) => boolean,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await screenText(page);
    if (predicate(text)) {
      return text;
    }
    if (Date.now() > deadline) {
      throw new Error(`screen did not reach the expected state; it shows:\n${text}`);
    }
    await page.waitForTimeout(25);
  }
}

export function labStats(page: Page): Promise<TerminalLabStats> {
  return page.evaluate(() => {
    const api = globalThis.__piarcTerminalLab;
    if (api === undefined) {
      throw new Error('not the terminal prototype page');
    }
    return api.stats();
  });
}

/** Core's counters of terminal `id`. */
export function coreStats(app: ElectronApplication, id: number): Promise<TerminalCoreStats> {
  return app.evaluate((_electron, terminalId) => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) {
      throw new Error('no Core test hooks');
    }
    return hooks.core.terminalStats(terminalId);
  }, id);
}

/** The formatter's text of terminal `id` (what an agent would read). */
export function coreText(app: ElectronApplication, id: number): Promise<string> {
  return app.evaluate(async (_electron, terminalId) => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) {
      throw new Error('no Core test hooks');
    }
    return hooks.core.terminalText(terminalId);
  }, id);
}

/**
 * Waits until the page's screen equals Core's formatter text and stays so for `quietMs`, then
 * returns it: the two views of the same terminal at one moment.
 */
export async function settledScreen(
  app: ElectronApplication,
  page: Page,
  id: number,
  quietMs = 300,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let since = Date.now();
  for (;;) {
    const [page1, core] = [await screenText(page), await coreText(app, id)];
    if (page1 === core && core === last) {
      if (Date.now() - since >= quietMs) {
        return core;
      }
    } else {
      last = page1 === core ? core : '';
      since = Date.now();
    }
    if (Date.now() > deadline) {
      throw new Error(`page and Core never agreed;\npage:\n${page1}\nCore:\n${core}`);
    }
    await page.waitForTimeout(50);
  }
}
