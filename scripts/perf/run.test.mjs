// A failed load generator can leave usable-looking timings behind. A later run or a rejudgement must retain the failure.
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { PROBES } from './run.mjs';

vi.mock('node:child_process', async () => ({
  ...(await vi.importActual('node:child_process')),
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    queueMicrotask(() => child.emit('close', 1));
    return child;
  },
}));

/** @param {string} name */
function probeNamed(name) {
  const probe = PROBES[name];
  if (probe === undefined) throw new Error(`missing probe ${name}`);
  return probe;
}

it('rejects a failed transcript workload even when it wrote timings', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'piarc invalid transcript '));
  try {
    for (const name of ['t19.bench-stale', 't44-transcript.bench-stale']) {
      const dir = path.join(out, 'transcript', name);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'timings.json'),
        JSON.stringify({
          streaming: { measuredTokensPerSecond: 98, frameWorkMs: { p99: 7 }, longTasksMs: [] },
          scrolling: { fps: 60 },
          coldMs: [50],
          cachedMs: [25],
        }),
      );
    }
    await expect(
      probeNamed('transcript').run({ out, form: 'packaged', lane: 'pr' }),
    ).rejects.toThrow(/transcript.*exit 1/u);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

it.each([
  ['cold-start', 'cold-start.json'],
  ['event-channel', 'event-channel.json'],
  ['terminal', 'terminal.json'],
  ['sessions', 'probe-sessions.json'],
])('does not allow a failed %s process to reuse an earlier result', async (probe, file) => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'piarc stale report '));
  try {
    await writeFile(
      path.join(out, file),
      JSON.stringify({
        medianMs: 450,
        maxMs: 460,
        budgetMs: 1000,
        timingsMs: [450, 450, 450, 450, 460],
        values: { 'main-loop-p99': 2 },
        idle: { mainRssMb: { median: 180 }, bareElectronMainRssMb: { median: 155 } },
        throughput: { forwardMs: { p95: 0.5, count: 100 } },
        cat: { loopDelayMs: { p99: 3 } },
        echo: {},
      }),
    );
    await expect(probeNamed(probe).run({ out, form: 'packaged', lane: 'pr' })).rejects.toThrow(
      /exit 1/u,
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

it('does not turn a partially failed imported run into a passing report', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'piarc imported run '));
  try {
    const source = path.join(out, 'report.json');
    await writeFile(
      source,
      JSON.stringify({
        platform: 'darwin-arm64',
        lane: 'pr',
        runs: { 'cold-start': [450] },
        errors: ['transcript: load generator stopped before the target rate'],
      }),
    );
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(
      process.execPath,
      [
        'scripts/perf/run.mjs',
        '--lane',
        'pr',
        '--absolute',
        '--only',
        'cold-start',
        '--from-report',
        source,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('load generator stopped');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

it('can judge an older complete measurement that originally had no baseline', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'piarc unjudged run '));
  try {
    const source = path.join(out, 'report.json');
    await writeFile(
      source,
      JSON.stringify({
        platform: 'darwin-arm64',
        lane: 'pr',
        runs: { 'cold-start': [450] },
        errors: [
          'cold-start: no baseline for this platform, machine class and lane, and no --absolute: nothing judged 450 ms',
        ],
      }),
    );
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(
      process.execPath,
      [
        'scripts/perf/run.mjs',
        '--lane',
        'pr',
        '--absolute',
        '--only',
        'cold-start',
        '--from-report',
        source,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
