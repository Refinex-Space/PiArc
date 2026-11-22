// The production conversation, with Pi session files, Core, Agent Host and the strict mock.
// Timing starts inside the renderer so Playwright's transport is outside the measurements.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { traced, summarize } from '../../../scripts/bench/s1-transcript.mjs';
import { writeHistoryFixture } from '../../../scripts/bench/t18-cold-start.mjs';
import { startMock } from './agent-host.js';
import { expect, focusMain, openFolder, startSession, test as base } from './sessions.js';
import { idle, prefer, requests, send } from './t19.js';

const coldRuns = 5;
// `PIARC_BENCH_SCALE` (0–1] shortens the streamed reply for the PR smoke (T44): the same
// 100 token/s for a share of the 70 s.
const SCALE = Math.min(1, Math.max(0.05, Number(process.env.PIARC_BENCH_SCALE ?? '1')));
const scaled = (n: number) => Math.round(n * SCALE);
// Leave room for wire framing and the Read round trip so the whole-turn rate reaches
// 100 tokens/s. Verify the delivered rate using both responses' scripted usage.
const chunk = { chunk_chars: 16, chunk_delay_ms: 36 };
const outputTokens = scaled(3_500) + scaled(3_505);
const section =
  'The parser reads the input.\n\n- It preserves **bold** text.\n- It keeps `code` spans.\n\n';
function content(chars: number): string {
  return section.repeat(Math.ceil(chars / section.length)).slice(0, chars);
}
const test = base.extend({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern.
  mock: async ({}, use) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'piarc-t19-mock-'));
    try {
      const scenario = path.join(dir, 'stream.json');
      await writeFile(
        scenario,
        JSON.stringify({
          id: 'bench',
          steps: [
            { text: 'Ready.' },
            {
              thinking: content(scaled(2_400)),
              text: content(scaled(11_600)),
              ...chunk,
              usage: { input_tokens: 100, output_tokens: scaled(3_500) },
              tool_calls: [{ id: 'toolu_read', name: 'Read', input: { path: 'fixture.txt' } }],
            },
            {
              text: content(scaled(14_000)) + '\n\nMeasurement complete.',
              ...chunk,
              usage: { input_tokens: 4000, output_tokens: scaled(3_505) },
            },
          ],
        }),
      );
      const mock = await startMock(scenario);
      try {
        await use(mock);
      } finally {
        mock.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  userDataDir: async ({ userDataDir }, use) => {
    const cwd = path.join(await realpath(userDataDir), 'workspace');
    await mkdir(cwd);
    await writeFile(path.join(cwd, 'fixture.txt'), 'A local benchmark fixture.\n');
    for (let n = 0; n < coldRuns; n++) {
      await writeHistoryFixture(userDataDir, cwd, n, 1_000);
    }
    await writeHistoryFixture(userDataDir, cwd, coldRuns, 10_000);
    await use(userDataDir);
  },
});

/** From sidebar activation until the last page is laid out, visibly parsed and painted. */
async function selectHistory(page: Page, n: number, count: number): Promise<number> {
  const button = page.getByTestId('session-title').filter({ hasText: `Task ${String(n + 1)}:` });
  return button.evaluate(async (element, items) => {
    const started = performance.now();
    const id = element.closest('[data-session-id]')?.getAttribute('data-session-id');
    if (!(element instanceof HTMLElement)) throw new Error('Missing session title');
    element.click();
    const nextFrame = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          resolve();
        }),
      );
    while (performance.now() - started < 15_000) {
      await nextFrame();
      const view = document.querySelector('[data-testid="conversation"]');
      const scroller = view?.querySelector('[data-testid="transcript-scroller"]');
      if (
        view?.getAttribute('data-session-id') !== id ||
        !scroller?.querySelector(`.transcript-row[data-index="${String(items - 1)}"]`)
      )
        continue;
      const viewport = scroller.getBoundingClientRect();
      const ready = [...scroller.querySelectorAll('[data-testid="agent-message"]')].every(
        (message) => {
          const box = message.getBoundingClientRect();
          return (
            box.bottom <= viewport.top ||
            box.top >= viewport.bottom ||
            message.getAttribute('data-parsed') === 'final'
          );
        },
      );
      if (ready) {
        await nextFrame();
        return performance.now() - started;
      }
    }
    throw new Error('The conversation did not paint its complete history window');
  }, count);
}

test('real Core transcript budgets', async ({ app, page, userDataDir, mock }, info) => {
  const display = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('no main window');
    win.setContentSize(1280, 800);
    return {
      hz: screen.getDisplayMatching(win.getBounds()).displayFrequency,
      pid: win.webContents.getOSProcessId(),
    };
  });
  await prefer(page, { key: 'language', value: 'en' });
  await openFolder(page, app, path.join(await realpath(userDataDir), 'workspace'));
  await startSession(page, 'Warm the workspace', 'bench');
  await expect(page.getByTestId('agent-message')).toContainText('Ready.');
  await idle(page);
  await focusMain(app);

  // Capture the full second turn, including its tool call and follow-up response. Keep rAF
  // running so the trace also covers frames without layout updates.
  const streaming = await traced(page, display.pid, async () => {
    // The locator assertion for the final text repeatedly serializes the whole growing
    // reply through DevTools. Observe the actual busy-to-idle transition in the renderer
    // and check the full response once, after tracing has stopped.
    const completion = await page.evaluateHandle(() => {
      const composer = document.querySelector('[data-testid="composer"]');
      if (!composer) throw new Error('Missing composer');
      performance.mark('t19.stream.start');
      let running = false;
      const finished = new Promise<number>((resolve, reject) => {
        const deadline = setTimeout(() => {
          observer.disconnect();
          reject(new Error('The streaming turn did not finish'));
        }, 120_000);
        const observer = new MutationObserver(() => {
          if (composer.getAttribute('data-running') === 'true') {
            running = true;
          } else if (running) {
            observer.disconnect();
            const afterPaint = () => {
              const replies = document.querySelectorAll('[data-testid="agent-message"]');
              const last = replies[replies.length - 1];
              if (last?.getAttribute('data-parsed') !== 'final') {
                requestAnimationFrame(afterPaint);
                return;
              }
              requestAnimationFrame(() => {
                clearTimeout(deadline);
                performance.mark('t19.stream.end');
                resolve(
                  performance.measure('t19.stream', 't19.stream.start', 't19.stream.end').duration,
                );
              });
            };
            requestAnimationFrame(afterPaint);
          }
        });
        observer.observe(composer, { attributes: true, attributeFilter: ['data-running'] });
      });
      const tick = () => {
        if (!performance.getEntriesByName('t19.stream.end').length) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return { finished };
    });
    try {
      await send(page, 'Stream the measurement');
      return await completion.evaluate((state) => state.finished);
    } finally {
      await completion.dispose();
    }
  });
  await expect(page.getByTestId('agent-message').last()).toContainText('Measurement complete.');
  await idle(page);
  const records = await requests(mock, 'bench');
  expect(records).toHaveLength(3);
  expect(JSON.stringify(records.at(-1)?.body.messages)).toContain('A local benchmark fixture.');
  const cold: number[] = [];
  const cached: number[] = [];
  for (let i = 0; i < coldRuns; i++) cold.push(await selectHistory(page, i, 1_000));
  for (let i = 0; i < coldRuns; i++) cached.push(await selectHistory(page, i, 1_000));

  // Page all ten windows into the normal session store via the transcript's scroll handler.
  await selectHistory(page, coldRuns, 1_000);
  const scroller = page.getByTestId('transcript-scroller');
  await scroller.hover();
  await page.mouse.wheel(0, -200);
  await expect(page.getByTestId('transcript')).toHaveAttribute('data-following', 'false');
  for (let start = 9_000; start > 0; start -= 1000) {
    const first = start.toString(16).padStart(4, '0');
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    // The virtualizer keeps the old first entry as an anchor after a prepend.
    await expect(
      scroller.locator(`.transcript-row[data-index="1000"][data-row-id$="${first}"]`),
    ).toBeAttached({ timeout: 10_000 });
  }
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(scroller.locator('.transcript-row[data-index="9999"]')).toBeAttached();
  await page.mouse.wheel(0, -200);
  await expect(page.getByTestId('transcript')).toHaveAttribute('data-following', 'false');
  const scrolling = await scroller.evaluate(async (el) => {
    const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
    const start = await frame();
    let last = start,
      frames = 0;
    const from = el.scrollTop;
    while (last - start < 10_000) {
      const now = await frame();
      // Height corrections shift scrollTop as new rows are measured. Drive the
      // absolute trajectory so the measured displacement stays at 3,000 px/s.
      el.scrollTo({ top: from - 3 * (now - start), behavior: 'instant' });
      last = now;
      frames++;
    }
    return {
      fps: (frames * 1000) / (last - start),
      distancePx: from - el.scrollTop,
      frames,
      durationMs: last - start,
    };
  });

  const result = {
    platform: process.platform,
    cpu: os.cpus()[0]?.model,
    displayHz: display.hz,
    streaming: {
      durationMs: streaming.result,
      targetTokensPerSecond: 100,
      outputTokens,
      measuredTokensPerSecond: (outputTokens * 1000) / streaming.result,
      mockRequests: records.length,
      ...streaming.trace,
    },
    scrolling,
    coldMs: cold,
    cachedMs: cached,
  };
  await writeFile(info.outputPath('timings.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  expect(streaming.result).toBeGreaterThanOrEqual(60_000 * SCALE);
  expect(result.streaming.measuredTokensPerSecond).toBeGreaterThanOrEqual(100);
  expect(streaming.trace.frameWorkMs.count).toBeGreaterThan(60 * SCALE);
  expect(streaming.trace.longTasksMs).toEqual([]);
  expect(streaming.trace.frameWorkMs.p99).toBeLessThanOrEqual(12);
  expect(scrolling.distancePx).toBeGreaterThan(28_000);
  // 59.997 Hz and 60.0 Hz both describe nominal 60 Hz displays.
  expect(Math.round(scrolling.fps)).toBeGreaterThanOrEqual(60);
  expect(summarize(cold).max).toBeLessThanOrEqual(170);
  expect(summarize(cached).max).toBeLessThanOrEqual(100);
});
