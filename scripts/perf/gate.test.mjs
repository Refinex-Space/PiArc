import { describe, expect, it } from 'vitest';

import path from 'node:path';

import { baselineFile, failures, judge, machineClass, readBaselines } from './gate.mjs';

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
});
