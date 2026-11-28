// Voice dictation probe (voice dictation addendum 3.10): the synthetic corpus of
// scripts/speech/corpus.json played twice through the production pipeline
// (crates/piarc-speech/examples/voice-bench.rs, a warm engine at real-time pace) gives at least
// 60 samples of the first partial after the first speech and of stop to the last final, the
// CPU real-time factor per file (process CPU time over audio time, an upper bound for the
// decoder's own), 20 cold loads (models freed before each start) and the physical footprint
// (`footprint`) while active and after the idle timeout, each against the footprint before any
// model was loaded. Measures Core's speech engine, not the app's other processes.
//
//   node scripts/perf/probe-voice.mjs --out <file.json>
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { isMain, isRecord, repoRoot } from '../lib/repo.mjs';
import { bench, prepareCorpus } from '../speech/eval.mjs';

/**
 * The 95th percentile (nearest rank) of `values`.
 * @param {readonly number[]} values
 */
export function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? Number.NaN;
}

/**
 * The numbers of `key` across the items of `reports`.
 * @param {readonly Record<string, unknown>[]} reports
 * @param {string} key
 */
function samples(reports, key) {
  return reports.flatMap((report) =>
    Array.isArray(report.items)
      ? report.items.flatMap((/** @type {unknown} */ item) =>
          isRecord(item) && typeof item[key] === 'number' ? [item[key]] : [],
        )
      : [],
  );
}

/**
 * @param {Record<string, unknown>} report
 * @param {string} key
 */
function footprint(report, key) {
  const value = isRecord(report.footprintMiB) ? report.footprintMiB[key] : undefined;
  return typeof value === 'number' ? value : Number.NaN;
}

export async function measure() {
  const assets = path.join(
    repoRoot,
    'target',
    'speech-assets',
    `${process.platform}-${process.arch}`,
  );
  const { files } = await prepareCorpus();
  const first = await bench(assets, files, { hotwords: true, cold: 20 });
  const second = await bench(assets, files, { hotwords: true });
  const reports = [first, second];
  const firstPartial = samples(reports, 'firstPartialMs');
  const stopToFinal = samples(reports, 'stopToFinalMs');
  const rtf = samples(reports, 'cpuRtf');
  const cold = Array.isArray(first.coldLoadMs)
    ? first.coldLoadMs.filter((/** @type {unknown} */ v) => typeof v === 'number')
    : [];
  const baseline = footprint(first, 'baseline');
  return {
    values: {
      'voice-first-partial': p95(firstPartial),
      'voice-cold-load': p95(cold),
      'voice-stop-to-final': p95(stopToFinal),
      'voice-rtf': p95(rtf),
      'voice-active-footprint': footprint(first, 'activeMax') - baseline,
      'voice-idle-footprint': footprint(first, 'afterIdleTimeout') - baseline,
    },
    samples: firstPartial.length,
    detail: {
      firstPartialSamples: firstPartial.length,
      stopToFinalSamples: stopToFinal.length,
      coldSamples: cold.length,
      footprintMiB: first.footprintMiB,
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: { form: { type: 'string' }, lane: { type: 'string' }, out: { type: 'string' } },
  });
  const result = await measure();
  console.log(JSON.stringify(result, null, 2));
  if (values.out !== undefined) {
    await mkdir(path.dirname(values.out), { recursive: true });
    await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
  }
}

if (isMain(import.meta.url)) await main();
