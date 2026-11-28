import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../lib/repo.mjs';
import {
  assertVersion,
  changelogProblems,
  readVersions,
  withLockVersion,
  withPackageVersion,
} from './version.mjs';

const section = (/** @type {string} */ title, /** @type {string} */ body) =>
  `# C\n\n## [Unreleased]\n\n## [1.0.0] - 2026-12-01\n\n### ${title}\n\n- ${body}\n`;

describe('assertVersion', () => {
  it('accepts releases and prereleases, nothing else', () => {
    expect(() => {
      assertVersion('1.0.0');
      assertVersion('1.2.3-beta.1');
    }).not.toThrow();
    for (const bad of ['v1.0.0', '1.0', '1.0.0+build', '1.0.0-', '01.0.0x']) {
      expect(() => {
        assertVersion(bad);
      }).toThrow();
    }
  });
});

describe('withPackageVersion / withLockVersion', () => {
  it('changes only the version and keeps the formatting', () => {
    const pkg = '{\n  "name": "@piarc/desktop",\n  "version": "0.0.0",\n  "dependencies": {}\n}\n';
    expect(withPackageVersion(pkg, '1.0.0')).toBe(pkg.replace('0.0.0', '1.0.0'));
  });

  it('changes the desktop workspace entry of the lockfile, not another package', () => {
    const lock = [
      '{',
      '  "packages": {',
      '    "agent-host": {',
      '      "version": "0.0.0"',
      '    },',
      '    "apps/desktop": {',
      '      "name": "@piarc/desktop",',
      '      "version": "0.0.0",',
      '      "license": "MIT"',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    const next = withLockVersion(lock, '1.0.0');
    expect(next).toContain('"agent-host": {\n      "version": "0.0.0"');
    expect(next).toContain('"name": "@piarc/desktop",\n      "version": "1.0.0"');
  });

  it('the repository lockfile has the entry the script edits, in agreement with package.json', () => {
    const lock = readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8');
    expect(() => withLockVersion(lock, '9.9.9')).not.toThrow();
    const versions = readVersions();
    expect(versions.lock).toBe(versions.package);
  });
});

describe('changelogProblems', () => {
  it('passes matching sections', () => {
    expect(
      changelogProblems('1.0.0', { en: section('Added', 'x'), 'zh-CN': section('新增', 'x') }),
    ).toEqual([]);
  });

  it('requires both languages to agree on the date and on a security release', () => {
    const problems = changelogProblems('1.0.0', {
      en: section('Security', 'x'),
      'zh-CN': section('修复', 'x').replace('2026-12-01', '2026-12-02'),
    });
    expect(problems.join('\n')).toMatch(/date 1\.0\.0 differently/);
    expect(problems.join('\n')).toMatch(/security release/);
  });

  it('reports a version missing from one changelog', () => {
    expect(changelogProblems('1.0.0', { en: section('Added', 'x'), 'zh-CN': '# C\n' })).toEqual([
      'CHANGELOG.zh-CN.md has no "## [1.0.0] - YYYY-MM-DD" section',
    ]);
  });
});
