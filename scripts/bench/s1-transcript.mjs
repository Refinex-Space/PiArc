// S1 benchmark (T09): the transcript prototype in the running Electron app.
//
//   npm run bench:s1 -- [--form packaged|dev] [--seconds 60] [--tps 100] [--scroll-seconds 10]
//                       [--cold-runs 5] [--out <file.json>]
//
// Needs `npm run package:desktop -- --flavor development` first. It opens `#/transcript-lab` and
// measures, against architecture chapter 11 (T09 ran the same set on both virtual-list
// candidates, commit 0387545; ADR-0022):
//
// 1. streaming: `--tps` token/s for `--seconds` after 100 history items. A Chrome trace of the
//    window's renderer gives the main thread's frame times (`AnimationFrame`, the same span as a
//    Long Animation Frame entry: first task of the frame to the end of rendering), tasks over
//    50 ms, and how many frames the compositor presented or dropped; the page also records its
//    animation-frame intervals;
// 2. scrolling: 10,000 items, scrolled up programmatically at 3,000 px/s for `--scroll-seconds`;
//    frame rate from the page's animation frames, plus the trace figures above;
// 3. cold load: `--cold-runs` fresh loads of the page, each loading 1,000 items, timed from the
//    data entering the store to the first painted frame with every visible row parsed;
// 4. memory: in a fresh app, the renderer's working set (`app.getAppMetrics()`) after a garbage
//    collection, with the page empty and with 1,000 items open.
//
// Writes JSON (default tmp/evidence/T09/bench/) and prints a summary. The numbers are reported,
// not asserted: they depend on the machine (see docs/spikes/S01-transcript-composer.md).
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { _electron as electron } from '@playwright/test';

import { isMain, isRecord, repoRoot } from '../lib/repo.mjs';
import { percentile } from './s2-event-channel.mjs';

/**
 * @typedef {import('@playwright/test').ElectronApplication} ElectronApplication
 * @typedef {import('@playwright/test').Page} Page
 * @typedef {import('@playwright/test').CDPSession} CDPSession
 * @typedef {import('../../apps/desktop/src/shared/transcript-lab.js').FrameRecording} FrameRecording
 */

const desktopDir = path.join(repoRoot, 'apps', 'desktop');
const LAB_HASH = '#/transcript-lab';
const LONG_TASK_MS = 50;
const MIB_PER_KIB = 1 / 1024;

/** Trace categories for frame timing, tasks and compositor frame states. */
const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'toplevel',
];

/** @param {readonly number[]} values */
export function summarize(values) {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length === 0 ? Number.NaN : Math.max(...values),
  };
}

/**
 * The renderer main thread's frames and tasks, and the compositor's frame states, of process
 * `pid` in a Chrome trace (JSON trace event format).
 * @param {readonly unknown[]} events
 * @param {number} pid
 */
export function analyzeTrace(events, pid) {
  /** @type {Map<number, string>} */
  const threadNames = new Map();
  for (const event of events) {
    if (
      isRecord(event) &&
      event.ph === 'M' &&
      event.name === 'thread_name' &&
      event.pid === pid &&
      typeof event.tid === 'number' &&
      isRecord(event.args) &&
      typeof event.args.name === 'string'
    ) {
      threadNames.set(event.tid, event.args.name);
    }
  }
  /** @type {number[]} */
  const longTasks = [];
  /** @type {{ start: number, end: number }[]} */
  const mainTasks = [];
  /** @type {number[]} */
  const frameBegins = [];
  /** @type {Map<string, number>} */
  const frameStarts = new Map();
  /** @type {number[]} */
  const frameTimes = [];
  /** @type {Record<string, number>} */
  const frameStates = {};
  let busyUs = 0;
  for (const event of events) {
    if (!isRecord(event) || event.pid !== pid || typeof event.tid !== 'number') {
      continue;
    }
    const main = threadNames.get(event.tid) === 'CrRendererMain';
    if (
      main &&
      event.name === 'RunTask' &&
      event.ph === 'X' &&
      typeof event.dur === 'number' &&
      typeof event.ts === 'number'
    ) {
      busyUs += event.dur;
      mainTasks.push({ start: event.ts, end: event.ts + event.dur });
      if (event.dur / 1000 > LONG_TASK_MS) {
        longTasks.push(event.dur / 1000);
      }
    }
    if (main && event.name === 'BeginMainThreadFrame' && typeof event.ts === 'number') {
      frameBegins.push(event.ts);
    }
    if (main && event.name === 'AnimationFrame' && typeof event.ts === 'number') {
      const id = JSON.stringify(event.id ?? event.id2 ?? '');
      if (event.ph === 'b') {
        frameStarts.set(id, event.ts);
      } else if (event.ph === 'e') {
        const start = frameStarts.get(id);
        if (start !== undefined) {
          frameTimes.push((event.ts - start) / 1000);
          frameStarts.delete(id);
        }
      }
    }
    if (event.name === 'PipelineReporter' && event.ph === 'b' && isRecord(event.args)) {
      const reporter = event.args.frame_reporter;
      const state = isRecord(reporter) && typeof reporter.state === 'string' ? reporter.state : '?';
      frameStates[state] = (frameStates[state] ?? 0) + 1;
    }
  }
  // Main-thread work per frame: the time the main thread spent in tasks between one
  // BeginMainThreadFrame and the next. Over 16 ms means that frame could not keep 60 fps.
  frameBegins.sort((a, b) => a - b);
  mainTasks.sort((a, b) => a.start - b.start);
  /** @type {number[]} */
  const frameWork = [];
  let first = 0;
  for (let index = 0; index + 1 < frameBegins.length; index += 1) {
    const from = frameBegins[index] ?? 0;
    const to = frameBegins[index + 1] ?? 0;
    let work = 0;
    while (first < mainTasks.length && (mainTasks[first]?.end ?? 0) <= from) {
      first += 1;
    }
    for (let task = first; task < mainTasks.length; task += 1) {
      const current = mainTasks[task];
      if (current === undefined || current.start >= to) {
        break;
      }
      work += Math.max(0, Math.min(current.end, to) - Math.max(current.start, from));
    }
    frameWork.push(work / 1000);
  }
  return {
    frameWorkMs: summarize(frameWork),
    framesWorkOver16Ms: frameWork.filter((time) => time > 16).length,
    /** LoAF-style frame durations (first task of the frame to the end of rendering). */
    animationFrameMs: summarize(frameTimes),
    longTasksMs: longTasks,
    mainThreadBusyMs: busyUs / 1000,
    compositorFrames: frameStates,
  };
}

/** @param {FrameRecording} recording */
export function summarizeFrames(recording) {
  const seconds = recording.durationMs / 1000;
  const vsync = percentile(recording.intervals, 50);
  return {
    seconds,
    frames: recording.intervals.length + 1,
    fps: (recording.intervals.length + 1) / seconds,
    intervalMs: summarize(recording.intervals),
    /** Intervals longer than one and a half display frames: at least one frame missed. */
    missedFrames: recording.intervals.filter((interval) => interval > vsync * 1.5).length,
    longTasksMs: recording.longTasks,
    longAnimationFramesMs: recording.longAnimationFrames,
  };
}

/**
 * The command that starts the app in `form`.
 * @param {'dev' | 'packaged'} form
 * @param {string[]} args
 */
export async function appCommand(form, args) {
  if (form === 'dev') {
    /** @type {unknown} */
    const binary = createRequire(path.join(desktopDir, 'package.json'))('electron');
    if (typeof binary !== 'string' || !existsSync(path.join(desktopDir, '.vite', 'build'))) {
      throw new Error('Run npm run package:desktop -- --flavor development first');
    }
    return { command: binary, args: [desktopDir, ...args] };
  }
  /** @type {unknown} */
  const manifest = JSON.parse(await readFile(path.join(desktopDir, 'package.json'), 'utf8'));
  const name =
    isRecord(manifest) && typeof manifest.productName === 'string' ? manifest.productName : 'PiArc';
  const appDir = path.join(
    desktopDir,
    'out',
    'development',
    `${name}-${process.platform}-${process.arch}`,
  );
  const command =
    process.platform === 'darwin'
      ? path.join(appDir, `${name}.app`, 'Contents', 'MacOS', name)
      : path.join(appDir, `${name}.exe`);
  if (!existsSync(command)) {
    throw new Error(`${command} is missing; run npm run package:desktop -- --flavor development`);
  }
  return { command, args };
}

/**
 * Loads the prototype page freshly (a reload drops the workers and their caches).
 * @param {Page} page
 */
async function openLab(page) {
  const base = page.url().split('#')[0] ?? page.url();
  await page.goto(`${base}${LAB_HASH}`);
  await page.reload();
  await page.getByTestId('transcript-lab').waitFor();
  await page.waitForFunction(() => globalThis.__piarcTranscriptLab !== undefined);
}

/**
 * Runs `body` while a Chrome trace records the page's renderer, then analyzes it.
 * @template T
 * @param {Page} page
 * @param {number} pid
 * @param {() => Promise<T>} body
 */
export async function traced(page, pid, body) {
  const cdp = await page.context().newCDPSession(page);
  /** @type {Promise<unknown>} */
  const complete = new Promise((resolve) => {
    cdp.once('Tracing.tracingComplete', resolve);
  });
  await cdp.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    streamFormat: 'json',
    traceConfig: { includedCategories: TRACE_CATEGORIES },
  });
  const result = await body();
  await cdp.send('Tracing.end');
  const done = await complete;
  const stream = isRecord(done) && typeof done.stream === 'string' ? done.stream : undefined;
  if (stream === undefined) {
    throw new Error('the trace has no stream');
  }
  /** @type {string[]} */
  const chunks = [];
  for (;;) {
    const chunk = await cdp.send('IO.read', { handle: stream });
    chunks.push(
      chunk.base64Encoded === true ? Buffer.from(chunk.data, 'base64').toString() : chunk.data,
    );
    if (chunk.eof) {
      break;
    }
  }
  await cdp.send('IO.close', { handle: stream });
  await cdp.detach();
  /** @type {unknown} */
  const trace = JSON.parse(chunks.join(''));
  const events = Array.isArray(trace)
    ? trace
    : isRecord(trace) && Array.isArray(trace.traceEvents)
      ? trace.traceEvents
      : [];
  return { result, trace: analyzeTrace(events, pid) };
}

/**
 * The window's renderer process id and its memory, and the sum over all app processes (MiB).
 * @param {ElectronApplication} app
 */
async function memory(app) {
  return app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const pid = window?.webContents.getOSProcessId();
    const metrics = electronApp.getAppMetrics();
    const renderer = metrics.find((metric) => metric.pid === pid);
    return {
      rendererWorkingSetKiB: renderer?.memory.workingSetSize ?? Number.NaN,
      rendererPeakKiB: renderer?.memory.peakWorkingSetSize ?? Number.NaN,
      allProcessesKiB: metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0),
      processes: metrics.map((metric) => ({
        type: metric.type,
        workingSetKiB: metric.memory.workingSetSize,
      })),
    };
  });
}

/**
 * @param {Page} page
 * @param {() => Promise<void>} body
 */
async function framesDuring(page, body) {
  await page.evaluate(() => {
    globalThis.__piarcTranscriptLab?.startFrames();
  });
  await body();
  const recording = await page.evaluate(() => globalThis.__piarcTranscriptLab?.stopFrames());
  if (recording === undefined) {
    throw new Error('not the transcript prototype page');
  }
  return summarizeFrames(recording);
}

/**
 * @param {{ form: 'dev' | 'packaged', seconds: number, tps: number, scrollSeconds: number,
 *   coldRuns: number }} options
 */
async function measureTiming(options) {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'piarc-s1-'));
  const { command, args } = await appCommand(options.form, [`--user-data-dir=${userDataDir}`]);
  const app = await electron.launch({ executablePath: command, args });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('app-shell').waitFor();
    // Same window size and display for every run; the display's refresh rate sets the frame
    // interval the page sees.
    const window = await app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win === undefined) {
        throw new Error('no window');
      }
      win.setContentSize(1280, 800);
      const display = screen.getDisplayMatching(win.getBounds());
      return {
        contentSize: win.getContentSize(),
        scaleFactor: display.scaleFactor,
        displayFrequencyHz: display.displayFrequency,
      };
    });
    const pid = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId() ?? -1,
    );
    await openLab(page);
    console.log(`warming up`);
    await page.evaluate(async () => {
      const api = globalThis.__piarcTranscriptLab;
      if (api === undefined) {
        throw new Error('not the transcript prototype page');
      }
      const id = await api.addMessage(
        '```ts\nconst warm = true;\n```\n\n```rust\nfn main() {}\n```',
      );
      await api.settled(id);
      await api.streamTurn({ tokensPerSecond: 200, seconds: 3 });
      api.clear();
    });

    console.log(`streaming ${String(options.tps)} token/s for ${String(options.seconds)} s`);
    await page.evaluate(async () => {
      await globalThis.__piarcTranscriptLab?.loadHistory(100);
    });
    const streaming = await traced(page, pid, () =>
      framesDuring(page, async () => {
        await page.evaluate(
          async ({ tps, seconds }) => {
            await globalThis.__piarcTranscriptLab?.streamTurn({ tokensPerSecond: tps, seconds });
          },
          { tps: options.tps, seconds: options.seconds },
        );
      }),
    );

    console.log(`scrolling 10,000 items for ${String(options.scrollSeconds)} s`);
    await page.evaluate(async () => {
      const api = globalThis.__piarcTranscriptLab;
      api?.clear();
      await api?.loadHistory(10_000);
    });
    await page.waitForTimeout(1_000);
    let scrolledPx = 0;
    const scrolling = await traced(page, pid, () =>
      framesDuring(page, async () => {
        scrolledPx = await page.evaluate(async (seconds) => {
          const result = await globalThis.__piarcTranscriptLab?.autoScroll({
            pxPerSecond: 3_000,
            durationMs: seconds * 1000,
            direction: 'up',
          });
          return result?.distancePx ?? 0;
        }, options.scrollSeconds);
      }),
    );

    console.log(`cold loads of 1,000 items`);
    /** @type {number[]} */
    const coldMs = [];
    for (let run = 0; run < options.coldRuns; run += 1) {
      await openLab(page);
      const load = await page.evaluate(async () =>
        globalThis.__piarcTranscriptLab?.loadHistory(1_000),
      );
      if (load === undefined) {
        throw new Error('not the transcript prototype page');
      }
      coldMs.push(load.readyToVisibleMs);
    }
    return { window, streaming, scrolling, scrolledPx, coldMs };
  } finally {
    await app.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

/**
 * Renderer memory of a fresh app with the prototype page holding `items` items, after a
 * garbage collection.
 * @param {'dev' | 'packaged'} form
 * @param {number} items
 */
async function measureMemory(form, items) {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'piarc-s1-'));
  const { command, args } = await appCommand(form, [`--user-data-dir=${userDataDir}`]);
  const app = await electron.launch({ executablePath: command, args });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('app-shell').waitFor();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800);
    });
    await openLab(page);
    if (items > 0) {
      await page.evaluate(async (count) => {
        await globalThis.__piarcTranscriptLab?.loadHistory(count);
      }, items);
    }
    await page.waitForTimeout(3_000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.detach();
    await page.waitForTimeout(1_000);
    const sample = await memory(app);
    return {
      rendererWorkingSetMiB: sample.rendererWorkingSetKiB * MIB_PER_KIB,
      allProcessesMiB: sample.allProcessesKiB * MIB_PER_KIB,
      processes: sample.processes.map((entry) => ({
        type: entry.type,
        workingSetMiB: entry.workingSetKiB * MIB_PER_KIB,
      })),
    };
  } finally {
    await app.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

/**
 * @param {{ form: 'dev' | 'packaged', seconds: number, tps: number, scrollSeconds: number,
 *   coldRuns: number }} options
 */
async function measureAll(options) {
  const timing = await measureTiming(options);
  console.log('memory: empty page, then 1,000 items');
  const empty = await measureMemory(options.form, 0);
  const with1000 = await measureMemory(options.form, 1_000);
  return {
    window: timing.window,
    streaming: { frames: timing.streaming.result, trace: timing.streaming.trace },
    scrolling: {
      scrolledPx: timing.scrolledPx,
      frames: timing.scrolling.result,
      trace: timing.scrolling.trace,
    },
    coldLoad1000Ms: { runs: timing.coldMs, ...summarize(timing.coldMs) },
    memoryEmptyPage: empty,
    memoryWith1000Items: with1000,
  };
}

/** @param {number} value */
function ms(value) {
  return Number.isNaN(value) ? '—' : `${value.toFixed(1)} ms`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      form: { type: 'string', default: 'packaged' },
      seconds: { type: 'string', default: '60' },
      tps: { type: 'string', default: '100' },
      'scroll-seconds': { type: 'string', default: '10' },
      'cold-runs': { type: 'string', default: '5' },
      out: { type: 'string' },
    },
  });
  const form = values.form === 'dev' ? 'dev' : 'packaged';
  const result = await measureAll({
    form,
    seconds: Number(values.seconds),
    tps: Number(values.tps),
    scrollSeconds: Number(values['scroll-seconds']),
    coldRuns: Number(values['cold-runs']),
  });
  const report = {
    date: new Date().toISOString(),
    machine: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cpus: os.cpus().length,
      memoryGiB: os.totalmem() / 1024 ** 3,
    },
    form,
    settings: values,
    result,
  };
  const out =
    values.out ??
    path.join(repoRoot, 'tmp', 'evidence', 'T09', 'bench', `s1-${form}-${String(Date.now())}.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`\nS1 transcript benchmark (${form}, ${report.machine.cpu}, ${os.release()})`);
  const { streaming, scrolling } = result;
  console.log(
    `  streaming: frame work p50 ${ms(streaming.trace.frameWorkMs.p50)}, p99 ${ms(streaming.trace.frameWorkMs.p99)}, max ${ms(streaming.trace.frameWorkMs.max)}; ` +
      `tasks > 50 ms: ${String(streaming.trace.longTasksMs.length)}; frame interval p99 ${ms(streaming.frames.intervalMs.p99)}, missed ${String(streaming.frames.missedFrames)}`,
  );
  console.log(
    `  scrolling: ${scrolling.frames.fps.toFixed(1)} fps over ${String(Math.round(scrolling.scrolledPx))} px; frame work p99 ${ms(scrolling.trace.frameWorkMs.p99)}; ` +
      `tasks > 50 ms: ${String(scrolling.trace.longTasksMs.length)}; missed ${String(scrolling.frames.missedFrames)}`,
  );
  console.log(
    `  cold load 1,000: median ${ms(result.coldLoad1000Ms.p50)}, max ${ms(result.coldLoad1000Ms.max)}`,
  );
  console.log(
    `  renderer memory: ${result.memoryWith1000Items.rendererWorkingSetMiB.toFixed(0)} MiB with 1,000 items, ${result.memoryEmptyPage.rendererWorkingSetMiB.toFixed(0)} MiB empty (all processes ${result.memoryWith1000Items.allProcessesMiB.toFixed(0)} MiB)`,
  );
  console.log(`\nWrote ${out}`);
}

if (isMain(import.meta.url)) {
  await main();
}
