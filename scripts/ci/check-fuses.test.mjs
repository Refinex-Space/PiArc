import path from 'node:path';

import { FuseState, FuseV1Options, FuseVersion } from '@electron/fuses';
import { describe, expect, it } from 'vitest';

import {
  DEVELOPMENT_FUSES,
  RELEASE_FUSES,
  parseBuildFlavor,
  toFuseConfig,
} from '../../apps/desktop/fuses.mjs';
import {
  compareFuses,
  describeFuseState,
  desktopDir,
  knownFuses,
  packagedAppPath,
} from './check-fuses.mjs';

/**
 * The wire `getCurrentFuseWire` would return for a binary built with `settings`.
 * @param {Readonly<Record<string, boolean>>} settings
 * @returns {Record<string, unknown>}
 */
function wireFor(settings) {
  /** @type {Record<string, unknown>} */
  const wire = { version: FuseVersion.V1 };
  for (const { name, index } of knownFuses()) {
    wire[String(index)] = settings[name] ? FuseState.ENABLE : FuseState.DISABLE;
  }
  return wire;
}

describe('fuse settings', () => {
  it('release settings follow ADR-0018 rule 1', () => {
    expect(RELEASE_FUSES).toEqual({
      RunAsNode: false,
      EnableCookieEncryption: true,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: true,
      LoadBrowserProcessSpecificV8Snapshot: false,
      GrantFileProtocolExtraPrivileges: false,
      WasmTrapHandlers: true,
    });
  });

  it('development settings differ only in EnableNodeCliInspectArguments', () => {
    const differences = knownFuses()
      .filter(({ name }) => RELEASE_FUSES[name] !== DEVELOPMENT_FUSES[name])
      .map(({ name }) => name);
    expect(differences).toEqual(['EnableNodeCliInspectArguments']);
    expect(DEVELOPMENT_FUSES.EnableNodeCliInspectArguments).toBe(true);
  });

  it('sets every known fuse explicitly and requires all fuses', () => {
    const config = toFuseConfig(RELEASE_FUSES);
    expect(config.strictlyRequireAllFuses).toBe(true);
    expect(config.resetAdHocDarwinSignature).toBe(true);
    for (const { name, index } of knownFuses()) {
      expect(Object.entries(config).find(([key]) => key === String(index))?.[1], name).toBe(
        RELEASE_FUSES[name],
      );
    }
    expect(knownFuses().map(({ name }) => name)).toEqual(Object.keys(RELEASE_FUSES));
  });

  it('reads the build flavor with release as the default', () => {
    expect(parseBuildFlavor(undefined)).toBe('release');
    expect(parseBuildFlavor('')).toBe('release');
    expect(parseBuildFlavor('release')).toBe('release');
    expect(parseBuildFlavor('development')).toBe('development');
    expect(() => parseBuildFlavor('debug')).toThrow(/Unknown build flavor "debug"/);
  });
});

describe('compareFuses', () => {
  it('accepts a binary that matches the settings', () => {
    expect(compareFuses(RELEASE_FUSES, wireFor(RELEASE_FUSES))).toEqual([]);
  });

  it('names a fuse whose state differs', () => {
    expect(compareFuses(RELEASE_FUSES, wireFor(DEVELOPMENT_FUSES))).toEqual([
      { fuse: 'EnableNodeCliInspectArguments', expected: 'disabled', actual: 'enabled' },
    ]);
  });

  it('reports removed, inherited, missing and unknown states', () => {
    const missing = String(FuseV1Options.WasmTrapHandlers);
    const wire = Object.fromEntries(
      Object.entries(wireFor(RELEASE_FUSES)).filter(([key]) => key !== missing),
    );
    wire[String(FuseV1Options.RunAsNode)] = FuseState.REMOVED;
    wire[String(FuseV1Options.OnlyLoadAppFromAsar)] = FuseState.INHERIT;
    wire[String(FuseV1Options.EnableCookieEncryption)] = 0x7f;
    expect(compareFuses(RELEASE_FUSES, wire)).toEqual([
      { fuse: 'RunAsNode', expected: 'disabled', actual: 'removed' },
      { fuse: 'EnableCookieEncryption', expected: 'enabled', actual: 'unknown (0x7f)' },
      { fuse: 'OnlyLoadAppFromAsar', expected: 'enabled', actual: 'inherit' },
      { fuse: 'WasmTrapHandlers', expected: 'enabled', actual: 'missing' },
    ]);
  });

  it('reports fuses the settings do not cover', () => {
    const wire = { ...wireFor(RELEASE_FUSES), 9: FuseState.ENABLE };
    expect(compareFuses(RELEASE_FUSES, wire)).toEqual([
      { fuse: 'fuse #9', expected: 'configured in apps/desktop/fuses.mjs', actual: 'enabled' },
    ]);
  });

  it('describes fuse states', () => {
    expect(describeFuseState(FuseState.ENABLE)).toBe('enabled');
    expect(describeFuseState(FuseState.DISABLE)).toBe('disabled');
  });
});

describe('packagedAppPath', () => {
  it('points at the app bundle on macOS and the executable on Windows', () => {
    const out = path.join(desktopDir, 'out', 'release');
    expect(packagedAppPath('release', 'PiArc', 'darwin', 'arm64')).toBe(
      path.join(out, 'PiArc-darwin-arm64', 'PiArc.app'),
    );
    expect(packagedAppPath('release', 'PiArc', 'win32', 'x64')).toBe(
      path.join(out, 'PiArc-win32-x64', 'PiArc.exe'),
    );
  });
});
