// Checks the capability list (tests/capabilities.yaml) against the requirements and the
// architecture, its coverage by L2 scenarios, and docs/product/capabilities.md.
//
// Usage:
//   node scripts/ci/check-capabilities.mjs
//       the list alone: ids, milestones, statuses, blocked entries, refs, and every
//       requirement of REQUIREMENTS.md chapter 4 is covered or client-only
//   node scripts/ci/check-capabilities.mjs --results <L2 report> [--doc check|write]
//       plus coverage: active capabilities without a scenario are MISSING, scenarios may only
//       name listed capabilities; --doc compares (check) or rewrites (write) capabilities.md
//
// The L2 report comes from `cargo test -p piarc-testkit --test scenarios -- --results <file>`
// or `cargo run -p piarc-devcli -- run tests/scenarios --json <file>`.
// Exit code 1 on any problem.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  architectureSections,
  checkCatalog,
  checkCoverage,
  parseCatalog,
  renderDoc,
  requirementIds,
  toReport,
} from '../lib/capabilities.mjs';
import { isMain, readJsonFile, repoRoot } from '../lib/repo.mjs';

export const CATALOG = path.join(repoRoot, 'tests', 'capabilities.yaml');
export const DOC = path.join(repoRoot, 'docs', 'product', 'capabilities.md');

/** @param {string} relative */
function read(relative) {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

function main() {
  const { values } = parseArgs({
    options: {
      results: { type: 'string' },
      doc: { type: 'string' },
    },
  });
  const { catalog, problems } = parseCatalog(readFileSync(CATALOG, 'utf8'));
  problems.push(
    ...checkCatalog(catalog, {
      requirements: requirementIds(read('docs/product/REQUIREMENTS.md')),
      sections: architectureSections(read('docs/architecture/ARCHITECTURE.md')),
    }),
  );
  const count = (/** @type {string} */ s) =>
    String(catalog.capabilities.filter((c) => c.status === s).length);
  console.log(
    `capabilities: ${String(catalog.capabilities.length)} (active ${count('active')}, planned ${count('planned')}, blocked ${count('blocked')}); client-only requirements: ${String(catalog.clientOnly.length)}`,
  );

  if (values.results !== undefined) {
    const report = toReport(readJsonFile(values.results));
    const { missing, problems: coverage } = checkCoverage(catalog, report);
    problems.push(
      ...coverage,
      ...missing.map((id) => `MISSING ${id}: active but no L2 scenario covers it`),
    );
    const scenarios = report.scenarios.length;
    const skipped = report.scenarios.filter((s) => s.status === 'skipped').length;
    console.log(
      `L2 coverage: ${String(scenarios)} scenarios (${String(skipped)} skipped on ${report.platform ?? '?'}), MISSING ${String(missing.length)}`,
    );
    if (values.doc === 'write' || values.doc === 'check') {
      const doc = renderDoc(catalog, report);
      const current = (() => {
        try {
          return readFileSync(DOC, 'utf8');
        } catch {
          return '';
        }
      })();
      if (values.doc === 'write') {
        writeFileSync(DOC, doc);
        console.log(`wrote ${path.relative(repoRoot, DOC)}`);
      } else if (current !== doc) {
        problems.push(
          `${path.relative(repoRoot, DOC)} differs from the list and the L2 results; regenerate it: node scripts/ci/check-capabilities.mjs --results <L2 report> --doc write`,
        );
      } else {
        console.log(`${path.relative(repoRoot, DOC)} is up to date`);
      }
    } else if (values.doc !== undefined) {
      problems.push('--doc must be check or write');
    }
  } else if (values.doc !== undefined) {
    problems.push('--doc needs --results');
  }

  for (const problem of problems) console.error(`✖ ${problem}`);
  if (problems.length > 0) {
    console.error(`${String(problems.length)} problem(s).`);
    process.exitCode = 1;
  } else {
    console.log('capability checks passed');
  }
}

if (isMain(import.meta.url)) {
  main();
}
