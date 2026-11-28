// T44-A02: the PR pipeline runs the performance smoke on macOS and Windows, and the Nightly
// workflow runs the full measurement and the shortened long run on both; the files parse.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { isRecord, repoRoot } from '../lib/repo.mjs';

/**
 * The `run` commands of `job` in `file`, and the job's matrix OSes.
 * @param {string} file
 * @param {string} job
 */
async function job(file, job) {
  /** @type {unknown} */
  const doc = parse(await readFile(path.join(repoRoot, '.github', 'workflows', file), 'utf8'));
  const jobs = isRecord(doc) && isRecord(doc.jobs) ? doc.jobs : {};
  const found = jobs[job];
  if (!isRecord(found)) throw new Error(`${file} has no job ${job}`);
  const steps = Array.isArray(found.steps) ? found.steps : [];
  const matrix =
    isRecord(found.strategy) && isRecord(found.strategy.matrix) ? found.strategy.matrix : {};
  return {
    steps: steps.filter(isRecord),
    runs: steps.flatMap((step) =>
      isRecord(step) && typeof step.run === 'string' ? [step.run] : [],
    ),
    os: Array.isArray(matrix.os) ? matrix.os : [],
    env: steps.flatMap((step) => (isRecord(step) && isRecord(step.env) ? [step.env] : [])),
  };
}

describe('performance pipelines', () => {
  it('runs the PR smoke on both platforms', async () => {
    const desktop = await job('ci.yml', 'desktop');
    expect(desktop.os).toEqual(['macos-latest', 'windows-latest']);
    expect(desktop.runs).toContain('node scripts/perf/run.mjs --lane pr --runs 3');
  });

  it('runs the full measurement and the one-hour long run nightly on both platforms', async () => {
    const nightly = await job('perf-nightly.yml', 'perf');
    expect(nightly.os).toEqual(['macos-latest', 'windows-latest']);
    expect(nightly.runs).toContain('node scripts/perf/run.mjs --lane nightly');
    expect(nightly.runs).toContain('node scripts/perf/run.mjs --lane long');
    expect(nightly.env).toContainEqual({ PIARC_LONG_RUN_HOURS: '1' });
  });
});

it('keeps release checks scheduled when an independent desktop test fails', async () => {
  const { steps } = await job('ci.yml', 'desktop');
  const development = steps.find((step) => step.name === 'Package the development flavor');
  const release = steps.find((step) => step.name === 'Package the release flavor');
  expect(development?.id).toBe('development');
  expect(release?.id).toBe('release');
  expect(release?.if).toBe("${{ !cancelled() && steps.development.outcome == 'success' }}");
  for (const command of [
    'npm run check:fuses',
    'node scripts/ci/check-release-runtime.mjs',
    'node scripts/ci/check-app-layout.mjs --flavor release',
  ]) {
    expect(steps.find((step) => step.run === command)?.if).toBe(
      "${{ !cancelled() && steps.release.outcome == 'success' }}",
    );
  }
});
