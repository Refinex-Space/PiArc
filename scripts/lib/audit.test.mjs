import { describe, expect, it } from 'vitest';

import {
  NPM_LICENSES,
  cargoFindings,
  judge,
  licenseAllowed,
  npmFindings,
  npmLicenseProblems,
  parseExceptions,
} from './audit.mjs';

const NPM_REPORT = {
  vulnerabilities: {
    minimatch: {
      severity: 'moderate',
      via: [
        {
          source: 1,
          name: 'minimatch',
          title: 'ReDoS',
          url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
          severity: 'moderate',
        },
      ],
    },
    eslint: { severity: 'moderate', via: ['minimatch'] },
    tar: {
      severity: 'high',
      via: [
        {
          source: 2,
          name: 'tar',
          title: 'Path traversal',
          url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff',
          severity: 'high',
        },
      ],
    },
  },
};

const CARGO_REPORT = {
  vulnerabilities: {
    found: true,
    count: 1,
    list: [
      {
        advisory: { id: 'RUSTSEC-2026-0001', package: 'foo', title: 'UAF', cvss: null },
        package: { name: 'foo', version: '1.0.0' },
      },
    ],
  },
};

const EXCEPTIONS = `version: 1
exceptions:
  - { ecosystem: npm, id: GHSA-aaaa-bbbb-cccc, package: minimatch, severity: moderate, reason: dev only, impact: none, review_by: '2027-01-31' }
  - { ecosystem: npm, id: GHSA-0000-0000-0000, package: old, severity: high, reason: gone, impact: none, review_by: '2027-01-31' }
`;

describe('dependency audit (THR-08)', () => {
  it('counts each npm advisory once, not every package that depends on it', () => {
    expect(npmFindings(NPM_REPORT).map((f) => `${f.id} ${f.package} ${f.severity}`)).toEqual([
      'GHSA-aaaa-bbbb-cccc minimatch moderate',
      'GHSA-dddd-eeee-ffff tar high',
    ]);
  });

  it('reads cargo-audit vulnerabilities', () => {
    expect(cargoFindings(CARGO_REPORT)).toEqual([
      {
        ecosystem: 'cargo',
        id: 'RUSTSEC-2026-0001',
        package: 'foo',
        severity: 'unrated',
        title: 'UAF',
      },
    ]);
  });

  it('THR-08 fails on high and critical npm advisories and every cargo vulnerability without a current exception', () => {
    const { exceptions, problems } = parseExceptions(EXCEPTIONS);
    expect(problems).toEqual([]);
    const findings = [...npmFindings(NPM_REPORT), ...cargoFindings(CARGO_REPORT)];
    const verdict = judge(findings, exceptions, '2026-11-21');
    expect(verdict.blocking.map((f) => f.id)).toEqual(['GHSA-dddd-eeee-ffff', 'RUSTSEC-2026-0001']);
    expect(verdict.excepted.map((f) => f.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
    expect(verdict.unused.map((e) => e.id)).toEqual(['GHSA-0000-0000-0000']);
    expect(verdict.expired).toEqual([]);
  });

  it('THR-08 an exception past its review date no longer covers the advisory and fails', () => {
    const { exceptions } = parseExceptions(EXCEPTIONS);
    const verdict = judge(npmFindings(NPM_REPORT), exceptions, '2027-02-01');
    expect(verdict.expired.map((e) => e.id)).toEqual([
      'GHSA-aaaa-bbbb-cccc',
      'GHSA-0000-0000-0000',
    ]);
    expect(verdict.excepted).toEqual([]);
    expect(verdict.reported.map((f) => f.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('requires a reason, the impact and a review date for every exception', () => {
    const { problems } = parseExceptions(
      'version: 1\nexceptions:\n  - { ecosystem: npm, id: X, package: p, severity: high, review_by: soon }\n',
    );
    expect(problems).toEqual(['exceptions[0]: needs reason, impact']);
  });

  it('evaluates SPDX expressions against the allowlist', () => {
    expect(licenseAllowed('MIT', NPM_LICENSES)).toBe(true);
    expect(licenseAllowed('(MIT OR GPL-3.0)', NPM_LICENSES)).toBe(true);
    expect(licenseAllowed('MIT AND GPL-3.0', NPM_LICENSES)).toBe(false);
    expect(licenseAllowed('(Apache-2.0 AND (MIT OR GPL-2.0))', NPM_LICENSES)).toBe(true);
    expect(licenseAllowed('GPL-3.0-only', NPM_LICENSES)).toBe(false);
  });

  it('THR-08 checks the licenses of the npm packages that ship, not the development tools', () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'piarc' },
        'node_modules/a': { license: 'MIT' },
        'node_modules/b': { license: 'GPL-3.0' },
        'node_modules/c': {},
        'node_modules/dev-tool': { dev: true, license: 'GPL-3.0' },
        'node_modules/@piarc/protocol': { link: true },
      },
    };
    expect(npmLicenseProblems(lock, NPM_LICENSES)).toEqual({
      checked: 3,
      problems: ['node_modules/b: GPL-3.0', 'node_modules/c: no license'],
    });
  });
});
