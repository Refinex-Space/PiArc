// The two judgements of every measured value (T44): against chapter 11's absolute budget (on
// the reference machine or a named local one; CI runners differ from the reference machines, so
// there only the second applies), and against the baseline of the same platform and machine
// class: a regression of more than 10% (and more than the metric's `floor`) fails. Baselines are
// committed per platform, machine class and lane (the PR smoke's loads are shorter than
// Nightly's, so their values differ) and change only through
// `node scripts/perf/run.mjs --lane <lane> --update-baseline "<reason>"`.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { isRecord, repoRoot } from '../lib/repo.mjs';
import { budgetOf } from './metrics.mjs';

/** A regression of more than this share fails. */
export const REGRESSION = 0.1;

export const BASELINES = path.join(repoRoot, 'scripts', 'perf', 'baselines');

/**
 * @typedef {import('./metrics.mjs').Metric} Metric
 * @typedef {{
 *   id: string,
 *   row: string | null,
 *   unit: string,
 *   value: number,
 *   runs: number,
 *   budget: number,
 *   baseline: number | undefined,
 *   overBudget: boolean,
 *   regressed: boolean,
 * }} Verdict
 */

/**
 * The verdict of `value` for `metric`.
 * @param {Metric} metric
 * @param {number} value
 * @param {{ platform: string, baseline: number | undefined, absolute: boolean, runs: number }} context
 * @returns {Verdict}
 */
export function judge(metric, value, context) {
  const budget = budgetOf(metric, context.platform);
  const worse = metric.better === 'lower' ? value - budget : budget - value;
  // A value that is not a number is a broken probe: it fails with or without budgets (R5).
  const overBudget = !Number.isFinite(value) || (context.absolute && worse > 0);
  let regressed = false;
  if (context.baseline !== undefined && Number.isFinite(value)) {
    const change = metric.better === 'lower' ? value - context.baseline : context.baseline - value;
    regressed = change > metric.floor && change > Math.abs(context.baseline) * REGRESSION;
  }
  return {
    id: metric.id,
    row: metric.row,
    unit: metric.unit,
    value,
    runs: context.runs,
    budget,
    baseline: context.baseline,
    overBudget,
    regressed,
  };
}

/**
 * The failure lines of `verdicts`: metric, budget, baseline, current value and runs.
 * @param {readonly Verdict[]} verdicts
 * @returns {string[]}
 */
export function failures(verdicts) {
  const fmt = (/** @type {number | undefined} */ n) =>
    n === undefined ? 'none' : Number.isInteger(n) ? String(n) : n.toFixed(2);
  return verdicts.flatMap((v) => {
    const what = `${v.id}: current ${fmt(v.value)} ${v.unit} (median of ${String(v.runs)} runs), budget ${fmt(v.budget)} ${v.unit}, baseline ${fmt(v.baseline)}${v.baseline === undefined ? '' : ` ${v.unit}`}`;
    return [
      ...(v.overBudget ? [`over budget — ${what}`] : []),
      ...(v.regressed ? [`regressed more than ${String(REGRESSION * 100)}% — ${what}`] : []),
    ];
  });
}

export const NO_BASELINE_REASON =
  'no baseline for this platform, machine class and lane, and no --absolute: nothing judged';

/**
 * The lines for values that nothing judged: no baseline for this platform, machine class and
 * lane, and no `--absolute`. A run like that would pass whatever it measured (R5: CI runners
 * had no baselines), so it fails until a baseline is recorded or budgets apply.
 * @param {readonly Verdict[]} verdicts
 * @param {boolean} absolute
 * @returns {string[]}
 */
export function unjudged(verdicts, absolute) {
  if (absolute) return [];
  return verdicts
    .filter((v) => v.baseline === undefined)
    .map(
      (v) =>
        `${v.id}: ${NO_BASELINE_REASON} ${Number.isInteger(v.value) ? String(v.value) : v.value.toFixed(2)} ${v.unit}`,
    );
}

/**
 * The machine class of this run: `PIARC_PERF_MACHINE`, else the CI runner, else `local`.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function machineClass(env = process.env) {
  if (env.PIARC_PERF_MACHINE !== undefined && env.PIARC_PERF_MACHINE !== '') {
    return env.PIARC_PERF_MACHINE;
  }
  return env.CI === 'true' ? `github-${process.arch}` : 'local';
}

/**
 * The file of the baselines of `lane` for `platform` on `machine`.
 * @param {string} platform
 * @param {string} machine
 * @param {string} lane
 */
export function baselineFile(platform, machine, lane) {
  return path.join(BASELINES, `${platform}-${machine}-${lane}.json`);
}

/**
 * The baseline values (by metric id) of `lane` for `platform` on `machine`; empty when none
 * were recorded (no file). A file that cannot be read or parsed throws.
 * @param {string} platform
 * @param {string} machine
 * @param {string} lane
 * @returns {Promise<Record<string, number>>}
 */
export async function readBaselines(platform, machine, lane) {
  const file = baselineFile(platform, machine, lane);
  /** @type {string} */
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return {};
    throw error;
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // A broken file must not turn the regression check off without a word (R5).
    throw new Error(`${path.relative(repoRoot, file)} is not valid JSON`, { cause: error });
  }
  if (!isRecord(parsed) || !isRecord(parsed.values)) return {};
  /** @type {Record<string, number>} */
  const values = {};
  for (const [id, value] of Object.entries(parsed.values)) {
    if (typeof value === 'number') values[id] = value;
  }
  return values;
}
