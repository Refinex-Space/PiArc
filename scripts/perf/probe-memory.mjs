// T44 probe: the renderer's memory and all the app's processes together (no Agent Host) with
// chapter 11's fixture: 100 sessions in the sidebar, one of them with 1,000 items open. A first
// launch indexes the Pi session files; the measured launch opens the long session, waits for its
// rows, collects garbage in the renderer (CDP) and reads `app.getAppMetrics()` working sets
// (the resident size on macOS) after a few seconds of rest. MB is 10^6 bytes.
//
// On macOS the detail also has the processes' physical footprint (`footprint`), which counts
// the shared framework pages once: for information only (I26), the budget is on resident size.
//
//   node scripts/perf/probe-memory.mjs --form packaged --out <file.json>
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { isMain, isRecord, readJsonFile } from '../lib/repo.mjs';
import { writeHistoryFixture } from '../bench/t18-cold-start.mjs';
import { appSnapshot, launchApp, MB, sleep } from './lib.mjs';

const SESSIONS = 100;
const LONG = 1000;

/**
 * The physical footprint (bytes) of each process, by pid (macOS `footprint`).
 * @param {readonly number[]} pids
 * @param {string} dir a directory for the tool's JSON output
 * @returns {Promise<Record<string, number>>}
 */
async function footprints(pids, dir) {
  const file = path.join(dir, 'footprint.json');
  execFileSync(
    'footprint',
    ['-f', 'bytes', '-j', file, ...pids.flatMap((pid) => ['-p', String(pid)])],
    {
      stdio: 'ignore',
    },
  );
  const report = await readJsonFile(file);
  /** @type {Record<string, number>} */
  const by = {};
  if (isRecord(report) && Array.isArray(report.processes)) {
    for (const p of report.processes) {
      if (isRecord(p) && typeof p.pid === 'number' && typeof p.footprint === 'number') {
        by[String(p.pid)] = p.footprint;
      }
    }
  }
  return by;
}

/**
 * @param {{ form: 'packaged' | 'dev' }} options
 */
export async function measure(options) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'piarc perf 内存 ')));
  const userData = path.join(root, 'data');
  const cwd = path.join(root, 'work 工作区');
  await mkdir(cwd, { recursive: true });
  for (let i = 0; i < SESSIONS; i++) {
    await writeHistoryFixture(userData, cwd, i, i === SESSIONS - 1 ? LONG : 2);
  }
  try {
    // Index the session files once.
    const first = await launchApp(options.form, userData);
    await first.page
      .getByTestId('session-title')
      .nth(SESSIONS - 1)
      .waitFor({ timeout: 60_000 });
    await first.app.close();

    const { app, page } = await launchApp(options.form, userData);
    try {
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800);
      });
      await page
        .getByTestId('session-title')
        .nth(SESSIONS - 1)
        .waitFor({ timeout: 60_000 });
      await page
        .getByTestId('session-title')
        .filter({ hasText: `Task ${String(SESSIONS)}:` })
        .click();
      await page
        .locator(`.transcript-row[data-index="${String(LONG - 1)}"]`)
        .waitFor({ state: 'attached', timeout: 30_000 });
      await sleep(3000);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('HeapProfiler.collectGarbage');
      await cdp.detach();
      await sleep(3000);
      const snapshot = await appSnapshot(app);
      const renderer = snapshot.byType.Tab ?? Number.NaN;
      /** @type {Record<string, number> | undefined} */
      let footprintMB;
      if (process.platform === 'darwin') {
        const processes = await app.evaluate(({ app: electronApp }) =>
          electronApp.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type })),
        );
        const by = await footprints(
          processes.map((p) => p.pid),
          root,
        );
        footprintMB = {};
        for (const p of processes) {
          footprintMB[p.type] = (footprintMB[p.type] ?? 0) + (by[String(p.pid)] ?? 0) / MB;
        }
      }
      return {
        values: {
          'renderer-memory': renderer / MB,
          'app-memory': snapshot.appBytes / MB,
        },
        samples: 1,
        detail: {
          byTypeMB: Object.fromEntries(
            Object.entries(snapshot.byType).map(([type, bytes]) => [type, bytes / MB]),
          ),
          ...(footprintMB === undefined
            ? {}
            : {
                footprintMB: {
                  ...footprintMB,
                  total: Object.values(footprintMB).reduce((a, b) => a + b, 0),
                },
              }),
        },
      };
    } finally {
      await app.close().catch(() => undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      form: { type: 'string', default: 'packaged' },
      lane: { type: 'string', default: 'nightly' },
      out: { type: 'string' },
    },
  });
  const result = await measure({ form: values.form === 'dev' ? 'dev' : 'packaged' });
  console.log(JSON.stringify(result, null, 2));
  if (values.out !== undefined) {
    await mkdir(path.dirname(values.out), { recursive: true });
    await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
  }
}

if (isMain(import.meta.url)) await main();
