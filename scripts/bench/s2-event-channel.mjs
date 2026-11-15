// S2 benchmark (T04): the Core event channel in the running Electron app.
//
//   npm run bench:s2 -- [--minutes 5] [--per-minute 100000] [--pad 160] [--form dev|packaged]
//                       [--out <file.json>]
//
// Runs the app with a development build of Core (`npm run package:desktop -- --flavor
// development` first) and measures, in this order:
//
// 1. idle RSS of the main process (which hosts Core), against the 120 MB budget;
// 2. the synchronous NAPI call `echo`: 10,000 calls after 1,000 warm-up calls;
// 3. throughput: a demo source emits `--per-minute` events a minute for `--minutes` into a
//    probe window; the window must receive every event in order. Meanwhile the main
//    process's event-loop delay (`monitorEventLoopDelay`) and the time it spends forwarding
//    each delivery are recorded;
// 4. large batches of about 1, 4 and 8 MiB: forwarding time and event-loop delay.
//
// Writes the results as JSON (default tmp/evidence/T04/bench/) and prints a summary. Exit
// code 1 when an event was lost or reordered; the performance numbers are reported, not
// asserted (machines differ; see docs/spikes/S02-napi-event-channel.md).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { _electron as electron } from '@playwright/test';

import { capture, isMain, isRecord, repoRoot } from '../lib/repo.mjs';

/**
 * @typedef {import('@playwright/test').ElectronApplication} ElectronApplication
 * @typedef {import('@playwright/test').Page} Page
 * @typedef {import('../../apps/desktop/src/shared/test-hooks.js').LoopDelaySummary} LoopDelaySummary
 * @typedef {import('../../apps/desktop/src/shared/test-hooks.js').ForwardObservation} ForwardObservation
 * @typedef {import('../../apps/desktop/src/shared/event-probe.js').RouteSnapshot} RouteSnapshot
 */

const desktopDir = path.join(repoRoot, 'apps', 'desktop');
const LARGE_BATCH_SIZES = [1024 * 1024, 4 * 1024 * 1024, 8 * 1024 * 1024];
const MIB = 1024 * 1024;

/**
 * Percentile `q` (0-100) of `values`, nearest-rank.
 * @param {readonly number[]} values
 * @param {number} q
 */
export function percentile(values, q) {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((q / 100) * sorted.length));
  return sorted[rank - 1] ?? Number.NaN;
}

/** @param {readonly number[]} values */
function summarize(values) {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length === 0 ? Number.NaN : Math.max(...values),
  };
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The command that starts the app in `form`.
 * @param {'dev' | 'packaged'} form
 * @param {string[]} args
 */
async function appCommand(form, args) {
  if (form === 'dev') {
    const bundle = path.join(desktopDir, '.vite', 'build', 'main.cjs');
    if (!existsSync(bundle)) {
      throw new Error(`${bundle} is missing; run npm run package:desktop -- --flavor development`);
    }
    /** @type {unknown} */
    const binary = createRequire(path.join(desktopDir, 'package.json'))('electron');
    if (typeof binary !== 'string') {
      throw new Error('the electron package did not resolve to an executable');
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

/** @param {ElectronApplication} app */
async function mainRssMb(app) {
  return (await app.evaluate(() => process.memoryUsage().rss)) / MIB;
}

/** @param {ElectronApplication} app */
async function openProbe(app) {
  const created = app.waitForEvent('window');
  await app.evaluate(async () => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) {
      throw new Error('no Core test hooks: the app did not load a development build of Core');
    }
    return hooks.openWindow('#/event-probe');
  });
  const page = await created;
  await page.getByTestId('event-probe').waitFor();
  return page;
}

/**
 * @param {Page} page
 * @param {string} route
 * @returns {Promise<RouteSnapshot | undefined>}
 */
async function routeSnapshot(page, route) {
  const snapshot = await page.evaluate(() => {
    const probe = globalThis.__piarcEventProbe;
    if (probe === undefined) {
      throw new Error('not a probe page');
    }
    return probe.snapshot();
  });
  return snapshot.routes[route];
}

/**
 * Waits until `route` has `events` events or `timeoutMs` passes.
 * @param {Page} page
 * @param {string} route
 * @param {number} events
 * @param {number} timeoutMs
 * @param {(seen: number) => void} [progress]
 */
async function waitForRoute(page, route, events, timeoutMs, progress) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await routeSnapshot(page, route);
    const seen = current?.events ?? 0;
    progress?.(seen);
    if (current !== undefined && seen >= events) {
      return current;
    }
    if (Date.now() > deadline) {
      throw new Error(`route ${route}: ${String(seen)} of ${String(events)} events in time`);
    }
    await sleep(2_000);
  }
}

/**
 * Resident memory of process `pid` in MB, read from outside the process.
 * @param {number} pid
 */
async function processRssMb(pid) {
  if (process.platform === 'win32') {
    const bytes = await capture('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-Process -Id ${String(pid)}).WorkingSet64`,
    ]);
    return Number(bytes.trim()) / MIB;
  }
  const kb = await capture('ps', ['-o', 'rss=', '-p', String(pid)]);
  return Number(kb.trim()) / 1024;
}

/**
 * Starts `command` without Playwright (no inspector attached), lets it settle and samples
 * the main process's resident memory.
 * @param {string} command
 * @param {string[]} args
 */
async function idleRss(command, args) {
  const child = spawn(command, args, { stdio: 'ignore' });
  try {
    if (child.pid === undefined) {
      throw new Error(`${command} did not start`);
    }
    await sleep(10_000);
    const samples = [];
    for (let i = 0; i < 5; i += 1) {
      samples.push(await processRssMb(child.pid));
      await sleep(1_000);
    }
    return { median: percentile(samples, 50), max: Math.max(...samples) };
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve(undefined);
      } else {
        child.once('exit', resolve);
      }
    });
  }
}

/**
 * Idle main-process memory of PiArc (with Core) and, for comparison, of a bare Electron app
 * that opens one window and nothing else.
 * @param {'dev' | 'packaged'} form
 */
async function measureIdle(form) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'piarc bench idle-'));
  try {
    const piarc = await appCommand(form, [`--user-data-dir=${path.join(scratch, 'piarc')}`]);
    const withCore = await idleRss(piarc.command, piarc.args);
    const bare = path.join(scratch, 'bare');
    await mkdir(bare);
    await writeFile(path.join(bare, 'package.json'), '{"name":"bare","main":"main.cjs"}\n');
    await writeFile(
      path.join(bare, 'main.cjs'),
      "const { app, BrowserWindow } = require('electron');\n" +
        "app.whenReady().then(() => new BrowserWindow({ webPreferences: { sandbox: true } }).loadURL('data:text/html,bare'));\n",
    );
    const electronBinary = (await appCommand('dev', [])).command;
    const bareElectron = await idleRss(electronBinary, [
      bare,
      `--user-data-dir=${path.join(scratch, 'bare-data')}`,
    ]);
    return { mainRssMb: withCore, bareElectronMainRssMb: bareElectron };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** @param {ElectronApplication} app */
async function measureSyncCalls(app) {
  const durations = await app.evaluate(() => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) {
      throw new Error('no Core test hooks');
    }
    const payload = 'x'.repeat(64);
    hooks.measureEcho('bench-echo', payload, 1_000);
    return hooks.measureEcho('bench-echo', payload, 10_000);
  });
  return summarize(durations);
}

/**
 * @param {ElectronApplication} app
 * @param {Page} page
 * @param {{ perMinute: number, minutes: number, pad: number }} options
 */
async function measureThroughput(app, page, options) {
  const route = 'bench';
  const total = Math.round(options.perMinute * options.minutes);
  await page.evaluate(async (r) => {
    await globalThis.__piarcEventProbe?.subscribe([r]);
  }, route);
  const routerBefore = await app.evaluate(() => globalThis.__piarcTestHooks?.routerStats());
  await app.evaluate(() => {
    globalThis.__piarcTestHooks?.startLoopDelay();
    globalThis.__piarcTestHooks?.startForwardTimings();
  });
  const started = Date.now();
  const id = await app.evaluate(
    (_electron, demo) => {
      const hooks = globalThis.__piarcTestHooks;
      if (hooks === undefined) {
        throw new Error('no Core test hooks');
      }
      return hooks.core.startDemoSource(demo);
    },
    { route, eventsPerSecond: options.perMinute / 60, maxEvents: total, padBytes: options.pad },
  );
  const rss = [];
  let lastReport = 0;
  const received = await waitForRoute(
    page,
    route,
    total,
    options.minutes * 60_000 + 60_000,
    (seen) => {
      if (Date.now() - lastReport > 30_000) {
        lastReport = Date.now();
        console.log(`  ${String(seen)} of ${String(total)} events received`);
      }
    },
  );
  const durationS = (Date.now() - started) / 1000;
  rss.push(await mainRssMb(app));
  const loopDelay = await app.evaluate(() => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) {
      throw new Error('no Core test hooks');
    }
    return hooks.stopLoopDelay();
  });
  /** @type {ForwardObservation[]} */
  const forwards = await app.evaluate(
    () => globalThis.__piarcTestHooks?.stopForwardTimings() ?? [],
  );
  const report = await app.evaluate(async (_electron, source) => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) {
      throw new Error('no Core test hooks');
    }
    return { demo: await hooks.core.stopDemoSource(source), stats: hooks.core.eventStats() };
  }, id);
  const routerAfter = await app.evaluate(() => globalThis.__piarcTestHooks?.routerStats());
  const callbacks = (routerAfter?.deliveries ?? 0) - (routerBefore?.deliveries ?? 0);
  return {
    route,
    target: total,
    emitted: report.demo.emitted,
    received: received.events,
    batches: received.batches,
    eventsPerBatch: received.events / received.batches,
    callbacks,
    callbacksPerSecond: callbacks / durationS,
    batchSeqErrors: received.batchSeqErrors,
    eventSeqErrors: received.eventSeqErrors,
    malformedBatches: received.malformedBatches,
    lostInCore: report.stats.lost,
    durationS,
    // Read through Playwright, so the inspector session is included.
    mainRssMbAfterLoadWithInspector: rss[0],
    loopDelay,
    forwardMs: summarize(forwards.map((f) => f.durationMs)),
  };
}

/**
 * @param {ElectronApplication} app
 * @param {Page} page
 */
async function measureLargeBatches(app, page) {
  const results = [];
  for (const size of LARGE_BATCH_SIZES) {
    const route = `bench-large-${String(size / MIB)}mib`;
    const count = 15;
    await page.evaluate(async (r) => {
      await globalThis.__piarcEventProbe?.subscribe([r]);
    }, route);
    await app.evaluate(() => {
      globalThis.__piarcTestHooks?.startLoopDelay();
      globalThis.__piarcTestHooks?.startForwardTimings();
    });
    await app.evaluate(
      (_electron, demo) => {
        const hooks = globalThis.__piarcTestHooks;
        if (hooks === undefined) {
          throw new Error('no Core test hooks');
        }
        return hooks.core.startDemoSource(demo);
      },
      { route, eventsPerSecond: 5, maxEvents: count, padBytes: size },
    );
    const received = await waitForRoute(page, route, count, 60_000);
    const loopDelay = await app.evaluate(() => {
      const hooks = globalThis.__piarcTestHooks;
      if (hooks === undefined) {
        throw new Error('no Core test hooks');
      }
      return hooks.stopLoopDelay();
    });
    /** @type {ForwardObservation[]} */
    const forwards = await app.evaluate(
      () => globalThis.__piarcTestHooks?.stopForwardTimings() ?? [],
    );
    const large = forwards.filter((f) => f.largestBatchBytes >= MIB);
    results.push({
      padBytes: size,
      batches: large.length,
      largestBatchMb: Math.max(...large.map((f) => f.largestBatchBytes)) / MIB,
      forwardMs: summarize(large.map((f) => f.durationMs)),
      complete:
        received.events === count && received.eventSeqErrors === 0 && received.batchSeqErrors === 0,
      loopDelay,
    });
  }
  return results;
}

async function main() {
  const { values } = parseArgs({
    options: {
      minutes: { type: 'string', default: '5' },
      'per-minute': { type: 'string', default: '100000' },
      pad: { type: 'string', default: '160' },
      form: { type: 'string', default: 'dev' },
      out: { type: 'string' },
    },
  });
  const minutes = Number(values.minutes);
  const perMinute = Number(values['per-minute']);
  const pad = Number(values.pad);
  if (!(minutes > 0) || !(perMinute > 0) || !(pad >= 0)) {
    throw new Error('--minutes and --per-minute must be positive, --pad at least 0');
  }
  if (values.form !== 'dev' && values.form !== 'packaged') {
    throw new Error('--form must be dev or packaged');
  }
  const form = values.form;
  console.log(`S2 benchmark (${form} form)`);
  console.log('1/4 idle memory (app started without an inspector)');
  const idle = await measureIdle(form);
  const userData = await mkdtemp(path.join(os.tmpdir(), 'piarc bench 基准-'));
  const { command, args } = await appCommand(form, [`--user-data-dir=${userData}`]);
  const app = await electron.launch({ executablePath: command, args });
  try {
    const shell = await app.firstWindow();
    await shell.getByTestId('app-shell').waitFor();
    const environment = await app.evaluate(({ app: electronApp }) => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      app: electronApp.getVersion(),
      coreModule: globalThis.__piarcTestHooks?.modulePath ?? '',
      platform: process.platform,
      arch: process.arch,
    }));
    if (environment.coreModule === '') {
      throw new Error('the app has no Core test hooks: package the development flavor first');
    }
    console.log(`Electron ${environment.electron}, ${environment.arch}`);
    console.log('2/4 synchronous calls');
    const syncCall = await measureSyncCalls(app);
    const probe = await openProbe(app);
    console.log(`3/4 throughput: ${String(perMinute)} events/min for ${String(minutes)} min`);
    const throughput = await measureThroughput(app, probe, { perMinute, minutes, pad });
    console.log('4/4 large batches');
    const largeBatches = await measureLargeBatches(app, probe);
    const result = {
      date: new Date().toISOString(),
      form,
      host: {
        cpu: os.cpus()[0]?.model ?? 'unknown',
        cores: os.cpus().length,
        memoryGb: os.totalmem() / 1024 ** 3,
        os: `${os.type()} ${os.release()}`,
      },
      environment: { ...environment, coreModule: path.basename(environment.coreModule) },
      parameters: { minutes, perMinute, padBytes: pad, coalesceIntervalMs: 16 },
      idle,
      syncCall,
      throughput,
      largeBatches,
      verdict: {
        noLoss:
          throughput.received === throughput.emitted &&
          throughput.emitted === throughput.target &&
          throughput.lostInCore === 0,
        ordered:
          throughput.batchSeqErrors === 0 &&
          throughput.eventSeqErrors === 0 &&
          throughput.malformedBatches === 0,
        loopDelayP99WithinBudget: throughput.loopDelay.p99 <= 16,
        syncCallP99WithinBudget: syncCall.p99 <= 1,
        idleRssWithinBudget: idle.mainRssMb.max <= 120,
        callbackRateWithinLimit: throughput.callbacksPerSecond <= (1000 / 16) * 1.1,
        largeBatchesComplete: largeBatches.every((l) => l.complete),
      },
    };
    const out =
      values.out ??
      path.join(
        repoRoot,
        'tmp',
        'evidence',
        'T04',
        'bench',
        `s2-${form}-${result.date.replace(/[:.]/g, '-')}.json`,
      );
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    printSummary(result);
    console.log(`\nresults: ${path.relative(repoRoot, out)}`);
    if (!result.verdict.noLoss || !result.verdict.ordered || !result.verdict.largeBatchesComplete) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
}

/** @param {number} value */
function ms(value) {
  return `${value.toFixed(3)} ms`;
}

/**
 * @param {{ idle: Awaited<ReturnType<typeof measureIdle>>, syncCall: ReturnType<typeof summarize>,
 *   throughput: Awaited<ReturnType<typeof measureThroughput>>,
 *   largeBatches: Awaited<ReturnType<typeof measureLargeBatches>>, verdict: Record<string, boolean> }} r
 */
function printSummary(r) {
  const t = r.throughput;
  console.log('\nS2 summary');
  console.log(
    `  idle main RSS        median ${r.idle.mainRssMb.median.toFixed(1)} MB, max ${r.idle.mainRssMb.max.toFixed(1)} MB (budget 120); ` +
      `bare Electron ${r.idle.bareElectronMainRssMb.median.toFixed(1)} MB`,
  );
  console.log(
    `  sync call (echo)     p50 ${ms(r.syncCall.p50)}, p99 ${ms(r.syncCall.p99)}, max ${ms(r.syncCall.max)} (budget p99 1 ms)`,
  );
  console.log(
    `  events               emitted ${String(t.emitted)}, received ${String(t.received)}, order errors ${String(t.batchSeqErrors + t.eventSeqErrors)}`,
  );
  console.log(
    `  batching             ${String(t.callbacks)} callbacks, ${t.callbacksPerSecond.toFixed(1)}/s, ${t.eventsPerBatch.toFixed(1)} events per batch`,
  );
  console.log(
    `  event-loop delay     p50 ${ms(t.loopDelay.p50)}, p99 ${ms(t.loopDelay.p99)}, max ${ms(t.loopDelay.max)} ` +
      `(sampled every ${String(t.loopDelay.resolutionMs)} ms, included in each value; budget p99 16 ms)`,
  );
  console.log(
    `  forward per delivery p50 ${ms(t.forwardMs.p50)}, p95 ${ms(t.forwardMs.p95)}, p99 ${ms(t.forwardMs.p99)}`,
  );
  for (const l of r.largeBatches) {
    console.log(
      `  large ${l.largestBatchMb.toFixed(1)} MiB batch  forward p50 ${ms(l.forwardMs.p50)}, max ${ms(l.forwardMs.max)}; loop delay p99 ${ms(l.loopDelay.p99)}`,
    );
  }
  console.log(`  verdict              ${JSON.stringify(r.verdict)}`);
}

if (isMain(import.meta.url)) {
  await main();
}
