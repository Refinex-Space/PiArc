// T44 long run (architecture chapter 11: memory growth of a long session after steady state
// ≤ 10%). One window, one session: every `cadence` seconds a prompt starts a turn in which the
// mock reads a file, writes one, starts a background command and answers; meanwhile a command
// prints into the session's terminal. After `warmup` minutes the main process, the renderer
// and the Agent Host are sampled every `interval` minutes; growth = (last − first sample of the
// steady state) / first, for each process.
//
//   node scripts/perf/long-run.mjs [--hours 8] [--warmup 30] [--interval 10] [--cadence 30]
//                                  [--lane long|nightly] [--out <file.json>]
//
// `--lane nightly` (or `PIARC_LONG_RUN_HOURS=1`) is a one-hour run (warm-up 10, interval 5)
// that fits a hosted runner's job; the full eight hours run locally or on a self-hosted runner.
// Samples go to the output file as they are taken.
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
  seedModels,
  sleep,
  startMock,
  startSession,
} from './lib.mjs';

/**
 * One turn of the load: Read, Write, a background command, then the answer.
 * @param {number} n
 */
function turn(n) {
  return [
    {
      text: `Turn ${String(n)}: reading the notes.`,
      tool_calls: [{ id: `read-${String(n)}`, name: 'Read', input: { path: 'notes.txt' } }],
    },
    {
      tool_calls: [
        {
          id: `write-${String(n)}`,
          name: 'Write',
          input: {
            path: `log/turn-${String(n % 50)}.txt`,
            content: `turn ${String(n)}\n`.repeat(20),
          },
        },
      ],
    },
    {
      tool_calls: [
        {
          id: `bg-${String(n)}`,
          name: 'Bash',
          input: { command: `echo background ${String(n)}`, run_in_background: true },
        },
      ],
    },
    { text: `Turn ${String(n)} done. `.repeat(30), chunk_chars: 20, chunk_delay_ms: 10 },
  ];
}

/**
 * @param {{ form: 'packaged' | 'dev', hours: number, warmup: number, interval: number, cadence: number, out: string | undefined }} options
 */
export async function measure(options) {
  const turns = Math.ceil((options.hours * 3600) / options.cadence) + 5;
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'piarc perf 长跑 ')));
  const userData = path.join(root, 'data');
  const workspace = path.join(root, 'work 工作区');
  await mkdir(path.join(workspace, 'log'), { recursive: true });
  await writeFile(path.join(workspace, 'notes.txt'), 'The release is on Friday.\n'.repeat(50));
  const scenario = path.join(root, 'long.json');
  await writeFile(
    scenario,
    JSON.stringify({
      id: 'perf-long',
      steps: [{ text: 'Ready.' }, ...Array.from({ length: turns }, (_, n) => turn(n)).flat()],
    }),
  );
  const mock = await startMock(scenario);
  // Accept edits: the writes run without asking (echo is read-only anyway).
  await seedModels(userData, mock.baseUrl, { permissions: { defaultMode: 'acceptEdits' } });
  const { app, page } = await launchApp(options.form, userData);
  /** @type {{ minute: number, mainMB: number, rendererMB: number, agentHostMB: number }[]} */
  const samples = [];
  const started = Date.now();
  const save = async () => {
    if (options.out === undefined) return;
    await mkdir(path.dirname(options.out), { recursive: true });
    await writeFile(options.out, `${JSON.stringify({ partial: true, samples }, null, 2)}\n`);
  };
  try {
    await openWorkspace(app, page, workspace);
    await startSession(page, 'perf-long', { trust: true });
    await page.getByTestId('agent-message').filter({ hasText: 'Ready.' }).waitFor();
    const id = await page.getByTestId('conversation').getAttribute('data-session-id');
    if (id === null) throw new Error('no session id');
    await page.keyboard.press('Control+Backquote');
    await page.getByTestId('terminal-panel').waitFor();
    const mainPid = await app.evaluate(() => process.pid);
    const end = started + options.hours * 3_600_000;
    const firstSample = started + options.warmup * 60_000;
    let nextSample = firstSample;
    let n = 0;
    // A refused prompt is not load (R5): the run fails when most of them were refused.
    let refused = 0;
    while (Date.now() < end) {
      const turnAt = Date.now();
      n += 1;
      /** @type {unknown} */
      const accepted = await page.evaluate(
        `window.piarc.prompt(${JSON.stringify(id)}, 'Next turn ${String(n)}.').then(() => true, () => false)`,
      );
      if (accepted !== true) refused += 1;
      // Terminal output: a command typed into the session's terminal (real input).
      await page.getByTestId('terminal-canvas').click();
      await page.keyboard.type(`seq 1 200 | tail -n 3 # ${String(n)}`);
      await page.keyboard.press('Enter');
      if (Date.now() >= nextSample) {
        const snapshot = await appSnapshot(app, mainPid);
        samples.push({
          minute: Math.round((Date.now() - started) / 60_000),
          mainMB: (snapshot.byType.Browser ?? 0) / MB,
          rendererMB: (snapshot.byType.Tab ?? 0) / MB,
          agentHostMB: snapshot.agentHostBytes / MB,
        });
        console.log(JSON.stringify(samples.at(-1)));
        await save();
        nextSample += options.interval * 60_000;
      }
      await sleep(Math.max(0, options.cadence * 1000 - (Date.now() - turnAt)));
    }
    if (refused * 2 > n) {
      throw new Error(
        `${String(refused)} of ${String(n)} prompts were refused: the session did not run`,
      );
    }
    if (samples.length < 2) throw new Error('fewer than two steady-state samples');
    // The mean of the first and of the last two samples (one when there are fewer than four), so
    // one garbage collection at either end does not decide the growth (R5).
    const ends = samples.length >= 4 ? 2 : 1;
    const mean = (/** @type {typeof samples} */ part) =>
      /** @type {Record<'mainMB' | 'rendererMB' | 'agentHostMB', number>} */ ({
        mainMB: part.reduce((t, x) => t + x.mainMB, 0) / part.length,
        rendererMB: part.reduce((t, x) => t + x.rendererMB, 0) / part.length,
        agentHostMB: part.reduce((t, x) => t + x.agentHostMB, 0) / part.length,
      });
    const first = mean(samples.slice(0, ends));
    const last = mean(samples.slice(-ends));
    const growth = (/** @type {number} */ a, /** @type {number} */ b) => ((b - a) / a) * 100;
    return {
      values: {
        'long-run-growth-main': growth(first.mainMB, last.mainMB),
        'long-run-growth-renderer': growth(first.rendererMB, last.rendererMB),
        'long-run-growth-agent-host': growth(first.agentHostMB, last.agentHostMB),
      },
      samples: samples.length,
      detail: {
        hours: options.hours,
        warmupMinutes: options.warmup,
        intervalMinutes: options.interval,
        cadenceSeconds: options.cadence,
        prompts: n,
        refusedPrompts: refused,
        turns: n,
        samples,
      },
    };
  } finally {
    await app.close().catch(() => undefined);
    mock.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      form: { type: 'string', default: 'packaged' },
      lane: { type: 'string', default: 'long' },
      hours: { type: 'string' },
      warmup: { type: 'string' },
      interval: { type: 'string' },
      cadence: { type: 'string', default: '30' },
      out: { type: 'string' },
    },
  });
  // A run of an hour or less (Nightly) warms up 10 minutes and samples every 5.
  const hours = Number(
    values.hours ?? process.env.PIARC_LONG_RUN_HOURS ?? (values.lane === 'nightly' ? '1' : '8'),
  );
  const short = hours <= 1;
  const result = await measure({
    form: values.form === 'dev' ? 'dev' : 'packaged',
    hours,
    warmup: Number(values.warmup ?? (short ? '10' : '30')),
    interval: Number(values.interval ?? (short ? '5' : '10')),
    cadence: Number(values.cadence),
    out: values.out,
  });
  console.log(JSON.stringify(result.values, null, 2));
  if (values.out !== undefined) {
    await mkdir(path.dirname(values.out), { recursive: true });
    await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
  }
}

if (isMain(import.meta.url)) await main();
