// Helpers for L4 tests of the transcript prototype page (`#/transcript-lab`, T09): opening it,
// calling `window.__piarcTranscriptLab`, and saving the system clipboard around copy tests.
import type { ElectronApplication, Page } from '@playwright/test';

import {
  TRANSCRIPT_LAB_HASH,
  type ComposerActionRecord,
  type LabListKind,
  type ScrollSnapshot,
} from '../src/shared/transcript-lab.js';

/** Reloads the window on the prototype page with the given virtual list. */
export async function openLab(page: Page, list: LabListKind = 'tanstack'): Promise<void> {
  await page.evaluate(
    ({ hash, kind }) => {
      window.location.hash = `${hash}?list=${kind}`;
      window.location.reload();
    },
    { hash: TRANSCRIPT_LAB_HASH, kind: list },
  );
  await page.getByTestId('transcript-lab').waitFor();
  await page.waitForFunction(() => globalThis.__piarcTranscriptLab !== undefined);
}

/** Adds a finished agent message; resolves with its item id once parsed. */
export function addMessage(page: Page, markdown: string): Promise<string> {
  return page.evaluate(async (text) => {
    const api = globalThis.__piarcTranscriptLab;
    if (api === undefined) {
      throw new Error('not the transcript prototype page');
    }
    return api.addMessage(text);
  }, markdown);
}

/** Waits until a message's Markdown is final and its code blocks are settled. */
export function settled(page: Page, itemId: string): Promise<void> {
  return page.evaluate(async (id) => {
    const api = globalThis.__piarcTranscriptLab;
    if (api === undefined) {
      throw new Error('not the transcript prototype page');
    }
    await api.settled(id);
  }, itemId);
}

/** Streams a turn; resolves with its item ids when it is finished. */
export function streamTurn(
  page: Page,
  options: { tokensPerSecond: number; seconds?: number; messages?: readonly string[] },
): Promise<readonly string[]> {
  return page.evaluate(async (settings) => {
    const api = globalThis.__piarcTranscriptLab;
    if (api === undefined) {
      throw new Error('not the transcript prototype page');
    }
    return (await api.streamTurn(settings)).itemIds;
  }, options);
}

export function loadHistory(
  page: Page,
  count: number,
): Promise<{ readyToVisibleMs: number; visibleRows: number }> {
  return page.evaluate(async (items) => {
    const api = globalThis.__piarcTranscriptLab;
    if (api === undefined) {
      throw new Error('not the transcript prototype page');
    }
    return api.loadHistory(items);
  }, count);
}

export function setRunning(page: Page, running: boolean): Promise<void> {
  return page.evaluate((value) => {
    globalThis.__piarcTranscriptLab?.setRunning(value);
  }, running);
}

export function actions(page: Page): Promise<readonly ComposerActionRecord[]> {
  return page.evaluate(() => globalThis.__piarcTranscriptLab?.actions() ?? []);
}

export function clearActions(page: Page): Promise<void> {
  return page.evaluate(() => {
    globalThis.__piarcTranscriptLab?.clearActions();
  });
}

export async function scrollState(page: Page): Promise<ScrollSnapshot> {
  const state = await page.evaluate(() => globalThis.__piarcTranscriptLab?.scroll());
  if (state === undefined) {
    throw new Error('not the transcript prototype page');
  }
  return state;
}

export function renderCounts(page: Page): Promise<Readonly<Record<string, number>>> {
  return page.evaluate(() => globalThis.__piarcTranscriptLab?.renderCounts() ?? {});
}

export function resetRenderCounts(page: Page): Promise<void> {
  return page.evaluate(() => {
    globalThis.__piarcTranscriptLab?.resetRenderCounts();
  });
}

/** Text on the system clipboard (read in the main process). */
export function readClipboard(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

/** Runs `body` and puts the clipboard's previous text back afterwards. */
export async function withSavedClipboard(
  app: ElectronApplication,
  body: () => Promise<void>,
): Promise<void> {
  const saved = await readClipboard(app);
  try {
    await body();
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved);
  }
}
