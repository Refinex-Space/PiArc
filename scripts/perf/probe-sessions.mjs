// T44 probe: the Agent Host's memory with one, two and three sessions running mock turns
// (each streams text and calls Read), and the main process's event-loop delay while all three
// stream (architecture chapter 11). The Agent Host's size is its resident set (`ps` / CIM); the
// loop delay is the development build's `monitorEventLoopDelay` hook at 1 ms. Where the timer
// granularity is coarser than 1 ms (Windows, about 15.6 ms), chapter 11 compares the loaded p99
// minus the idle p99 of the same run, which is measured first.
//
//   node scripts/perf/probe-sessions.mjs --form packaged --lane pr|nightly --out <file.json>
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { isMain } from '../lib/repo.mjs';
import {
  appSnapshot,
  launchApp,
  MB,
  openWorkspace,
  requestCounts,
  seedModels,
  sleep,
  startMock,
  startSession,
  stats,
} from './lib.mjs';

const SESSIONS = ['perf-one', 'perf-two', 'perf-three'];

/**
 * A long turn: each step streams text and then reads a file.
 * @param {string} id
 */
function scenario(id) {
  const text = (/** @type {number} */ i) =>
    `Step ${String(i)} of ${id}: reading the project and noting what it found. `.repeat(8);
  return {
    id,
    steps: [
      ...Array.from({ length: 200 }, (_, i) => ({
        text: text(i),
        chunk_chars: 12,
        chunk_delay_ms: 30,
        tool_calls: [{ id: `${id}-${String(i)}`, name: 'Read', input: { path: 'src/lib.txt' } }],
      })),
      { text: `Done with ${id}.` },
    ],
  };
}

/**
 * Waits until every session in `ids` asked the model at least twice.
 * @param {string} baseUrl
 * @param {readonly string[]} ids
 */
async function underway(baseUrl, ids) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const counts = await requestCounts(baseUrl);
    if (ids.every((id) => (counts[id] ?? 0) >= 2)) return;
    if (Date.now() > deadline) throw new Error(`sessions did not start: ${JSON.stringify(counts)}`);
    await sleep(250);
  }
}

/**
 * @param {import('@playwright/test').ElectronApplication} app
 * @param {number} ms
 */
async function loopDelay(app, ms) {
  await app.evaluate(() => {
    globalThis.__piarcTestHooks?.startLoopDelay();
  });
  await sleep(ms);
  const summary = await app.evaluate(() => globalThis.__piarcTestHooks?.stopLoopDelay());
  if (summary === undefined) throw new Error('the development build has no loop delay hook');
  return summary;
}

/**
 * A fresh app with `count` sessions running: the Agent Host's median resident size over the
 * window, and (for `withLoop`) the main process's loop delay idle and loaded.
 * @param {{ form: 'packaged' | 'dev', count: number, warmup: number, window: number, withLoop: boolean }} options
 */
async function run(options) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'piarc perf 会话 ')));
  const userData = path.join(root, 'data');
  const workspace = path.join(root, 'work 工作区');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(
    path.join(workspace, 'src', 'lib.txt'),
    Array.from({ length: 400 }, (_, i) => `line ${String(i)} of the library`).join('\n'),
  );
  const scenarios = path.join(root, 'scenarios');
  await mkdir(scenarios);
  for (const id of SESSIONS) {
    await writeFile(path.join(scenarios, `${id}.json`), JSON.stringify(scenario(id)));
  }
  const mock = await startMock(scenarios);
  await seedModels(userData, mock.baseUrl);
  const { app, page } = await launchApp(options.form, userData);
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800);
    });
    await openWorkspace(app, page, workspace);
    const mainPid = await app.evaluate(() => process.pid);
    await sleep(2000);
    const idle = options.withLoop ? await loopDelay(app, options.window) : undefined;
    const ids = SESSIONS.slice(0, options.count);
    for (const [i, id] of ids.entries()) await startSession(page, id, { trust: i === 0 });
    await underway(mock.baseUrl, ids);
    await sleep(options.warmup);
    /** @type {number[]} */
    const samples = [];
    const sampling = (async () => {
      const end = Date.now() + options.window;
      while (Date.now() < end) {
        samples.push((await appSnapshot(app, mainPid)).agentHostBytes / MB);
        await sleep(1000);
      }
    })();
    const loaded = options.withLoop ? await loopDelay(app, options.window) : undefined;
    await sampling;
    return { hostMB: stats(samples).median, samples: samples.length, idle, loaded };
  } finally {
    await app.close().catch(() => undefined);
    mock.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/**
 * One app per session count, so each count starts from the same state (garbage from an
 * earlier count would otherwise make later counts look smaller). The PR smoke measures only
 * the three-session app, for the loop delay.
 * @param {{ form: 'packaged' | 'dev', lane: string }} options
 */
export async function measure(options) {
  const pr = options.lane === 'pr';
  const timing = { warmup: pr ? 4000 : 15_000, window: pr ? 8000 : 20_000 };
  const three = await run({ ...options, ...timing, count: 3, withLoop: true });
  const { idle, loaded } = three;
  if (idle === undefined || loaded === undefined) throw new Error('no loop delay');
  const loop = process.platform === 'win32' ? loaded.p99 - idle.p99 : loaded.p99;
  if (pr) {
    return {
      values: { 'main-loop-p99': loop },
      samples: loaded.samples,
      detail: { loopDelayMs: { idle, loaded } },
    };
  }
  const one = await run({ ...options, ...timing, count: 1, withLoop: false });
  return {
    values: {
      'agent-host-memory': one.hostMB,
      'agent-host-per-session': (three.hostMB - one.hostMB) / 2,
      'main-loop-p99': loop,
    },
    samples: one.samples + three.samples,
    detail: {
      agentHostMB: { one: one.hostMB, three: three.hostMB },
      loopDelayMs: { idle, loaded },
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      form: { type: 'string', default: 'packaged' },
      lane: { type: 'string', default: 'nightly' },
      out: { type: 'string' },
    },
  });
  const result = await measure({
    form: values.form === 'dev' ? 'dev' : 'packaged',
    lane: values.lane,
  });
  console.log(JSON.stringify(result, null, 2));
  if (values.out !== undefined) {
    await mkdir(path.dirname(values.out), { recursive: true });
    await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
  }
}

if (isMain(import.meta.url)) await main();
