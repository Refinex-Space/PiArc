// Runs the performance measurements of one lane and judges them (T44, architecture chapter 11):
//
//   node scripts/perf/run.mjs --lane pr|nightly|long [--only <metric,…>] [--runs <n>]
//                             [--absolute] [--machine <class>] [--update-baseline "<reason>"]
//                             [--from-report <report.json>]
//
// Each probe (an existing benchmark or a script in scripts/perf/) runs `runs` times and every
// metric's value is the median of the runs. Two judgements (gate.mjs): `--absolute` compares
// with chapter 11's budgets (for the reference machine or a named local machine; CI runners
// only compare with their baseline), and a value more than 10% worse than the baseline of this
// platform and machine class fails. `--update-baseline` writes the values as the new baseline
// (the reason goes into the file; commit it with the reason in the message). `--from-report`
// judges a report another machine wrote instead of measuring (a CI runner's Nightly artifact:
// with `--machine github-arm64 --update-baseline …` it records that runner class's baseline).
//
// Needs the development-flavor package (`npm run package:desktop -- --flavor development`);
// the size probe also needs the release build's installer (`-- --flavor release --make`).
// The report goes to tmp/perf/<lane>/report.json; the exit code is 1 when anything failed.
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { isMain, isRecord, repoRoot, resolveBin } from '../lib/repo.mjs';
import { baselineFile, failures, judge, machineClass, readBaselines, unjudged } from './gate.mjs';
import { quantile } from './lib.mjs';
import { METRICS } from './metrics.mjs';

/**
 * @typedef {'pr' | 'nightly' | 'long'} Lane
 * @typedef {{ lane: Lane, out: string, form: 'packaged' | 'dev' }} ProbeContext
 * @typedef {{ values: Record<string, number>, samples: number }} ProbeResult
 * @typedef {{ run: (ctx: ProbeContext) => Promise<ProbeResult>, runs: Record<Lane, number> }} Probe
 */

/**
 * Runs `command` and resolves with its exit code and output (shown as it comes).
 * @param {string} command
 * @param {readonly string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ code: number, output: string }>}
 */
export function exec(command, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    /** @type {string[]} */
    const output = [];
    const take = (/** @type {Buffer} */ chunk, /** @type {NodeJS.WriteStream} */ to) => {
      output.push(chunk.toString('utf8'));
      to.write(chunk);
    };
    child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      take(chunk, process.stdout);
    });
    child.stderr.on('data', (/** @type {Buffer} */ chunk) => {
      take(chunk, process.stderr);
    });
    child.on('error', (error) => {
      resolve({ code: 127, output: error.message });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, output: output.join('') });
    });
  });
}

/**
 * The JSON a probe wrote.
 * @param {string} file
 * @returns {Promise<Record<string, unknown>>}
 */
async function readResult(file) {
  /** @type {unknown} */
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed;
}

/**
 * The number at `keys` in `value`.
 * @param {unknown} value
 * @param {readonly (string | number)[]} keys
 */
export function numberAt(value, keys) {
  let at = value;
  for (const key of keys) {
    at =
      Array.isArray(at) && typeof key === 'number' ? at[key] : isRecord(at) ? at[key] : undefined;
  }
  if (typeof at !== 'number') throw new Error(`no number at ${keys.join('.')}`);
  return at;
}

/**
 * A Rust `Duration` as printed by `{:?}` (`512.3µs`, `1.25ms`, `2s`) in milliseconds.
 * @param {string} text
 */
export function durationMs(text) {
  const match = /^([\d.]+)(ns|µs|us|ms|s)$/u.exec(text.trim());
  if (match === null) throw new Error(`not a duration: ${text}`);
  const scale = { ns: 1e-6, µs: 1e-3, us: 1e-3, ms: 1, s: 1000 }[match[2] ?? 'ms'] ?? 1;
  return Number(match[1]) * scale;
}

const node = process.execPath;
const script = (/** @type {string} */ name) => path.join(repoRoot, 'scripts', name);

/** @type {Record<string, Probe>} */
export const PROBES = {
  'cold-start': {
    runs: { pr: 1, nightly: 1, long: 0 },
    async run(ctx) {
      const out = path.join(ctx.out, 'cold-start.json');
      const launches = ctx.lane === 'pr' ? 5 : 10;
      const { code } = await exec(node, [
        script('bench/t18-cold-start.mjs'),
        '--form',
        ctx.form,
        '--runs',
        String(launches),
        '--out',
        out,
      ]);
      const result = await readResult(out).catch(() => undefined);
      if (result === undefined) throw new Error(`the cold start bench failed (${String(code)})`);
      return { values: { 'cold-start': numberAt(result, ['medianMs']) }, samples: launches };
    },
  },
  workspace: {
    runs: { pr: 1, nightly: 1, long: 0 },
    async run() {
      const { output } = await exec('cargo', [
        'run',
        '-q',
        '--release',
        '--locked',
        '-p',
        'piarc-testkit',
        '--example',
        't14-warmup',
      ]);
      // Only the `round N:` lines: the closing `max of 10:` line repeats the largest (R5).
      const rounds = [...output.matchAll(/^round\s+\d+:.*open \+ resume\s+([\d.]+) ms/gmu)].map(
        (m) => Number(m[1]),
      );
      if (rounds.length === 0) throw new Error('t14-warmup printed no rounds');
      // The largest of the ten, as T14 and chapter 11 measure it (the example exits non-zero
      // when it is over the budget, which the verdict reports).
      return { values: { 'workspace-ready': Math.max(...rounds) }, samples: rounds.length };
    },
  },
  ahp: {
    runs: { pr: 1, nightly: 3, long: 0 },
    async run() {
      const { output } = await exec('cargo', [
        'test',
        '-q',
        '--locked',
        '-p',
        'piarc-testkit',
        '--test',
        'ahp_round_trip',
        '--',
        '--nocapture',
      ]);
      const match = /p95 ([\d.]+) ms/u.exec(output);
      if (match === null) throw new Error('ahp_round_trip printed no p95');
      return { values: { 'ahp-round-trip-p95': Number(match[1]) }, samples: 1 };
    },
  },
  policy: {
    runs: { pr: 1, nightly: 3, long: 0 },
    async run() {
      // Alone and in a release build, as verify runs it (scripts/ci/cargo-test.mjs).
      const { output } = await exec('cargo', [
        'test',
        '-q',
        '--release',
        '--locked',
        '-p',
        'piarc-core',
        '--lib',
        'tool_io::policy::tests::automatic_decision_latency',
        '--',
        '--exact',
        '--nocapture',
      ]);
      const match = /p95 ([\d.]+(?:ns|µs|us|ms|s))/u.exec(output);
      if (match === null) throw new Error('automatic_decision_latency printed no p95');
      return { values: { 'policy-decision-p95': durationMs(match[1] ?? '') }, samples: 1 };
    },
  },
  'event-channel': {
    runs: { pr: 1, nightly: 1, long: 0 },
    async run(ctx) {
      const out = path.join(ctx.out, 'event-channel.json');
      await exec(node, [
        script('bench/s2-event-channel.mjs'),
        '--form',
        ctx.form,
        '--minutes',
        ctx.lane === 'pr' ? '0.25' : '1',
        '--out',
        out,
      ]);
      const result = await readResult(out);
      return {
        values: {
          'core-to-renderer-p95': numberAt(result, ['throughput', 'forwardMs', 'p95']),
          'main-memory-delta':
            (numberAt(result, ['idle', 'mainRssMb', 'median']) -
              numberAt(result, ['idle', 'bareElectronMainRssMb', 'median'])) *
            ((1024 * 1024) / 1_000_000),
        },
        samples: numberAt(result, ['throughput', 'forwardMs', 'count']),
      };
    },
  },
  transcript: {
    runs: { pr: 1, nightly: 1, long: 0 },
    async run(ctx) {
      const out = path.join(ctx.out, 'transcript');
      await exec(
        node,
        [
          resolveBin('@playwright/test', 'playwright'),
          'test',
          '--config',
          path.join(repoRoot, 'apps', 'desktop', 'e2e', 't19.bench.config.ts'),
          '--output',
          out,
        ],
        { ...process.env, PIARC_BENCH_SCALE: ctx.lane === 'pr' ? '0.25' : '1' },
      );
      const dirs = await readdir(out);
      const dir = dirs.find((d) => d.startsWith('t19.bench'));
      if (dir === undefined) throw new Error('the transcript bench wrote no timings');
      const result = await readResult(path.join(out, dir, 'timings.json'));
      const streaming = isRecord(result.streaming) ? result.streaming : {};
      const longTasks = Array.isArray(streaming.longTasksMs)
        ? streaming.longTasksMs.length
        : Number.NaN;
      const list = (/** @type {string} */ key) =>
        Array.isArray(result[key]) ? result[key].filter((v) => typeof v === 'number') : [];
      return {
        values: {
          'stream-frame-p99': numberAt(result, ['streaming', 'frameWorkMs', 'p99']),
          'stream-long-tasks': longTasks,
          'scroll-fps': Math.round(numberAt(result, ['scrolling', 'fps'])),
          'switch-cached': Math.max(...list('cachedMs')),
          'switch-cold': Math.max(...list('coldMs')),
        },
        samples: list('coldMs').length,
      };
    },
  },
  terminal: {
    runs: { pr: 0, nightly: 1, long: 0 },
    async run(ctx) {
      const out = path.join(ctx.out, 'terminal.json');
      await exec(node, [
        script('bench/s7-terminal.mjs'),
        '--form',
        ctx.form,
        '--megabytes',
        '10',
        '--echo-samples',
        '1000',
        '--out',
        out,
      ]);
      const result = await readResult(out);
      return {
        values: {
          'terminal-echo-p95':
            numberAt(result, ['echo', 'fullMs', 'p95']) -
            numberAt(result, ['echo', 'baselineMs', 'p95']),
        },
        samples: numberAt(result, ['echo', 'samples']),
      };
    },
  },
};

/**
 * Probes implemented as scripts in scripts/perf/ that write `{ values, samples }`.
 * @param {string} name file name
 * @param {Record<Lane, number>} runs
 * @param {(ctx: ProbeContext) => string[]} [args]
 * @returns {Probe}
 */
function perfScript(name, runs, args = () => []) {
  return {
    runs,
    async run(ctx) {
      const out = path.join(ctx.out, name.replace(/\.mjs$/u, '.json'));
      const { code } = await exec(node, [
        script(`perf/${name}`),
        '--form',
        ctx.form,
        '--lane',
        ctx.lane,
        '--out',
        out,
        ...args(ctx),
      ]);
      const result = await readResult(out).catch(() => undefined);
      if (result === undefined) throw new Error(`${name} failed (${String(code)})`);
      /** @type {Record<string, number>} */
      const values = {};
      if (isRecord(result.values)) {
        for (const [id, value] of Object.entries(result.values)) {
          if (typeof value === 'number') values[id] = value;
        }
      }
      return { values, samples: typeof result.samples === 'number' ? result.samples : 1 };
    },
  };
}

PROBES.memory = perfScript('probe-memory.mjs', { pr: 0, nightly: 3, long: 0 });
PROBES.sessions = perfScript('probe-sessions.mjs', { pr: 1, nightly: 3, long: 0 });
PROBES['first-token'] = perfScript('probe-first-token.mjs', { pr: 0, nightly: 1, long: 0 });
PROBES.idle = perfScript('probe-idle.mjs', { pr: 0, nightly: 1, long: 0 });
PROBES.recovery = perfScript('probe-recovery.mjs', { pr: 0, nightly: 3, long: 0 });
PROBES.size = perfScript('probe-size.mjs', { pr: 0, nightly: 1, long: 0 });
PROBES['long-run'] = perfScript('long-run.mjs', { pr: 0, nightly: 0, long: 1 });

/**
 * Runs the probes of `lane` (or the ones measuring `only`) and returns each metric's values.
 * @param {{ lane: Lane, only: string[] | undefined, runs: number | undefined, form: 'packaged' | 'dev', out: string }} options
 */
async function measureAll(options) {
  const wanted = METRICS.filter((m) =>
    options.only === undefined ? m.lanes.includes(options.lane) : options.only.includes(m.id),
  );
  const probes = [...new Set(wanted.map((m) => m.probe))];
  /** @type {Record<string, number[]>} */
  const values = {};
  /** @type {Record<string, number>} */
  const samples = {};
  /** @type {string[]} */
  const errors = [];
  for (const name of probes) {
    const probe = PROBES[name];
    if (probe === undefined) {
      errors.push(`no probe ${name}`);
      continue;
    }
    const runs = options.runs ?? Math.max(1, probe.runs[options.lane]);
    for (let run = 0; run < runs; run++) {
      console.log(`\n▶ ${name} (${String(run + 1)}/${String(runs)})`);
      try {
        const result = await probe.run({
          lane: options.lane,
          form: options.form,
          out: path.join(options.out, `${name}-${String(run + 1)}`),
        });
        for (const [id, value] of Object.entries(result.values)) {
          (values[id] ??= []).push(value);
          samples[id] = (samples[id] ?? 0) + result.samples;
        }
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { wanted, values, samples, errors };
}

/**
 * The values of a report `run.mjs` wrote elsewhere, as if just measured.
 * @param {string} file
 * @param {Lane} lane
 * @param {string[] | undefined} only
 */
async function fromReport(file, lane, only) {
  const report = await readResult(path.resolve(file));
  /** @type {Record<string, number[]>} */
  const values = {};
  if (isRecord(report.runs)) {
    for (const [id, runs] of Object.entries(report.runs)) {
      if (Array.isArray(runs)) values[id] = runs.filter((v) => typeof v === 'number');
    }
  }
  const wanted = METRICS.filter((m) =>
    only === undefined ? m.lanes.includes(lane) : only.includes(m.id),
  );
  const text = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : undefined);
  // The machine that measured: its platform picks the budget and the baseline file.
  const platform = text(report.platform);
  if (platform === undefined) throw new Error(`${file}: no platform`);
  return {
    wanted,
    values,
    samples: {},
    errors: [],
    measuredAt: text(report.date) ?? 'unknown',
    host: {
      platform,
      cpu: text(report.cpu) ?? 'unknown',
      memoryGiB: typeof report.memoryGiB === 'number' ? report.memoryGiB : 0,
      os: text(report.os) ?? 'unknown',
    },
  };
}

/** This machine, as a report describes it. */
function thisHost() {
  return {
    platform: `${process.platform}-${process.arch}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    memoryGiB: Math.round(os.totalmem() / 1024 ** 3),
    os: os.release(),
  };
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      lane: { type: 'string', default: 'pr' },
      only: { type: 'string' },
      runs: { type: 'string' },
      form: { type: 'string', default: 'packaged' },
      absolute: { type: 'boolean', default: false },
      machine: { type: 'string' },
      'update-baseline': { type: 'string' },
      'from-report': { type: 'string' },
    },
  });
  const lane = /** @type {Lane} */ (
    args.lane === 'nightly' || args.lane === 'long' ? args.lane : 'pr'
  );
  const machine = args.machine ?? machineClass();
  const out = path.join(repoRoot, 'tmp', 'perf', lane);
  await mkdir(out, { recursive: true });
  const only = args.only?.split(',').map((id) => id.trim());
  const measured =
    args['from-report'] === undefined
      ? await measureAll({
          lane,
          only,
          runs: args.runs === undefined ? undefined : Number(args.runs),
          form: args.form === 'dev' ? 'dev' : 'packaged',
          out,
        })
      : await fromReport(args['from-report'], lane, only);
  const host = 'host' in measured ? measured.host : thisHost();
  // `win32-x64` → `win32`
  const platform = host.platform.split('-')[0] ?? process.platform;
  const baselines = await readBaselines(platform, machine, lane);
  const verdicts = measured.wanted.flatMap((metric) => {
    const runs = measured.values[metric.id] ?? [];
    if (runs.length === 0) return [];
    return [
      judge(metric, quantile(runs, 0.5), {
        platform,
        baseline: baselines[metric.id],
        absolute: args.absolute,
        runs: runs.length,
      }),
    ];
  });
  const missing = measured.wanted
    .filter((m) => !verdicts.some((v) => v.id === m.id))
    .map((m) => `${m.id}: not measured`);
  // Recording a baseline is how an unjudged value gets judged next time.
  const nothingJudged =
    args['update-baseline'] === undefined ? unjudged(verdicts, args.absolute) : [];
  const report = {
    date: new Date().toISOString(),
    lane,
    machine,
    ...host,
    absolute: args.absolute,
    verdicts,
    runs: measured.values,
    errors: [...measured.errors, ...missing, ...nothingJudged],
  };
  // A judged report of another machine is not rewritten (it may be the file just read).
  if (!('host' in measured)) {
    await writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(
    `\n${'metric'.padEnd(28)}${'value'.padStart(12)}${'budget'.padStart(10)}${'baseline'.padStart(12)}  runs`,
  );
  for (const v of verdicts) {
    const mark = v.overBudget || v.regressed ? '✗' : '✓';
    const f = (/** @type {number | undefined} */ n) =>
      n === undefined ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(2);
    console.log(
      `${mark} ${v.id.padEnd(26)}${`${f(v.value)} ${v.unit}`.padStart(12)}${f(v.budget).padStart(10)}${f(v.baseline).padStart(12)}  ${String(v.runs)}`,
    );
  }
  const failed = [...failures(verdicts), ...report.errors];
  for (const line of failed) console.error(`FAIL ${line}`);
  if (args['update-baseline'] !== undefined) {
    if (args['update-baseline'].trim() === '') throw new Error('--update-baseline needs a reason');
    // A failed probe or a missing metric would record a stale or partial baseline (R5).
    if (report.errors.length > 0) {
      throw new Error('--update-baseline refuses a run with errors; fix them and measure again');
    }
    const file = baselineFile(platform, machine, lane);
    /** @type {unknown} */
    const previous = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));
    const kept = isRecord(previous) && isRecord(previous.values) ? previous.values : {};
    const values = { ...kept, ...Object.fromEntries(verdicts.map((v) => [v.id, v.value])) };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify(
        {
          machine,
          lane,
          platform: report.platform,
          cpu: report.cpu,
          updated: 'host' in measured ? measured.measuredAt : report.date,
          reason: args['update-baseline'],
          values,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`wrote ${path.relative(repoRoot, file)}`);
  }
  if (!('host' in measured)) {
    console.log(`report: ${path.relative(repoRoot, path.join(out, 'report.json'))}`);
  }
  if (failed.length > 0) process.exitCode = 1;
}

if (isMain(import.meta.url)) await main();
