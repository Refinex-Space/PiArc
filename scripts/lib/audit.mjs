// The dependency audit (T45, THR-08, architecture section 13.3): advisories from `npm audit`
// and cargo-audit, the exception list (tests/security/audit-exceptions.yaml) and the licenses of
// the npm packages that ship. Pure functions; scripts/ci/audit-deps.mjs runs the tools.
import { parse } from 'yaml';

import { isRecord } from './repo.mjs';

/** npm severities that fail the audit unless an exception covers them. */
export const BLOCKING = ['high', 'critical'];

/**
 * Licenses the shipped npm packages may carry (SPDX). The Rust allowlist is `deny.toml`; npm adds
 * the permissive licenses found in the JavaScript tree.
 */
export const NPM_LICENSES = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'BlueOak-1.0.0',
  'Unlicense',
  'CC0-1.0',
  'Zlib',
];

/**
 * @typedef {{ ecosystem: 'npm' | 'cargo', id: string, package: string, severity: string,
 *   title: string }} Finding
 * @typedef {{ ecosystem: string, id: string, package: string, severity: string, reason: string,
 *   impact: string, reviewBy: string }} AuditException
 */

/** @param {unknown} value */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Advisories of an `npm audit --json` report (format 2), one per advisory: packages flagged only
 * because they depend on a vulnerable package are not findings of their own.
 * @param {unknown} report
 * @returns {Finding[]}
 */
export function npmFindings(report) {
  if (!isRecord(report) || !isRecord(report.vulnerabilities)) {
    throw new Error('npm audit: no `vulnerabilities` object (needs npm 7 or later)');
  }
  /** @type {Map<string, Finding>} */
  const found = new Map();
  for (const entry of Object.values(report.vulnerabilities)) {
    if (!isRecord(entry) || !Array.isArray(entry.via)) continue;
    for (const via of entry.via) {
      if (!isRecord(via)) continue;
      const url = str(via.url);
      const id =
        /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/.exec(url)?.[0] ?? `npm-${String(via.source)}`;
      found.set(id, {
        ecosystem: 'npm',
        id,
        package: str(via.name),
        severity: str(via.severity),
        title: str(via.title),
      });
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Vulnerabilities of a `cargo audit --json` report. Every one blocks (RustSec rates only some
 * advisories); `severity` is the CVSS vector when the advisory has one.
 * @param {unknown} report
 * @returns {Finding[]}
 */
export function cargoFindings(report) {
  if (!isRecord(report) || !isRecord(report.vulnerabilities)) {
    throw new Error('cargo audit: no `vulnerabilities` object');
  }
  const list = Array.isArray(report.vulnerabilities.list) ? report.vulnerabilities.list : [];
  return list
    .filter(isRecord)
    .map((v) => {
      const advisory = isRecord(v.advisory) ? v.advisory : {};
      const pkg = isRecord(v.package) ? v.package : {};
      return {
        ecosystem: /** @type {const} */ ('cargo'),
        id: str(advisory.id),
        package: str(pkg.name) || str(advisory.package),
        severity: str(advisory.cvss) || 'unrated',
        title: str(advisory.title),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Parses the exception list; shape problems are returned.
 * @param {string} source
 * @returns {{ exceptions: AuditException[], problems: string[] }}
 */
export function parseExceptions(source) {
  /** @type {unknown} */
  const doc = parse(source);
  if (!isRecord(doc) || doc.version !== 1 || !Array.isArray(doc.exceptions)) {
    return {
      exceptions: [],
      problems: ['audit-exceptions.yaml: needs `version: 1` and `exceptions`'],
    };
  }
  /** @type {string[]} */
  const problems = [];
  /** @type {AuditException[]} */
  const exceptions = [];
  for (const [n, entry] of doc.exceptions.entries()) {
    const where = `exceptions[${String(n)}]`;
    if (!isRecord(entry)) {
      problems.push(`${where}: must be a mapping`);
      continue;
    }
    const fields = ['ecosystem', 'id', 'package', 'severity', 'reason', 'impact', 'review_by'];
    const missing = fields.filter((f) => str(entry[f]).trim() === '');
    if (missing.length > 0) {
      problems.push(`${where}: needs ${missing.join(', ')}`);
      continue;
    }
    const reviewBy = str(entry.review_by);
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(reviewBy)) {
      problems.push(`${where}: review_by must be YYYY-MM-DD`);
      continue;
    }
    exceptions.push({
      ecosystem: str(entry.ecosystem),
      id: str(entry.id),
      package: str(entry.package),
      severity: str(entry.severity),
      reason: str(entry.reason),
      impact: str(entry.impact),
      reviewBy,
    });
  }
  return { exceptions, problems };
}

/**
 * Sorts the findings: blocking (npm high or critical, any cargo vulnerability) without a current
 * exception fail the audit; the rest are reported. Expired exceptions fail too (review them), and
 * exceptions that no longer match a finding are reported for removal.
 * @param {Finding[]} findings
 * @param {AuditException[]} exceptions
 * @param {string} today YYYY-MM-DD
 */
export function judge(findings, exceptions, today) {
  const covers = (/** @type {AuditException} */ e, /** @type {Finding} */ f) =>
    e.ecosystem === f.ecosystem && e.id === f.id && e.package === f.package;
  const blockingFinding = (/** @type {Finding} */ f) =>
    f.ecosystem === 'cargo' || BLOCKING.includes(f.severity);
  const current = exceptions.filter((e) => e.reviewBy >= today);
  return {
    blocking: findings.filter((f) => blockingFinding(f) && !current.some((e) => covers(e, f))),
    excepted: findings.filter((f) => current.some((e) => covers(e, f))),
    reported: findings.filter((f) => !blockingFinding(f) && !current.some((e) => covers(e, f))),
    expired: exceptions.filter((e) => e.reviewBy < today),
    unused: exceptions.filter((e) => !findings.some((f) => covers(e, f))),
  };
}

/**
 * Whether an SPDX expression is satisfied by the allowlist: `OR` needs one allowed side, `AND`
 * both; parentheses group.
 * @param {string} expression
 * @param {readonly string[]} allowed
 * @returns {boolean}
 */
export function licenseAllowed(expression, allowed) {
  const text = expression.trim();
  if (text.startsWith('(') && text.endsWith(')') && balanced(text.slice(1, -1))) {
    return licenseAllowed(text.slice(1, -1), allowed);
  }
  for (const operator of [' OR ', ' AND ']) {
    const parts = splitTop(text, operator);
    if (parts.length > 1) {
      return operator === ' OR '
        ? parts.some((p) => licenseAllowed(p, allowed))
        : parts.every((p) => licenseAllowed(p, allowed));
    }
  }
  return allowed.includes(text);
}

/** @param {string} text */
function balanced(text) {
  let depth = 0;
  for (const ch of text) {
    depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * @param {string} text
 * @param {string} operator
 */
function splitTop(text, operator) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    if (depth === 0 && text.startsWith(operator, i)) {
      parts.push(text.slice(start, i));
      start = i + operator.length;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Packages of the lockfile that ship (not `dev`, not workspace links) whose license is missing or
 * outside the allowlist.
 * @param {unknown} lock package-lock.json (lockfileVersion 3)
 * @param {readonly string[]} allowed
 * @param {(path:string,entry:Record<string,unknown>)=>string} [reviewedLicense] Exact checked-in evidence for a release with missing metadata.
 * @returns {{ checked: number, problems: string[] }}
 */
export function npmLicenseProblems(lock, allowed, reviewedLicense) {
  if (!isRecord(lock) || !isRecord(lock.packages)) {
    throw new Error('package-lock.json: no `packages` (needs lockfileVersion 3)');
  }
  /** @type {string[]} */
  const problems = [];
  let checked = 0;
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key.includes('node_modules/') || !isRecord(entry) || entry.dev === true || entry.link) {
      continue;
    }
    checked += 1;
    const declared = str(entry.license);
    const license = declared === '' ? (reviewedLicense?.(key, entry) ?? '') : declared;
    if (license === '') problems.push(`${key}: no license`);
    else if (!licenseAllowed(license, allowed)) problems.push(`${key}: ${license}`);
  }
  return { checked, problems };
}
