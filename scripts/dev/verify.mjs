// Single entry point for every repository check (`npm run verify`).
// Runs all steps in order even after a failure, so one run shows every
// problem, then prints a summary table. Exit code 1 if any step failed.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { isMain, repoRoot, resolveBin, run } from '../lib/repo.mjs';
import { localToolPath } from './install-tools.mjs';

/**
 * @typedef {{ name: string, command: () => { cmd: string, args: string[] } }} Step
 */

/**
 * @param {string} packageName
 * @param {string[]} args
 * @param {string} [binName]
 */
function nodeBin(packageName, args, binName) {
  return () => ({ cmd: process.execPath, args: [resolveBin(packageName, binName), ...args] });
}

/**
 * @param {string} script path relative to the repository root
 */
function nodeScript(script) {
  return () => ({ cmd: process.execPath, args: [path.join(repoRoot, script)] });
}

/**
 * @param {string[]} args
 */
function cargo(args) {
  return () => ({ cmd: 'cargo', args });
}

/** Prefers the repo-local cargo-deny, then one on PATH. */
function cargoDeny() {
  const local = localToolPath('cargo-deny');
  return {
    cmd: existsSync(local) ? local : 'cargo-deny',
    args: ['check'],
  };
}

/** @type {Step[]} */
export const STEPS = [
  { name: 'Prettier --check', command: nodeBin('prettier', ['--check', '.']) },
  { name: 'ESLint', command: nodeBin('eslint', ['.']) },
  { name: 'tsc --build', command: nodeBin('typescript', ['--build'], 'tsc') },
  // Builds the Core module the Vitest integration tests load, and checks its .d.ts snapshot.
  { name: 'Core module + API snapshot', command: nodeScript('scripts/ci/check-core-types.mjs') },
  { name: 'Vitest', command: nodeBin('vitest', ['run']) },
  { name: 'cargo fmt --check', command: cargo(['fmt', '--all', '--check']) },
  {
    name: 'cargo clippy',
    command: cargo(['clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings']),
  },
  { name: 'cargo test', command: cargo(['test', '--workspace', '--locked']) },
  { name: 'protocol drift', command: nodeScript('scripts/ci/check-protocol-drift.mjs') },
  { name: 'contract samples', command: nodeScript('scripts/ci/check-contract-samples.mjs') },
  { name: 'cargo-deny', command: cargoDeny },
  { name: 'crate dependency rules', command: nodeScript('scripts/ci/check-crate-deps.mjs') },
  { name: 'acceptance list', command: nodeScript('scripts/plan/check-acceptance.mjs') },
  // Agent Host bundle, every L2 scenario, capability coverage and capabilities.md drift.
  { name: 'L2 scenarios + capabilities', command: nodeScript('scripts/ci/run-l2.mjs') },
];

/**
 * @param {number} ms
 */
function formatDuration(ms) {
  return ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * @param {{ name: string, ok: boolean, ms: number }[]} results
 */
function printSummary(results) {
  const nameWidth = Math.max(4, ...results.map((r) => r.name.length));
  const line = `+${'-'.repeat(5)}+${'-'.repeat(nameWidth + 2)}+${'-'.repeat(8)}+${'-'.repeat(10)}+`;
  console.log('\nverify summary');
  console.log(line);
  console.log(`| #   | ${'Step'.padEnd(nameWidth)} | Result | Time     |`);
  console.log(line);
  results.forEach((r, i) => {
    const index = String(i + 1).padEnd(3);
    const result = (r.ok ? 'PASS' : 'FAIL').padEnd(6);
    console.log(
      `| ${index} | ${r.name.padEnd(nameWidth)} | ${result} | ${formatDuration(r.ms).padStart(8)} |`,
    );
  });
  console.log(line);
}

async function main() {
  /** @type {{ name: string, ok: boolean, ms: number }[]} */
  const results = [];
  for (const [index, step] of STEPS.entries()) {
    const label = `[${String(index + 1)}/${String(STEPS.length)}] ${step.name}`;
    console.log(`\n▶ ${label}`);
    const started = performance.now();
    let code;
    try {
      const resolved = step.command();
      code = await run(resolved.cmd, resolved.args);
      if (code === 127 && resolved.cmd === 'cargo-deny') {
        console.error(
          'cargo-deny was not found. Install the pinned version with: node scripts/dev/install-tools.mjs',
        );
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      code = 1;
    }
    const ms = performance.now() - started;
    const ok = code === 0;
    console.log(`${ok ? '✔' : '✖'} ${label}: ${ok ? 'passed' : `failed (exit ${String(code)})`}`);
    results.push({ name: step.name, ok, ms });
  }
  printSummary(results);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${String(failed.length)} of ${String(results.length)} steps failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${String(results.length)} steps passed.`);
  }
}

if (isMain(import.meta.url)) {
  await main();
}
