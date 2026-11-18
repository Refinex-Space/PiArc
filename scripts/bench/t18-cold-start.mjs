// T18-A13: cold start to an interactive window with the sidebar loaded (architecture chapter
// 11, budget 1.0 s). A data directory with N Pi session files (default 100) is indexed by one
// warm-up launch; then each run starts the app as a new process and measures from the spawn to
// the renderer's `piarc:sidebar-ready` mark (Core's session list on screen), with both clocks
// in Unix milliseconds. Playwright's launch adds its own debugging connection, so the numbers
// are an upper bound.
//
//   npm run bench:t18 -- [--form packaged|dev] [--runs 10] [--sessions 100]
//
// JSON goes to tmp/evidence/T18/bench/cold-start.json.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { _electron as electron } from '@playwright/test';

import { isMain, isRecord, repoRoot } from '../lib/repo.mjs';
import { appCommand } from './s1-transcript.mjs';

/** The budget of architecture chapter 11, in milliseconds. */
export const BUDGET_MS = 1000;

const START_MS = Date.UTC(2026, 10, 18, 9, 0, 0);

/**
 * Writes `count` Pi session files (format version 3: header, a user message and a reply) for
 * the workspace `cwd` under `<dataDir>/pi/sessions/`.
 * @param {string} dataDir
 * @param {string} cwd
 * @param {number} count
 */
export async function writeSessionFixture(dataDir, cwd, count) {
  const dir = path.join(
    dataDir,
    'pi',
    'sessions',
    `--${cwd.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '-')}--`,
  );
  await mkdir(dir, { recursive: true });
  for (let n = 0; n < count; n += 1) {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const at = START_MS + n * 60_000;
    const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
    const lines = [
      { type: 'session', version: 3, id, timestamp: iso(at), cwd },
      {
        type: 'message',
        id: 'e000001',
        parentId: null,
        timestamp: iso(at + 1000),
        message: {
          role: 'user',
          content: [{ type: 'text', text: `Task ${String(n + 1)}: update the build scripts` }],
          timestamp: at + 1000,
        },
      },
      {
        type: 'message',
        id: 'e000002',
        parentId: 'e000001',
        timestamp: iso(at + 2000),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
          api: 'anthropic-messages',
          provider: 'piarc-mock',
          model: 'mock-large',
          usage: {
            input: 10,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 12,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: at + 2000,
        },
      },
    ];
    const name = `${iso(at).replace(/[:.]/g, '-')}_${id}.jsonl`;
    await writeFile(path.join(dir, name), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  }
}

/**
 * One launch: milliseconds from the spawn to the sidebar showing `expected` sessions. The
 * warm-up launch indexes the files first, so its list fills in after the first mark.
 * @param {{ command: string, args: string[] }} launch
 * @param {number} expected
 * @param {boolean} [warmUp]
 */
async function measure(launch, expected, warmUp = false) {
  const spawnedAt = Date.now();
  const app = await electron.launch({ executablePath: launch.command, args: launch.args });
  try {
    const page = await app.firstWindow();
    const deadline = Date.now() + 30_000;
    for (;;) {
      // A string: the scripts project has no DOM types.
      /** @type {unknown} */
      const read = await page.evaluate(`(() => {
        const entry = performance.getEntriesByName('piarc:sidebar-ready')[0];
        if (entry === undefined) return null;
        const detail = entry.detail;
        return {
          at: performance.timeOrigin + entry.startTime,
          sessions: detail && typeof detail.sessions === 'number' ? detail.sessions : -1,
          rows: document.querySelectorAll('[data-testid="session-row"]').length,
        };
      })()`);
      const mark =
        isRecord(read) &&
        typeof read.at === 'number' &&
        typeof read.sessions === 'number' &&
        typeof read.rows === 'number'
          ? { at: read.at, sessions: read.sessions, rows: read.rows }
          : null;
      if (mark !== null && warmUp) {
        if (mark.rows === expected) {
          return Date.now() - spawnedAt;
        }
      } else if (mark !== null) {
        if (mark.sessions !== expected || mark.rows !== expected) {
          throw new Error(
            `the sidebar showed ${String(mark.sessions)} sessions (${String(mark.rows)} rows), ` +
              `expected ${String(expected)}`,
          );
        }
        return mark.at - spawnedAt;
      }
      if (Date.now() > deadline) {
        throw new Error('the sidebar never became ready');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    await app.close();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      form: { type: 'string', default: 'packaged' },
      runs: { type: 'string', default: '10' },
      sessions: { type: 'string', default: '100' },
    },
  });
  const form = values.form === 'dev' ? 'dev' : 'packaged';
  const runs = Number(values.runs);
  const count = Number(values.sessions);
  const root = await mkdtemp(path.join(os.tmpdir(), 'piarc t18 冷启动-'));
  try {
    const dataDir = path.join(root, 'data');
    const cwd = path.join(root, 'workspace 工作区');
    await mkdir(cwd, { recursive: true });
    await writeSessionFixture(dataDir, cwd, count);
    const launch = await appCommand(form, [`--user-data-dir=${dataDir}`]);
    // The first launch indexes the files; the measured launches start cold with the index.
    const warmUp = await measure(launch, count, true);
    /** @type {number[]} */
    const timings = [];
    for (let run = 0; run < runs; run += 1) {
      const ms = await measure(launch, count);
      timings.push(ms);
      console.log(`run ${String(run + 1)}: ${ms.toFixed(0)} ms`);
    }
    const sorted = [...timings].sort((a, b) => a - b);
    const result = {
      form,
      platform: `${process.platform}-${process.arch}`,
      sessions: count,
      warmUpMs: Math.round(warmUp),
      timingsMs: timings.map((ms) => Math.round(ms)),
      medianMs: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
      maxMs: Math.round(sorted[sorted.length - 1] ?? 0),
      budgetMs: BUDGET_MS,
    };
    const out = path.join(repoRoot, 'tmp', 'evidence', 'T18', 'bench');
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'cold-start.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(
      `cold start to sidebar (${String(count)} sessions, ${form}): median ${String(result.medianMs)} ms, ` +
        `max ${String(result.maxMs)} ms (budget ${String(BUDGET_MS)} ms)`,
    );
    if (result.maxMs > BUDGET_MS) {
      process.exitCode = 1;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  await main();
}
