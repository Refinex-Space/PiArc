// S7 benchmark (T10): the terminal prototype in the running Electron app.
//
//   npm run bench:s7 -- [--form packaged|dev] [--megabytes 100] [--repeat 1]
//                       [--echo-samples 200] [--out <file.json>]
//
// Needs `npm run package:desktop -- --flavor development` first. It opens `#/terminal-lab` and
// measures, against architecture chapter 11 and the S7 criteria (chapter 16):
//
// 1. `cat` of a `--megabytes` MB text file (`--repeat` times in one command, for a sustained
//    run) in a 120 × 40 terminal running /bin/sh: the main
//    process's event-loop delay (`monitorEventLoopDelay`, 1 ms resolution, raw values), a
//    Chrome trace of the window's renderer (main-thread work per frame, tasks over 50 ms), the
//    frames the page received and drew, Core's counters (bytes parsed, time in `vt_write`,
//    frames and their encode time, rows sent and reused), the main process's CPU time, and the
//    bytes of frames the main process forwarded (the IPC traffic);
// 2. typing echo in a terminal running `cat` (the kernel echoes in canonical mode): for each
//    sample, Core writes one byte straight to the PTY and times its echo (`terminalProbeEcho`,
//    the baseline), then the page times a typed key from its `keydown` to the decoded frame that
//    shows it (the full path: renderer → main → Core key encoder → PTY → parser → frame → main →
//    renderer). Extra latency = full − baseline of the same pair.
//
// Writes JSON (default tmp/evidence/T10/bench/) and prints a summary. The numbers are reported,
// not asserted: they depend on the machine (see docs/spikes/S07-terminal.md).
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { _electron as electron } from '@playwright/test';

import { isMain, repoRoot } from '../lib/repo.mjs';
import { appCommand, summarize, traced } from './s1-transcript.mjs';

/**
 * @typedef {import('@playwright/test').ElectronApplication} ElectronApplication
 * @typedef {import('@playwright/test').Page} Page
 * @typedef {import('../../apps/desktop/src/shared/test-hooks.js').TestTerminalOptions} TestTerminalOptions
 * @typedef {import('../../apps/desktop/src/shared/terminal-lab.js').TerminalLabStats} TerminalLabStats
 */

const LAB_HASH = '#/terminal-lab?manual';
const SHELL = { program: '/bin/sh', args: [], env: { PS1: '$ ', ENV: '' } };

/**
 * Writes a text file of `megabytes` MB: numbered log-like lines of printable ASCII.
 * @param {string} file
 * @param {number} megabytes
 */
export async function writeLogFile(file, megabytes) {
  const handle = await open(file, 'w');
  try {
    let line = 0;
    for (let chunk = 0; chunk < megabytes; chunk += 1) {
      /** @type {string[]} */
      const lines = [];
      let size = 0;
      while (size < 1024 * 1024) {
        line += 1;
        const text = `${String(line).padStart(9, '0')} INFO worker-${String(line % 17)} handled request /api/items/${String((line * 7919) % 100000)} in ${String(line % 997)} ms status=200 bytes=${String((line * 31) % 65536)}\n`;
        lines.push(text);
        size += text.length;
      }
      await handle.write(lines.join(''));
    }
  } finally {
    await handle.close();
  }
}

/**
 * Opens the prototype page, starts a terminal owned by it and shows it.
 * @param {ElectronApplication} app
 * @param {Page} page
 * @param {TestTerminalOptions} options
 */
async function openTerminal(app, page, options) {
  const base = page.url().split('#')[0] ?? page.url();
  await page.goto(`${base}${LAB_HASH}`);
  await page.reload();
  await page.getByTestId('terminal-lab').waitFor();
  await page.waitForFunction(() => globalThis.__piarcTerminalLab !== undefined);
  const windowId = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) {
      throw new Error('no window');
    }
    return window.webContents.id;
  });
  const id = await app.evaluate(
    (_electron, { owner, terminal }) => {
      const hooks = globalThis.__piarcTestHooks;
      if (hooks === undefined) {
        throw new Error('no Core test hooks: package the development flavor');
      }
      return hooks.createTerminal(owner, terminal);
    },
    { owner: windowId, terminal: options },
  );
  await page.evaluate((terminalId) => {
    globalThis.__piarcTerminalLab?.attach(terminalId);
    globalThis.__piarcTerminalLab?.focus();
  }, id);
  return id;
}

/**
 * @param {Page} page
 * @param {(text: string) => boolean} predicate
 * @param {number} timeoutMs
 */
async function waitForScreen(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await page.evaluate(() => globalThis.__piarcTerminalLab?.screenText() ?? '');
    if (predicate(text)) {
      return text;
    }
    if (Date.now() > deadline) {
      throw new Error(`the screen never reached the expected state:\n${text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * @param {ElectronApplication} app
 * @param {number} id
 */
function coreStats(app, id) {
  return app.evaluate((_electron, terminalId) => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) {
      throw new Error('no Core test hooks');
    }
    return {
      terminal: hooks.core.terminalStats(terminalId),
      forwarded: hooks.terminalForwardStats(),
      cpu: process.cpuUsage(),
    };
  }, id);
}

/**
 * @param {ElectronApplication} app
 * @param {Page} page
 * @param {number} megabytes
 * @param {number} repeat
 */
async function measureCat(app, page, megabytes, repeat) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'piarc-s7-'));
  try {
    const file = path.join(dir, 'log.txt');
    await writeLogFile(file, megabytes);
    const id = await openTerminal(app, page, { cols: 120, rows: 40, cwd: dir, ...SHELL });
    await waitForScreen(page, (text) => text.startsWith('$'), 10_000);
    const pid = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window?.webContents.getOSProcessId() ?? 0;
    });
    await page.evaluate(() => {
      globalThis.__piarcTerminalLab?.resetStats();
    });
    const before = await coreStats(app, id);
    await app.evaluate(() => {
      globalThis.__piarcTestHooks?.startLoopDelay();
    });
    const started = Date.now();
    const { result: wallMs, trace } = await traced(page, pid, async () => {
      await page.keyboard.type(`cat ${Array(repeat).fill('log.txt').join(' ')}; echo CAT-DONE`);
      await page.keyboard.press('Enter');
      await waitForScreen(
        page,
        (text) => text.split('\n').some((line) => line === 'CAT-DONE'),
        300_000,
      );
      return Date.now() - started;
    });
    const loopDelay = await app.evaluate(() => globalThis.__piarcTestHooks?.stopLoopDelay());
    const after = await coreStats(app, id);
    const lab = await page.evaluate(() => globalThis.__piarcTerminalLab?.stats());
    const seconds = wallMs / 1000;
    const t0 = before.terminal;
    const t1 = after.terminal;
    const cpuMs = (after.cpu.user - before.cpu.user + after.cpu.system - before.cpu.system) / 1000;
    const framesDrawn = lab === undefined ? 0 : lab.framesReceived - lab.emptyFrames;
    return {
      megabytes: megabytes * repeat,
      seconds,
      throughputMBps: (megabytes * repeat) / seconds,
      mainLoopDelayMs: loopDelay,
      renderer: {
        trace,
        framesRequested: lab?.framesRequested,
        framesReceived: lab?.framesReceived,
        framesDrawn,
        drawnPerSecond: framesDrawn / seconds,
        decodeMs: lab?.decodeMs,
        renderMs: lab?.renderMs,
        maxFrameWorkMs: lab?.maxFrameWorkMs,
        errors: lab?.errors,
      },
      core: {
        bytesRead: t1.bytesRead - t0.bytesRead,
        reads: t1.reads - t0.reads,
        vtWriteMs: (t1.vtWriteMicros - t0.vtWriteMicros) / 1000,
        vtWriteShareOfWall: (t1.vtWriteMicros - t0.vtWriteMicros) / 1000 / wallMs,
        frames: t1.frames - t0.frames,
        emptyFrames: t1.emptyFrames - t0.emptyFrames,
        frameEncodeMs: (t1.frameMicros - t0.frameMicros) / 1000,
        rowsWithCells: t1.rowsWithCells - t0.rowsWithCells,
        rowsReused: t1.rowsReused - t0.rowsReused,
      },
      mainProcess: {
        cpuMs,
        cpuShareOfOneCore: cpuMs / wallMs,
      },
      ipc: {
        frameRequests: after.forwarded.requests - before.forwarded.requests,
        framesForwarded: after.forwarded.frames - before.forwarded.frames,
        frameBytes: after.forwarded.bytes - before.forwarded.bytes,
        frameBytesPerSecond: (after.forwarded.bytes - before.forwarded.bytes) / seconds,
        outputBytesPerFrameByte:
          (t1.bytesRead - t0.bytesRead) /
          Math.max(1, after.forwarded.bytes - before.forwarded.bytes),
      },
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Waits until the page's cursor reaches column `x`.
 * @param {Page} page
 * @param {number} x
 */
async function waitForCursorColumn(page, x) {
  await page.waitForFunction(
    (column) => globalThis.__piarcTerminalLab?.cursorCell().x === column,
    x,
  );
}

/**
 * @param {ElectronApplication} app
 * @param {Page} page
 * @param {number} samples
 */
async function measureEcho(app, page, samples) {
  const id = await openTerminal(app, page, { cols: 120, rows: 10, program: 'cat', args: [] });
  await page.waitForTimeout(500);
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  /** @type {number[]} */
  const baseline = [];
  /** @type {number[]} */
  const full = [];
  /** @type {number[]} */
  const extra = [];
  const warmup = 10;
  let column = 0;
  for (let i = 0; i < samples + warmup; i += 1) {
    if (column >= 100) {
      // cat prints the line back; start a fresh one.
      await page.keyboard.press('Enter');
      column = 0;
      await waitForCursorColumn(page, 0);
      await page.waitForTimeout(50);
    }
    const probe = digits.charCodeAt(i % digits.length);
    const baselineUs = await app.evaluate(
      (_electron, { terminalId, byte }) => {
        const hooks = globalThis.__piarcTestHooks;
        if (hooks === undefined) {
          throw new Error('no Core test hooks');
        }
        return hooks.core.terminalProbeEcho(terminalId, byte);
      },
      { terminalId: id, byte: probe },
    );
    column += 1;
    await waitForCursorColumn(page, column);
    const letter = letters[i % letters.length] ?? 'a';
    await page.evaluate((char) => {
      globalThis.__piarcTerminalLab?.armEcho(char);
    }, letter);
    await page.keyboard.press(letter);
    const fullMs = await page.evaluate(() => {
      const lab = globalThis.__piarcTerminalLab;
      if (lab === undefined) {
        throw new Error('not the terminal prototype page');
      }
      return lab.echoResult();
    });
    column += 1;
    await waitForCursorColumn(page, column);
    if (i >= warmup) {
      baseline.push(baselineUs / 1000);
      full.push(fullMs);
      extra.push(fullMs - baselineUs / 1000);
    }
  }
  return {
    samples: full.length,
    baselineMs: summarize(baseline),
    fullMs: summarize(full),
    extraMs: summarize(extra),
    extraMeanMs: extra.reduce((sum, value) => sum + value, 0) / Math.max(1, extra.length),
  };
}

/** @param {number | undefined} value */
function ms(value) {
  return value === undefined || Number.isNaN(value) ? '-' : `${value.toFixed(2)} ms`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      form: { type: 'string', default: 'packaged' },
      megabytes: { type: 'string', default: '100' },
      repeat: { type: 'string', default: '1' },
      'echo-samples': { type: 'string', default: '200' },
      out: { type: 'string' },
    },
  });
  const form = values.form === 'dev' ? 'dev' : 'packaged';
  const megabytes = Number(values.megabytes);
  const repeat = Number(values.repeat);
  const echoSamples = Number(values['echo-samples']);
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'piarc-s7-app-'));
  const { command, args } = await appCommand(form, [`--user-data-dir=${userDataDir}`]);
  const app = await electron.launch({ executablePath: command, args });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('app-shell').waitFor();
    const cat = await measureCat(app, page, megabytes, repeat);
    const echo = await measureEcho(app, page, echoSamples);
    const report = {
      date: new Date().toISOString(),
      form,
      platform: `${process.platform}-${process.arch}`,
      cpus: os.cpus()[0]?.model,
      cat,
      echo,
    };
    const out =
      values.out ?? path.join(repoRoot, 'tmp', 'evidence', 'T10', 'bench', `s7-${form}.json`);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    const trace = cat.renderer.trace;
    console.log(`S7 (${form}) — ${path.relative(repoRoot, out)}`);
    console.log(
      `cat ${String(cat.megabytes)} MB: ${cat.seconds.toFixed(1)} s (${cat.throughputMBps.toFixed(0)} MB/s); ` +
        `main loop delay p50 ${ms(cat.mainLoopDelayMs?.p50)} p99 ${ms(cat.mainLoopDelayMs?.p99)} max ${ms(cat.mainLoopDelayMs?.max)}`,
    );
    console.log(
      `renderer: ${cat.renderer.drawnPerSecond.toFixed(1)} frames drawn/s; work per frame p50 ${ms(trace.frameWorkMs.p50)} ` +
        `p99 ${ms(trace.frameWorkMs.p99)}; tasks > 50 ms: ${String(trace.longTasksMs.length)}`,
    );
    console.log(
      `core: vt_write ${ms(cat.core.vtWriteMs)} (${(cat.core.vtWriteShareOfWall * 100).toFixed(1)}% of wall), ` +
        `${String(cat.core.frames)} frames encoded in ${ms(cat.core.frameEncodeMs)}; ` +
        `rows sent ${String(cat.core.rowsWithCells)}, reused ${String(cat.core.rowsReused)}`,
    );
    console.log(
      `ipc: ${(cat.ipc.frameBytes / 1024 / 1024).toFixed(1)} MiB of frames for ${(cat.core.bytesRead / 1024 / 1024).toFixed(0)} MiB of output; ` +
        `main process CPU ${(cat.mainProcess.cpuShareOfOneCore * 100).toFixed(0)}% of one core`,
    );
    console.log(
      `echo (${String(echo.samples)} samples): baseline p50 ${ms(echo.baselineMs.p50)} p95 ${ms(echo.baselineMs.p95)}; ` +
        `full p50 ${ms(echo.fullMs.p50)} p95 ${ms(echo.fullMs.p95)}; extra p50 ${ms(echo.extraMs.p50)} p95 ${ms(echo.extraMs.p95)}`,
    );
  } finally {
    await app.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  await main();
}
