// Single entry point for every repository check (`npm run verify`).
// Runs all steps in order even after a failure, so one run shows every
// problem, then prints a summary table. Exit code 1 if any step failed.
//
// A run where every step passed on a clean tree records its commit in
// target/verify/last-pass.json. `npm run verify -- --baseline` (a task's start check) reuses
// that result when everything committed since touches only docs/: it then runs only the
// steps those files can affect (Prettier on them, the acceptance list). Any other change, a
// dirty tree or a missing record runs every step.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  capture,
  isMain,
  isRecord,
  readJsonFile,
  repoRoot,
  resolveBin,
  run,
} from '../lib/repo.mjs';
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
  // Before ESLint: type-aware lint reads workspace packages (`@piarc/protocol`) from their
  // built declarations, which are stale or missing until the build refreshes them.
  { name: 'tsc --build', command: nodeBin('typescript', ['--build'], 'tsc') },
  { name: 'ESLint', command: nodeBin('eslint', ['.']) },
  // Builds the Core module the Vitest integration tests load, and checks its .d.ts snapshot.
  { name: 'Core module + API snapshot', command: nodeScript('scripts/ci/check-core-types.mjs') },
  { name: 'Vitest', command: nodeBin('vitest', ['run']) },
  { name: 'cargo fmt --check', command: cargo(['fmt', '--all', '--check']) },
  {
    name: 'cargo clippy',
    command: cargo(['clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings']),
  },
  // Timing tests run alone after the others (scripts/ci/cargo-test.mjs).
  { name: 'cargo test', command: nodeScript('scripts/ci/cargo-test.mjs') },
  { name: 'protocol drift', command: nodeScript('scripts/ci/check-protocol-drift.mjs') },
  { name: 'contract samples', command: nodeScript('scripts/ci/check-contract-samples.mjs') },
  { name: 'cargo-deny', command: cargoDeny },
  { name: 'crate dependency rules', command: nodeScript('scripts/ci/check-crate-deps.mjs') },
  { name: 'acceptance list', command: nodeScript('scripts/plan/check-acceptance.mjs') },
  // Agent Host bundle, every L2 scenario, capability coverage and capabilities.md drift.
  { name: 'L2 scenarios + capabilities', command: nodeScript('scripts/ci/run-l2.mjs') },
  // Generated CSS and TS match design/tokens/, WCAG contrast in four modes, brand rules.
  { name: 'design tokens', command: nodeScript('scripts/ci/check-design-tokens.mjs') },
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

const LAST_PASS = path.join(repoRoot, 'target', 'verify', 'last-pass.json');

/**
 * Whether the files changed since the last fully passing run allow reusing it: all under
 * `docs/` (plans, ADRs, architecture, acceptance list), none elsewhere.
 * @param {string[]} changed repository-relative paths with `/`
 */
export function canReuse(changed) {
  return changed.every((file) => file.startsWith('docs/'));
}

/** @returns {Promise<string>} */
async function head() {
  return (await capture('git', ['rev-parse', 'HEAD'])).trim();
}

/** @returns {Promise<boolean>} */
async function clean() {
  return (await capture('git', ['status', '--porcelain'])).trim() === '';
}

/**
 * The steps for `--baseline`: undefined runs all of them.
 * @returns {Promise<Step[] | undefined>}
 */
async function baselineSteps() {
  if (!existsSync(LAST_PASS) || !(await clean())) return undefined;
  const record = await readJsonFile(LAST_PASS);
  if (!isRecord(record) || typeof record.head !== 'string') return undefined;
  const passed = record.head;
  let changed;
  try {
    await capture('git', ['merge-base', '--is-ancestor', passed, 'HEAD']);
    changed = (await capture('git', ['diff', '--name-only', passed, 'HEAD']))
      .split('\n')
      .filter((line) => line !== '');
  } catch {
    return undefined;
  }
  if (!canReuse(changed)) return undefined;
  console.log(
    `verify passed in full at ${passed.slice(0, 7)}; since then only docs/ changed (${String(changed.length)} files): reusing it`,
  );
  const formatted = changed.filter((file) => !file.endsWith('.md') && existsSync(file));
  /** @type {Step[]} */
  const steps = [];
  if (formatted.length > 0) {
    steps.push({
      name: 'Prettier --check (changed)',
      command: nodeBin('prettier', ['--check', ...formatted]),
    });
  }
  const acceptance = STEPS.find((step) => step.name === 'acceptance list');
  if (acceptance !== undefined) steps.push(acceptance);
  return steps;
}

async function main() {
  const steps = (process.argv.includes('--baseline') ? await baselineSteps() : undefined) ?? STEPS;
  const full = steps === STEPS;
  /** @type {{ name: string, ok: boolean, ms: number }[]} */
  const results = [];
  for (const [index, step] of steps.entries()) {
    const label = `[${String(index + 1)}/${String(steps.length)}] ${step.name}`;
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
    if (full && (await clean())) {
      await mkdir(path.dirname(LAST_PASS), { recursive: true });
      await writeFile(LAST_PASS, JSON.stringify({ head: await head() }) + '\n');
    }
  }
}

if (isMain(import.meta.url)) {
  await main();
}
