// Checks the threat map (tests/security/threats.yaml) against architecture section 10.1 and the
// tests in the repository, and docs/security/threat-coverage.md against the map and the L2
// results (T45, NFR-03; rules in scripts/lib/threats.mjs and docs/engineering/testing.md
// section 16).
//
// Usage:
//   node scripts/ci/check-threats.mjs
//       the map alone: rows, countermeasures, test IDs, tests named after a threat
//   node scripts/ci/check-threats.mjs --results target/l2/results.json --doc check|write
//       plus the generated doc: compare (check, verify step 16) or rewrite (write)
// Exit code 1 on any problem.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { parse } from 'yaml';

import { parseCatalog, toReport } from '../lib/capabilities.mjs';
import { capture, isMain, isRecord, readJsonFile, repoRoot } from '../lib/repo.mjs';
import {
  checkThreats,
  parseTestId,
  parseThreats,
  renderCoverage,
  threatRows,
} from '../lib/threats.mjs';

export const MAP = path.join(repoRoot, 'tests', 'security', 'threats.yaml');
export const DOC = path.join(repoRoot, 'docs', 'security', 'threat-coverage.md');

/** @param {string} relative */
function read(relative) {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

/** Test sources the reverse check reads for names carrying a threat number. */
const TEST_FILE = /(\.rs|\.test\.tsx?|\.test\.mjs|\.e2e\.ts)$/;

/**
 * Tracked and new (not ignored) files of the repository, with `/`.
 * @returns {Promise<string[]>}
 */
async function repositoryFiles() {
  const out = await capture('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
  });
  return out.split('\n').filter((line) => line !== '');
}

/**
 * @param {import('../lib/threats.mjs').Threat[]} threats
 * @returns {Promise<import('../lib/threats.mjs').Inventory>}
 */
async function inventory(threats) {
  const all = await repositoryFiles();
  const referenced = threats
    .flatMap((t) => t.countermeasures.flatMap((c) => c.tests))
    .map((id) => parseTestId(id))
    .filter((ref) => ref !== undefined && ref.kind !== 'cap')
    .map((ref) => ref?.path ?? '');
  const wanted = new Set([...all.filter((file) => TEST_FILE.test(file)), ...referenced]);
  const present = new Set(all);
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const file of wanted) {
    if (present.has(file)) files.set(file, read(file));
  }
  const { catalog } = parseCatalog(read('tests/capabilities.yaml'));
  const scenarios = all
    .filter((file) => /^tests\/scenarios\/[^/]+\.yaml$/.test(file))
    .map((file) => {
      /** @type {unknown} */
      const doc = parse(read(file));
      const fields = isRecord(doc) ? doc : {};
      const list = (/** @type {unknown} */ value) =>
        Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
      const platforms = list(fields.platforms);
      return {
        id: typeof fields.id === 'string' ? fields.id : file,
        capabilities: list(fields.capabilities),
        platforms: platforms.length === 0 ? ['macos', 'windows'] : platforms,
        description: typeof fields.description === 'string' ? fields.description : '',
      };
    });
  return {
    files,
    capabilities: new Map(catalog.capabilities.map((c) => [c.id, c.status])),
    scenarios,
  };
}

async function main() {
  const { values } = parseArgs({
    options: { results: { type: 'string' }, doc: { type: 'string' } },
  });
  const { threats, problems } = parseThreats(readFileSync(MAP, 'utf8'));
  const rows = threatRows(read('docs/architecture/ARCHITECTURE.md'));
  const found = await inventory(threats);
  problems.push(...checkThreats(threats, rows, found));
  const tests = new Set(threats.flatMap((t) => t.countermeasures.flatMap((c) => c.tests)));
  console.log(
    `threats: ${String(threats.length)} (section 10.1 rows: ${String(rows.length)}), countermeasures: ${String(threats.reduce((n, t) => n + t.countermeasures.length, 0))}, test IDs: ${String(tests.size)}`,
  );

  if (values.doc !== undefined) {
    if (values.results === undefined) {
      problems.push('--doc needs --results <L2 report>');
    } else if (values.doc !== 'check' && values.doc !== 'write') {
      problems.push('--doc must be check or write');
    } else {
      const report = toReport(readJsonFile(path.resolve(repoRoot, values.results)));
      if (report.filtered) problems.push('the L2 report ran a subset of the scenarios');
      const doc = renderCoverage(threats, found, report.scenarios);
      const relative = path.relative(repoRoot, DOC);
      if (values.doc === 'write') {
        writeFileSync(DOC, doc);
        console.log(`wrote ${relative}`);
      } else {
        let current;
        try {
          current = readFileSync(DOC, 'utf8');
        } catch {
          current = '';
        }
        if (current === doc) {
          console.log(`${relative} is up to date`);
        } else {
          problems.push(
            `${relative} differs from the map and the L2 results; regenerate it: node scripts/ci/check-threats.mjs --results target/l2/results.json --doc write`,
          );
        }
      }
    }
  }

  for (const problem of problems) console.error(`✖ ${problem}`);
  if (problems.length > 0) {
    console.error(`${String(problems.length)} problem(s).`);
    process.exitCode = 1;
  } else {
    console.log('threat map checks passed');
  }
}

if (isMain(import.meta.url)) {
  await main();
}
