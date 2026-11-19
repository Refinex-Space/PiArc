// The cargo test step of `npm run verify` (docs/engineering/testing.md section 2): every
// workspace test, then each timing test on its own, as the AHP round trip runs in a test binary
// of its own (section 11): a timing test runs while no other test runs.
// Run with the rest of its test binary on a shared CI runner, a timing test measures the
// processes the other tests start in parallel more than the code: two runs a commit apart
// measured a permission decision p50 of 0.84 ms and 1.44 ms, every kind of call slower alike,
// while the second commit was faster locally.
//
// Both parts run even after a failure, so one run shows every problem. A timing test keeps
// its assertion and has no skip condition; plain `cargo test` still runs it with the others.
// Usage: node scripts/ci/cargo-test.mjs   (exit code 1 when a part failed)
import { isMain, run } from '../lib/repo.mjs';

/** Timing tests run alone: package, test target and the test's full name. */
export const TIMED = [
  {
    pkg: 'piarc-core',
    target: ['--lib'],
    name: 'tool_io::policy::tests::automatic_decision_latency',
  },
];

/** @returns {Array<{ name: string, cmd: string, args: string[] }>} */
export function parts() {
  const skip = TIMED.flatMap((test) => ['--skip', test.name]);
  return [
    {
      name: 'workspace tests',
      cmd: 'cargo',
      args: ['test', '--workspace', '--locked', '--', ...skip],
    },
    ...TIMED.map((test) => ({
      name: `${test.name} alone`,
      cmd: 'cargo',
      args: [
        'test',
        '-p',
        test.pkg,
        ...test.target,
        '--locked',
        test.name,
        '--',
        '--exact',
        '--nocapture',
      ],
    })),
  ];
}

async function main() {
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
