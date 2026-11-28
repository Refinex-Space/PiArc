// Electron fuse settings for packaged builds (ADR-0018 rule 1, architecture section 10.3).
// The single source for both forge.config.ts, which writes the fuses when packaging, and
// scripts/ci/check-fuses.mjs, which reads them back from a packaged app.
import { FuseV1Options, FuseVersion } from '@electron/fuses';

/** @typedef {'release' | 'development'} BuildFlavor */
/** @typedef {Readonly<Record<keyof typeof FuseV1Options, boolean>>} FuseSettings */

/**
 * Release builds. Disabled: running as plain Node (`ELECTRON_RUN_AS_NODE`), `NODE_OPTIONS`,
 * `--inspect` and SIGUSR1, and the extra privileges of `file://`. Enabled: ASAR integrity
 * validation together with loading the app only from the ASAR, and cookie encryption.
 * `LoadBrowserProcessSpecificV8Snapshot` stays off until it is measured; `WasmTrapHandlers`
 * keeps Electron's default (on).
 * @type {FuseSettings}
 */
export const RELEASE_FUSES = Object.freeze({
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

/**
 * Development builds differ from release builds in one fuse: `--inspect` stays available for
 * debugging the packaged app, which is also how Playwright drives it in L4 tests.
 * @type {FuseSettings}
 */
export const DEVELOPMENT_FUSES = Object.freeze({
  ...RELEASE_FUSES,
  EnableNodeCliInspectArguments: true,
});

/**
 * Reads the build flavor from `PIARC_BUILD_FLAVOR` (or a CLI option). Release is the default.
 * @param {string | undefined} value
 * @returns {BuildFlavor}
 */
export function parseBuildFlavor(value) {
  if (value === undefined || value === '' || value === 'release') {
    return 'release';
  }
  if (value === 'development') {
    return 'development';
  }
  throw new Error(`Unknown build flavor "${value}"; expected "release" or "development"`);
}

/**
 * @param {BuildFlavor} flavor
 * @returns {FuseSettings}
 */
export function fuseSettingsFor(flavor) {
  return flavor === 'release' ? RELEASE_FUSES : DEVELOPMENT_FUSES;
}

/**
 * The @electron/fuses configuration for `settings`. Every fuse is set explicitly and
 * `strictlyRequireAllFuses` makes packaging fail when a new Electron adds a fuse that is not
 * configured here. Writing fuses invalidates the macOS signature, so the ad-hoc signature is
 * redone (ADR-0018 rule 1).
 * @param {FuseSettings} settings
 * @returns {import('@electron/fuses').FuseV1Config}
 */
export function toFuseConfig(settings) {
  return {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    resetAdHocDarwinSignature: true,
    [FuseV1Options.RunAsNode]: settings.RunAsNode,
    [FuseV1Options.EnableCookieEncryption]: settings.EnableCookieEncryption,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]:
      settings.EnableNodeOptionsEnvironmentVariable,
    [FuseV1Options.EnableNodeCliInspectArguments]: settings.EnableNodeCliInspectArguments,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:
      settings.EnableEmbeddedAsarIntegrityValidation,
    [FuseV1Options.OnlyLoadAppFromAsar]: settings.OnlyLoadAppFromAsar,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]:
      settings.LoadBrowserProcessSpecificV8Snapshot,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: settings.GrantFileProtocolExtraPrivileges,
    [FuseV1Options.WasmTrapHandlers]: settings.WasmTrapHandlers,
  };
}
