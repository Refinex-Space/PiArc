// Helpers for L4 tests of the Core event channel: the main-process test hooks (present when
// the app loaded a development build of Core) and probe windows (`#/event-probe`).
import type { ElectronApplication, Page } from '@playwright/test';

import {
  EVENT_PROBE_HASH,
  type ProbeSnapshot,
  type RouteSnapshot,
} from '../src/shared/event-probe.js';
// Declares `globalThis.__piarcTestHooks`.
import type {} from '../src/shared/test-hooks.js';

/** Fails clearly when the app was not packaged with a development build of Core. */
export async function expectTestHooks(app: ElectronApplication): Promise<void> {
  // The hooks are installed once Core started (in `app.whenReady`), which can be after the
  // launch resolved on a slow machine.
  const deadline = Date.now() + 15_000;
  let present = false;
  while (!present && Date.now() < deadline) {
    present = await app.evaluate(() => globalThis.__piarcTestHooks !== undefined);
    if (!present) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!present) {
    throw new Error(
      'The app has no Core test hooks: it did not load a development build of Core. ' +
        'Run `npm run package:desktop -- --flavor development`.',
    );
  }
}

/** Opens a probe window and returns its page and `webContents.id`. */
export async function openProbe(app: ElectronApplication): Promise<{ page: Page; id: number }> {
  await expectTestHooks(app);
  const known = new Set(app.windows());
  const id = await app.evaluate(async (_electron, hash) => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) {
      throw new Error('no Core test hooks');
    }
    return hooks.openWindow(hash);
  }, EVENT_PROBE_HASH);
  // The probe is the new page on the probe's URL: the app's main window may open at about the
  // same time (after the preferences load), so "the next window" can be the wrong one.
  let page: Page | undefined;
  const deadline = Date.now() + 10_000;
  while (page === undefined && Date.now() < deadline) {
    page = app
      .windows()
      .find((candidate) => !known.has(candidate) && candidate.url().includes(EVENT_PROBE_HASH));
    if (page === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (page === undefined) {
    throw new Error('the probe window did not appear');
  }
  await page.getByTestId('event-probe').waitFor();
  return { page, id };
}

export async function subscribe(page: Page, routes: readonly string[]): Promise<void> {
  await page.evaluate(async (list) => {
    if (window.__piarcEventProbe === undefined) {
      throw new Error('not a probe page');
    }
    await window.__piarcEventProbe.subscribe(list);
  }, routes);
}

export async function snapshot(page: Page): Promise<ProbeSnapshot> {
  return page.evaluate(() => {
    if (window.__piarcEventProbe === undefined) {
      throw new Error('not a probe page');
    }
    return window.__piarcEventProbe.snapshot();
  });
}

/** Polls the probe until `route` has `events` events or `timeoutMs` passes. */
export async function waitForEvents(
  page: Page,
  route: string,
  events: number,
  timeoutMs = 30_000,
): Promise<RouteSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = (await snapshot(page)).routes[route];
    if (current !== undefined && current.events >= events) {
      return current;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `route ${route}: ${String(current?.events ?? 0)} of ${String(events)} events after ${String(timeoutMs)} ms`,
      );
    }
    await page.waitForTimeout(100);
  }
}

/** Starts a demo source in the main process and returns its id. */
export async function startDemo(
  app: ElectronApplication,
  options: { route: string; eventsPerSecond: number; maxEvents?: number; padBytes?: number },
): Promise<number> {
  return app.evaluate((_electron, demo) => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) {
      throw new Error('no Core test hooks');
    }
    return hooks.core.startDemoSource(demo);
  }, options);
}

export async function stopDemo(
  app: ElectronApplication,
  id: number,
): Promise<{ id: number; emitted: number }> {
  return app.evaluate(async (_electron, source) => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) {
      throw new Error('no Core test hooks');
    }
    return hooks.core.stopDemoSource(source);
  }, id);
}
