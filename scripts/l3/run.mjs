// `npm run l3` (T30, architecture section 12.5): the whole L3 comparison in one command.
//
//  1. prerequisites: `claude` on PATH (its version goes into the report), the scenarios
//     (tests/l3/scenarios/) and tests/l3-allowlist.yaml, and the coverage of the compared
//     L2 areas (every perm-, policy-, hooks- and config- scenario mirrored or excluded);
//  2. a snapshot of ~/.claude and ~/.claude.json;
//  3. the PiArc side: each scenario as an L2 scenario through `piarc-devcli l3`;
//  4. the Claude Code side: each scenario through `claude -p` (scripts/l3/claude-side.mjs);
//  5. the recording check (scripts/l3/check-recordings.mjs);
//  6. normalization, the structural diff and the allowlist; with --repeat n, each side's
//     runs must also normalize to the same document;
//  7. the report: tmp/l3/report.md and tmp/l3/results.json, then the ~/.claude comparison.
//
// Usage: npm run l3 [-- --filter <text>]... [--repeat <n>]
// Exit 1 when anything is unexplained, stale, not repeatable or failed; exit 2 for a usage
// or prerequisite problem (no `claude` on PATH).
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { stringify } from 'yaml';

import { capture, isMain, isRecord, repoRoot, run } from '../lib/repo.mjs';
import { applyAllowlist, parseAllowlist } from './allowlist.mjs';
import { checkRecordings } from './check-recordings.mjs';
import { claudeVersion, runClaudeSide } from './claude-side.mjs';
import { diff } from './diff.mjs';
import { snapshotChanges, snapshotClaudeHome } from './home-snapshot.mjs';
import { normalize } from './normalize.mjs';
import { claudeRecording, piarcRecording } from './recording.mjs';
import { renderReport } from './report.mjs';
import { L2_DIR, loadScenarios, piarcScenario } from './scenario.mjs';

export const OUT = path.join(repoRoot, 'tmp', 'l3');
export const ALLOWLIST = path.join(repoRoot, 'tests', 'l3-allowlist.yaml');
/** L2 scenario prefixes of the areas L3 compares (T23 permissions, T24 rules, T25 hooks). */
export const COMPARED_L2_PREFIXES = ['perm-', 'policy-', 'hooks-', 'config-'];

export const MISSING_CLAUDE = `The Claude Code CLI (\`claude\`) is not on PATH.
L3 runs the real Claude Code against the local mock provider (no Anthropic account needed).
Install the version the Nightly pins (.github/workflows/l3-nightly.yml), a global install:
  npm install -g @anthropic-ai/claude-code@<version>
then run \`npm run l3\` again (docs/engineering/testing.md section 14.1).`;

/**
 * @param {string[]} argv
 * @returns {{ filters: string[], repeat: number }}
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const filters = [];
  let repeat = 1;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--filter' && value !== undefined) {
      filters.push(value);
      i += 1;
    } else if (arg === '--repeat' && value !== undefined && Number(value) >= 1) {
      repeat = Math.floor(Number(value));
      i += 1;
    } else {
      throw new Error(`unknown argument ${String(arg)}`);
    }
  }
  return { filters, repeat };
}

/**
 * L2 scenarios of the compared areas that no L3 scenario mirrors and the allowlist does not
 * exclude, and exclusions that name no scenario.
 * @param {import('./scenario.mjs').Scenario[]} scenarios
 * @param {import('./allowlist.mjs').Exclusion[]} excluded
 * @param {string[]} l2Ids
 * @returns {string[]}
 */
export function coverageProblems(scenarios, excluded, l2Ids) {
  const mirrored = new Set(scenarios.flatMap((s) => s.mirrors));
  const skipped = new Set(excluded.map((e) => e.scenario));
  const l3Ids = new Set(scenarios.map((s) => s.id));
  /** @type {string[]} */
  const problems = [];
  for (const id of l2Ids.filter((l2) => COMPARED_L2_PREFIXES.some((p) => l2.startsWith(p)))) {
    if (!mirrored.has(id) && !skipped.has(id)) {
      problems.push(
        `L2 scenario ${id} is neither mirrored by an L3 scenario nor excluded in tests/l3-allowlist.yaml`,
      );
    }
    if (mirrored.has(id) && skipped.has(id)) {
      problems.push(`L2 scenario ${id} is both mirrored and excluded`);
    }
  }
  for (const e of excluded) {
    if (!l2Ids.includes(e.scenario) && !l3Ids.has(e.scenario)) {
      problems.push(`excluded scenario ${e.scenario} does not exist`);
    }
  }
  return problems;
}

/** @param {string} file @param {unknown} value */
function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function piarcVersion() {
  try {
    return (await capture('git', ['describe', '--always', '--dirty'])).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Runs the PiArc side `repeat` times; returns the recordings by scenario, one per run.
 * @param {import('./scenario.mjs').Scenario[]} scenarios
 * @param {number} repeat
 * @param {string} version
 */
async function piarcSide(scenarios, repeat, version) {
  const generated = path.join(OUT, 'piarc-scenarios');
  mkdirSync(generated, { recursive: true });
  for (const s of scenarios)
    writeFileSync(path.join(generated, `${s.id}.yaml`), stringify(piarcScenario(s)));
  /** @type {Map<string, import('./recording.mjs').Recording[]>} */
  const recordings = new Map(scenarios.map((s) => [s.id, []]));
  for (let n = 1; n <= repeat; n += 1) {
    const out = path.join(OUT, 'piarc-runs', String(n));
    const code = await run('cargo', [
      'run',
      '-q',
      '-p',
      'piarc-devcli',
      '--',
      'l3',
      generated,
      '--out',
      out,
    ]);
    if (code !== 0) throw new Error(`piarc-devcli l3 exited with ${String(code)}`);
    for (const s of scenarios) {
      const report = /** @type {unknown} */ (
        JSON.parse(readFileSync(path.join(out, `${s.id}.json`), 'utf8'))
      );
      const recording = piarcRecording(report, version);
      writeJson(path.join(OUT, 'recordings', 'piarc', `${s.id}.${String(n)}.json`), recording);
      recordings.get(s.id)?.push(recording);
    }
    // The raw run reports hold PiArc's own failure messages; only recordings stay.
    rmSync(out, { recursive: true, force: true });
  }
  return recordings;
}

/**
 * Runs the Claude Code side `repeat` times.
 * @param {import('./scenario.mjs').Scenario[]} scenarios
 * @param {number} repeat
 * @param {string} version
 */
async function claudeSide(scenarios, repeat, version) {
  /** @type {Map<string, import('./recording.mjs').Recording[]>} */
  const recordings = new Map(scenarios.map((s) => [s.id, []]));
  for (let n = 1; n <= repeat; n += 1) {
    for (const s of scenarios) {
      console.log(`claude-code ${s.id} (run ${String(n)})`);
      const recording = claudeRecording(await runClaudeSide(s), s.id, version);
      writeJson(
        path.join(OUT, 'recordings', 'claude-code', `${s.id}.${String(n)}.json`),
        recording,
      );
      recordings.get(s.id)?.push(recording);
    }
  }
  return recordings;
}

/**
 * Differences between repeated runs of one side, as `<side> run <n>: <path>`.
 * @param {string} side
 * @param {import('./recording.mjs').Recording[]} runs
 */
function repeatDifferences(side, runs) {
  const [first, ...rest] = runs.map(normalize);
  return rest.flatMap((other, i) =>
    diff(first, other).map((d) => `${side} run ${String(i + 2)} differs from run 1 at ${d.path}`),
  );
}

/**
 * Failures of a side's run: the runner's failures and main-loop requests the mock rejected.
 * Rejected auxiliary requests are expected: the mock only streams, so a non-streaming helper
 * call (Claude Code's auto-mode classifier) gets a 400, which the comparison then shows.
 * @param {import('./recording.mjs').Recording} recording
 */
function runProblems(recording) {
  const side = recording.side === 'piarc' ? 'PiArc' : 'Claude Code';
  const problems = recording.run.failures.map((f) => `${side} run failure: ${f}`);
  for (const r of recording.requests.filter(isRecord)) {
    const main = isRecord(r.structure) && r.structure.kind === 'main';
    if (main && Array.isArray(r.violations) && r.violations.length > 0) {
      problems.push(`${side} request rejected by the mock: ${r.violations.map(String).join(', ')}`);
    }
  }
  return problems;
}

async function main() {
  const { filters, repeat } = parseArgs(process.argv.slice(2));
  const version = await claudeVersion();
  if (version === undefined) {
    console.error(MISSING_CLAUDE);
    process.exitCode = 2;
    return;
  }
  const loaded = loadScenarios();
  const parsed = parseAllowlist(readFileSync(ALLOWLIST, 'utf8'));
  const l2Ids = readdirSync(L2_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => path.basename(f, '.yaml'));
  const problems = [
    ...loaded.problems,
    ...parsed.problems,
    ...coverageProblems(loaded.scenarios, parsed.allowlist.excluded, l2Ids),
  ];
  const skipped = new Set(parsed.allowlist.excluded.map((e) => e.scenario));
  const scenarios = loaded.scenarios.filter(
    (s) => !skipped.has(s.id) && (filters.length === 0 || filters.some((f) => s.id.includes(f))),
  );
  const pVersion = await piarcVersion();
  console.log(
    `L3: PiArc ${pVersion} vs Claude Code ${version}; ${String(scenarios.length)} scenario(s), ${String(repeat)} run(s) per side`,
  );
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const homeBefore = snapshotClaudeHome();
  const built = await run('cargo', [
    'build',
    '-q',
    '-p',
    'piarc-devcli',
    '-p',
    'piarc-testkit',
    '--bin',
    'piarc-devcli',
    '--bin',
    'piarc-mock-provider',
  ]);
  if (built !== 0) throw new Error('building piarc-devcli and piarc-mock-provider failed');
  const piarc = await piarcSide(scenarios, repeat, pVersion);
  const claude = await claudeSide(scenarios, repeat, version);
  const recordingCheck = checkRecordings([path.join(OUT, 'recordings')]);
  /** @type {Map<string, import('./diff.mjs').Difference[]>} */
  const differences = new Map();
  /** @type {import('./report.mjs').ScenarioResult[]} */
  const results = [];
  for (const s of scenarios) {
    const p = piarc.get(s.id) ?? [];
    const c = claude.get(s.id) ?? [];
    const [pFirst, cFirst] = [p[0], c[0]];
    if (pFirst === undefined || cFirst === undefined) continue;
    const pDoc = normalize(pFirst);
    const cDoc = normalize(cFirst);
    differences.set(s.id, diff(pDoc, cDoc));
    results.push({
      id: s.id,
      area: s.area,
      mirrors: s.mirrors,
      allowed: [],
      unexplained: [],
      piarc: pDoc,
      claude: cDoc,
      runProblems: [...runProblems(pFirst), ...runProblems(cFirst)],
      repeatDifferences: [...repeatDifferences('PiArc', p), ...repeatDifferences('Claude Code', c)],
    });
  }
  const known = loaded.scenarios.filter((s) => !skipped.has(s.id)).map((s) => s.id);
  const applied = applyAllowlist(parsed.allowlist, version, differences, known);
  for (const r of results) {
    const split = applied.results.get(r.id);
    r.allowed = split?.allowed ?? [];
    r.unexplained = split?.unexplained ?? [];
  }
  const homeAfter = snapshotClaudeHome();
  /** @type {import('./report.mjs').Results} */
  const report = {
    piarcVersion: pVersion,
    claudeVersion: version,
    scenarios: results,
    excluded: parsed.allowlist.excluded,
    stale: applied.stale,
    problems,
    recordingCheck,
    home: { files: homeBefore.size, changes: snapshotChanges(homeBefore, homeAfter) },
    repeat,
  };
  writeFileSync(path.join(OUT, 'report.md'), renderReport(report));
  writeJson(path.join(OUT, 'results.json'), report);
  const failed =
    problems.length > 0 ||
    report.stale.length > 0 ||
    recordingCheck.problems.length > 0 ||
    report.home.changes.length > 0 ||
    results.some(
      (r) => r.unexplained.length > 0 || r.runProblems.length > 0 || r.repeatDifferences.length > 0,
    );
  console.log(`\nL3 report: ${path.relative(repoRoot, path.join(OUT, 'report.md'))}`);
  for (const p of problems) console.error(`✖ ${p}`);
  for (const e of report.stale)
    console.error(
      `✖ stale allowlist entry differences[${String(e.index)}]: ${e.scenario} ${e.path}`,
    );
  for (const p of recordingCheck.problems) console.error(`✖ ${p}`);
  for (const c of report.home.changes) console.error(`✖ ~/.claude changed during the run: ${c}`);
  for (const r of results) {
    const mark =
      r.unexplained.length + r.runProblems.length + r.repeatDifferences.length === 0 ? '✔' : '✖';
    console.log(
      `${mark} ${r.id}: ${String(r.unexplained.length)} unexplained, ${String(r.allowed.length)} allowed${r.runProblems.length > 0 ? `, ${String(r.runProblems.length)} run problem(s)` : ''}${r.repeatDifferences.length > 0 ? ', not repeatable' : ''}`,
    );
  }
  console.log(failed ? 'L3 failed' : 'L3 passed');
  process.exitCode = failed ? 1 : 0;
}

if (isMain(import.meta.url)) {
  await main();
}
