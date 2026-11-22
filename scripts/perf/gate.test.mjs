import { describe, expect, it } from 'vitest';

import path from 'node:path';

import { mkdir, rm, writeFile } from 'node:fs/promises';

import { baselineFile, failures, judge, machineClass, readBaselines, unjudged } from './gate.mjs';

const latency = /** @type {import('./metrics.mjs').Metric} */ ({
  id: 'x-p95',
  row: 'X',
  probe: 'x',
  unit: 'ms',
  better: 'lower',
  budget: { darwin: 2, win32: 10 },
  lanes: ['pr'],
  floor: 0.1,
  how: '',
});
const fps = /** @type {import('./metrics.mjs').Metric} */ ({
  ...latency,
  id: 'fps',
  unit: 'fps',
  better: 'higher',
  budget: 60,
  floor: 2,
});

describe('judge', () => {
  it('fails a value over the platform budget only when budgets apply', () => {
    const at = { baseline: undefined, runs: 3 };
    expect(judge(latency, 3, { ...at, platform: 'darwin', absolute: true }).overBudget).toBe(true);
    expect(judge(latency, 3, { ...at, platform: 'win32', absolute: true }).overBudget).toBe(false);
    expect(judge(latency, 3, { ...at, platform: 'darwin', absolute: false }).overBudget).toBe(
      false,
    );
    expect(judge(fps, 59, { ...at, platform: 'darwin', absolute: true }).overBudget).toBe(true);
  });

  it('fails a regression of more than 10% and more than the floor', () => {
    const at = { platform: 'darwin', absolute: false, runs: 3 };
    expect(judge(latency, 1.2, { ...at, baseline: 1 }).regressed).toBe(true);
    expect(judge(latency, 1.09, { ...at, baseline: 1 }).regressed).toBe(false);
    // 50% worse, but only 0.05 ms: noise.
    expect(judge(latency, 0.15, { ...at, baseline: 0.1 }).regressed).toBe(false);
    expect(judge(fps, 50, { ...at, baseline: 60 }).regressed).toBe(true);
    expect(judge(fps, 70, { ...at, baseline: 60 }).regressed).toBe(false);
  });

  it('fails a value that is not a number whether or not budgets apply (R5)', () => {
    const at = { platform: 'darwin', absolute: false, runs: 3, baseline: 1 };
    for (const value of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      expect(judge(latency, value, at).overBudget).toBe(true);
    }
  });

  it('fails the first count over a baseline of zero (R5)', () => {
    const count = { ...latency, id: 'long-tasks', unit: 'tasks', budget: 0, floor: 0 };
    const at = { platform: 'darwin', absolute: false, runs: 1, baseline: 0 };
    expect(judge(count, 1, at).regressed).toBe(true);
    expect(judge(count, 0, at).regressed).toBe(false);
  });

  it('names the metric, budget, baseline and current value of each failure', () => {
    const verdict = judge(latency, 2.5, {
      platform: 'darwin',
      absolute: true,
      baseline: 0.7,
      runs: 5,
    });
    expect(failures([verdict])).toEqual([
      'over budget — x-p95: current 2.50 ms (median of 5 runs), budget 2 ms, baseline 0.70 ms',
      'regressed more than 10% — x-p95: current 2.50 ms (median of 5 runs), budget 2 ms, baseline 0.70 ms',
    ]);
  });
});

describe('unjudged', () => {
  it('names each value that neither a baseline nor a budget judged (R5)', () => {
    const at = { platform: 'darwin', runs: 3 };
    const none = judge(latency, 1, { ...at, absolute: false, baseline: undefined });
    const based = judge(latency, 1, { ...at, absolute: false, baseline: 1 });
    expect(unjudged([none, based], false)).toEqual([
      'x-p95: no baseline for this platform, machine class and lane, and no --absolute: nothing judged 1 ms',
    ]);
    expect(unjudged([none, based], true)).toEqual([]);
  });
});

describe('machineClass', () => {
  it('prefers the named machine, then CI, then local', () => {
    expect(machineClass({ PIARC_PERF_MACHINE: 'm1-pro' })).toBe('m1-pro');
    expect(machineClass({ CI: 'true' })).toBe(`github-${process.arch}`);
    expect(machineClass({})).toBe('local');
  });
});

describe('baselines', () => {
  it('are kept per platform, machine class and lane', () => {
    expect(path.basename(baselineFile('win32', 'github-x64', 'pr'))).toBe(
      'win32-github-x64-pr.json',
    );
    expect(baselineFile('darwin', 'local', 'pr')).not.toBe(
      baselineFile('darwin', 'local', 'nightly'),
    );
  });

  it('are empty for a machine class without a file', async () => {
    expect(await readBaselines('darwin', 'no-such-machine', 'pr')).toEqual({});
  });

  it('fail when the file is there but broken, rather than judging nothing (R5)', async () => {
    const file = baselineFile('darwin', 'r5-broken-test', 'pr');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ not json');
    try {
      await expect(readBaselines('darwin', 'r5-broken-test', 'pr')).rejects.toThrow(
        /r5-broken-test/u,
      );
    } finally {
      await rm(file, { force: true });
    }
  });
});
