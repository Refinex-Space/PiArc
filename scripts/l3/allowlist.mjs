// tests/l3-allowlist.yaml (T30): intended deviations of PiArc from Claude Code, and the
// scenarios the comparison leaves out (docs/engineering/testing.md section 14.4).
//
// differences: [{scenario, path, claude_code, reason, follow_up?}]
//   scenario      L3 scenario id or a pattern (`*` matches within the id)
//   path          field-path pattern (scripts/l3/diff.mjs)
//   claude_code   Claude Code versions the entry applies to: space-separated comparators
//                 such as ">=2.1.300 <2.2.0", or "*"
//   reason        why PiArc differs on purpose (required)
//   follow_up     the task that will revisit it (optional; listed in PLAN.md's registry)
// excluded: [{scenario, reason}]
//   An L2 scenario of the compared areas that no L3 scenario mirrors, or an L3 scenario that
//   does not run, with the reason it cannot be reproduced through `claude -p`.
//
// The command fails on an entry without a reason and on an entry that applies to this run
// (version in range, scenario ran) but matches no difference.
import { parse } from 'yaml';

import { isRecord } from '../lib/repo.mjs';
import { compilePattern } from './diff.mjs';

/**
 * @typedef {{ scenario: string, path: string, claude_code: string, reason: string,
 *   follow_up?: string, index: number }} Entry
 * @typedef {{ scenario: string, reason: string }} Exclusion
 * @typedef {{ entries: Entry[], excluded: Exclusion[] }} Allowlist
 */

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const COMPARATOR = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/;

/**
 * @param {string} version
 * @returns {number[] | undefined}
 */
function parts(version) {
  const match = VERSION.exec(version);
  return match === null ? undefined : match.slice(1).map(Number);
}

/**
 * @param {number[]} a
 * @param {number[]} b
 */
function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Whether a version range is well formed.
 * @param {string} range
 */
export function isRange(range) {
  return (
    range.trim() === '*' ||
    range
      .trim()
      .split(/\s+/)
      .every((c) => COMPARATOR.test(c))
  );
}

/**
 * Whether `version` satisfies `range` (`*`, or space-separated comparators).
 * @param {string} version
 * @param {string} range
 */
export function satisfies(version, range) {
  if (range.trim() === '*') return true;
  const v = parts(version);
  if (v === undefined) return false;
  return range
    .trim()
    .split(/\s+/)
    .every((comparator) => {
      const match = COMPARATOR.exec(comparator);
      const bound = parts(match?.[2] ?? '');
      if (match === null || bound === undefined) return false;
      const d = compare(v, bound);
      switch (match[1]) {
        case '>=':
          return d >= 0;
        case '<=':
          return d <= 0;
        case '>':
          return d > 0;
        case '<':
          return d < 0;
        default:
          return d === 0;
      }
    });
}

/**
 * Parses the allowlist; shape problems (unknown fields, missing reasons, bad ranges or
 * patterns) are returned, not thrown.
 * @param {string} text
 * @returns {{ allowlist: Allowlist, problems: string[] }}
 */
export function parseAllowlist(text) {
  /** @type {Allowlist} */
  const allowlist = { entries: [], excluded: [] };
  /** @type {string[]} */
  const problems = [];
  /** @type {unknown} */
  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    return {
      allowlist,
      problems: [`l3-allowlist.yaml: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (!isRecord(doc)) return { allowlist, problems: ['l3-allowlist.yaml: must be a mapping'] };
  for (const key of Object.keys(doc).filter((k) => k !== 'differences' && k !== 'excluded')) {
    problems.push(`l3-allowlist.yaml: unknown field \`${key}\``);
  }
  const differences = Array.isArray(doc.differences) ? doc.differences : [];
  const fields = new Set(['scenario', 'path', 'claude_code', 'reason', 'follow_up']);
  for (const [index, raw] of differences.entries()) {
    const where = `differences[${String(index)}]`;
    if (!isRecord(raw)) {
      problems.push(`${where}: must be a mapping`);
      continue;
    }
    for (const key of Object.keys(raw).filter((k) => !fields.has(k))) {
      problems.push(`${where}: unknown field \`${key}\``);
    }
    /** @param {string} key */
    const text = (key) => (typeof raw[key] === 'string' ? raw[key].trim() : '');
    const entry = {
      scenario: text('scenario'),
      path: text('path'),
      claude_code: text('claude_code'),
      reason: text('reason'),
      index,
      ...(text('follow_up') === '' ? {} : { follow_up: text('follow_up') }),
    };
    if (entry.reason === '') problems.push(`${where} (${entry.path}): the reason is missing`);
    if (entry.scenario === '') problems.push(`${where}: the scenario is missing`);
    if (entry.path === '') problems.push(`${where}: the path is missing`);
    if (!isRange(entry.claude_code)) {
      problems.push(`${where}: claude_code \`${entry.claude_code}\` is not a version range`);
    }
    allowlist.entries.push(entry);
  }
  const excluded = Array.isArray(doc.excluded) ? doc.excluded : [];
  for (const [index, raw] of excluded.entries()) {
    const where = `excluded[${String(index)}]`;
    if (!isRecord(raw)) {
      problems.push(`${where}: must be a mapping`);
      continue;
    }
    for (const key of Object.keys(raw).filter((k) => k !== 'scenario' && k !== 'reason')) {
      problems.push(`${where}: unknown field \`${key}\``);
    }
    const scenario = typeof raw.scenario === 'string' ? raw.scenario.trim() : '';
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
    if (scenario === '') problems.push(`${where}: the scenario is missing`);
    if (reason === '') problems.push(`${where} (${scenario}): the reason is missing`);
    allowlist.excluded.push({ scenario, reason });
  }
  return { allowlist, problems };
}

/**
 * @param {Entry} entry
 * @param {string} scenario
 */
function scenarioMatches(entry, scenario) {
  return compilePattern(entry.scenario).test(scenario);
}

/**
 * Splits each scenario's differences into allowed (with the entry) and unexplained, and
 * finds the stale entries: in range for `version`, every scenario of `known` the entry names
 * ran, and it matched no difference. A filtered run therefore only judges entries for the
 * scenarios it ran.
 * @param {Allowlist} allowlist
 * @param {string} version Claude Code's version
 * @param {Map<string, import('./diff.mjs').Difference[]>} differences by scenario that ran
 * @param {string[]} known every scenario that runs when nothing is filtered
 */
export function applyAllowlist(allowlist, version, differences, known) {
  const active = allowlist.entries.filter((e) => satisfies(version, e.claude_code));
  /** @type {Set<number>} */
  const used = new Set();
  /** @type {Map<string, { allowed: { difference: import('./diff.mjs').Difference, entry: Entry }[], unexplained: import('./diff.mjs').Difference[] }>} */
  const results = new Map();
  for (const [scenario, list] of differences) {
    const entries = active.filter((e) => scenarioMatches(e, scenario));
    /** @type {{ difference: import('./diff.mjs').Difference, entry: Entry }[]} */
    const allowed = [];
    /** @type {import('./diff.mjs').Difference[]} */
    const unexplained = [];
    for (const difference of list) {
      const entry = entries.find((e) => compilePattern(e.path).test(difference.path));
      if (entry === undefined) {
        unexplained.push(difference);
      } else {
        used.add(entry.index);
        allowed.push({ difference, entry });
      }
    }
    results.set(scenario, { allowed, unexplained });
  }
  const stale = active.filter((e) => {
    const named = known.filter((scenario) => scenarioMatches(e, scenario));
    return !used.has(e.index) && named.length > 0 && named.every((s) => differences.has(s));
  });
  return { results, stale };
}
