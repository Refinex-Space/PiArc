// The L2 step of `npm run verify` (docs/engineering/testing.md section 12):
//
// 1. builds the Agent Host bundle (scripts/dev/build-agent-host.mjs);
// 2. runs every scenario of tests/scenarios/ as its own test
//    (`cargo test -p piarc-testkit --test scenarios`), writing the JSON report to
//    target/l2/results.json;
// 3. checks the capability list and its coverage by that report (MISSING), and that
//    docs/product/capabilities.md matches what the list and the report generate.
//
// Every part runs even after a failure, so one run shows every problem.
// Usage: node scripts/ci/run-l2.mjs   (exit code 1 when a part failed)
import { rmSync } from 'node:fs';
import path from 'node:path';

import { isMain, repoRoot, run } from '../lib/repo.mjs';

export const REPORT = path.join('target', 'l2', 'results.json');

/** @returns {Array<{ name: string, cmd: string, args: string[] }>} */
export function parts() {
  return [
    {
      name: 'Agent Host bundle',
      cmd: process.execPath,
      args: [path.join(repoRoot, 'scripts', 'dev', 'build-agent-host.mjs')],
    },
    {
      name: 'L2 scenarios',
      cmd: 'cargo',
      args: [
        'test',
        '-p',
        'piarc-testkit',
        '--test',
        'scenarios',
        '--locked',
        '--',
        '--results',
        REPORT,
      ],
    },
    {
      name: 'capability coverage and capabilities.md',
      cmd: process.execPath,
      args: [
        path.join(repoRoot, 'scripts', 'ci', 'check-capabilities.mjs'),
        '--results',
        path.join(repoRoot, REPORT),
        '--doc',
        'check',
      ],
    },
  ];
}

async function main() {
  // A report left by an earlier run must never stand in for this one.
  rmSync(path.join(repoRoot, REPORT), { force: true });
  let failed = 0;
  for (const part of parts()) {
    console.log(`\n· ${part.name}`);
    const code = await run(part.cmd, part.args);
    if (code !== 0) {
      console.error(`✖ ${part.name} failed (exit ${String(code)})`);
      failed += 1;
    }
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) {
  await main();
}
