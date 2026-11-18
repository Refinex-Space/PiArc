// Helpers for L4 tests of the transcript prototype page (`#/transcript-lab`, T09): opening it,
// calling `window.__piarcTranscriptLab`, and saving the system clipboard around copy tests.
import type { ElectronApplication, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import {
  FORBIDDEN_TAGS,
  XSS_PAYLOADS,
  XSS_SENTINEL_UNTOUCHED,
} from '../src/shared/xss-payloads.js';

import {
  TRANSCRIPT_LAB_HASH,
  type ComposerActionRecord,
  type ScrollSnapshot,
  type ScrollThresholds,
} from '../src/shared/transcript-lab.js';

/** Reloads the window on the prototype page. */
export async function openLab(page: Page): Promise<void> {
  await page.evaluate((hash) => {
    window.location.hash = hash;
    window.location.reload();
  }, TRANSCRIPT_LAB_HASH);
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

export async function scrollThresholds(page: Page): Promise<ScrollThresholds> {
  const thresholds = await page.evaluate(() => globalThis.__piarcTranscriptLab?.scrollThresholds());
  if (thresholds === undefined) {
    throw new Error('not the transcript prototype page');
  }
  return thresholds;
}

export function renderCounts(page: Page): Promise<Readonly<Record<string, number>>> {
  return page.evaluate(() => globalThis.__piarcTranscriptLab?.renderCounts() ?? {});
}

export function resetRenderCounts(page: Page): Promise<void> {
  return page.evaluate(() => {
    globalThis.__piarcTranscriptLab?.resetRenderCounts();
  });
}

function readRawClipboard(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

/**
 * Text on the system clipboard (read in the main process), with line breaks as `\n`: Chromium
 * writes plain text with the platform's line breaks, CRLF on Windows.
 */
export async function readClipboard(app: ElectronApplication): Promise<string> {
  return (await readRawClipboard(app)).replaceAll('\r\n', '\n');
}

/** Runs `body` and puts the clipboard's previous text back afterwards. */
export async function withSavedClipboard(
  app: ElectronApplication,
  body: () => Promise<void>,
): Promise<void> {
  const saved = await readRawClipboard(app);
  try {
    await body();
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved);
  }
}

declare global {
  var __piarcCspViolations: string[] | undefined;
}

/** Records CSP violations and initializes the shared sentinel before displaying fixture data. */
export async function watchMarkup(page: Page): Promise<void> {
  await page.evaluate((untouched) => {
    globalThis.__piarcXssSentinel = untouched;
    globalThis.__piarcCspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      globalThis.__piarcCspViolations?.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  }, XSS_SENTINEL_UNTOUCHED);
}

/** What an XSS check finds in the rendered transcript. */
export interface Inspection {
  sentinel: string | undefined;
  violations: string[];
  forbidden: string[];
  eventAttributes: string[];
  hrefs: string[];
  text: string;
  remoteRequests: string[];
}

/** Inspects the transcript after XSS payloads were rendered (T09-A07, T19-A10). */
export async function inspect(page: Page): Promise<Inspection> {
  return page.evaluate((tags) => {
    const transcript = document.querySelector('[data-testid="transcript"]');
    if (transcript === null) {
      throw new Error('no transcript');
    }
    const elements = [...transcript.querySelectorAll('*')];
    return {
      sentinel: globalThis.__piarcXssSentinel,
      violations: globalThis.__piarcCspViolations ?? [],
      forbidden: tags.filter((tag) => transcript.querySelector(tag) !== null),
      eventAttributes: elements.flatMap((element) =>
        element
          .getAttributeNames()
          .filter((name) => name.toLowerCase().startsWith('on'))
          .map((name) => `${element.tagName}[${name}]`),
      ),
      hrefs: [...transcript.querySelectorAll('a[href]')].map(
        (anchor) => anchor.getAttribute('href') ?? '',
      ),
      text: transcript.textContent,
      remoteRequests: performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith('app://')),
    };
  }, FORBIDDEN_TAGS);
}

/** Checks the renderer and resource observations after untrusted text is shown. */
export function expectInertDom(result: Inspection): void {
  expect(result.sentinel).toBe(XSS_SENTINEL_UNTOUCHED);
  expect(result.violations).toEqual([]);
  expect(result.forbidden).toEqual([]);
  expect(result.eventAttributes).toEqual([]);
  for (const href of result.hrefs) {
    expect(href).toMatch(/^(https?|mailto):/u);
  }
  expect(result.remoteRequests).toEqual([]);
}

/** Nothing ran, loaded or became markup; every payload shows as text. */
export function expectInert(result: Inspection): void {
  expectInertDom(result);
  for (const payload of XSS_PAYLOADS) {
    expect(result.text, payload.id).toContain(payload.visibleText);
  }
}
