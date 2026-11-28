import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { reviewedNpmLicenses } from './audit-deps.mjs';
import { npmLicenseProblems, NPM_LICENSES } from '../lib/audit.mjs';

it('requires the reviewed release, archive integrity and complete installed licence when SPDX metadata is missing', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'piarc-license-'));
  try {
    mkdirSync(path.join(root, 'node_modules', 'library'), { recursive: true });
    writeFileSync(path.join(root, 'reviewed'), 'full licence');
    const installed = path.join(root, 'node_modules', 'library', 'license');
    writeFileSync(installed, 'full licence');
    const lookup = reviewedNpmLicenses(
      {
        components: [
          {
            version: '1',
            license: 'MIT',
            licenseFile: 'reviewed',
            npm: { package: 'library', integrity: 'sha512-reviewed', licenseFile: 'license' },
          },
        ],
      },
      root,
    );
    const location = 'node_modules/library',
      pkg = { version: '1', integrity: 'sha512-reviewed' };
    expect(lookup(location, pkg)).toBe('MIT');
    expect(lookup(location, { ...pkg, version: '2' })).toBe('');
    expect(lookup(location, { ...pkg, integrity: 'other' })).toBe('');
    expect(lookup('node_modules/other', pkg)).toBe('');
    expect(
      npmLicenseProblems(
        { packages: { [location]: { ...pkg, license: 'GPL-3.0-only' } } },
        NPM_LICENSES,
        lookup,
      ).problems,
    ).toEqual([location + ': GPL-3.0-only']);
    writeFileSync(installed, 'changed licence');
    expect(lookup(location, pkg)).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
