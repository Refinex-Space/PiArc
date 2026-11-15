// Where the Core native module (crates/piarc-napi) is built and what it is called, shared by
// scripts/dev/build-core.mjs, forge.config.ts and the benchmark scripts. The main process
// resolves the same name at run time in src/main/core/native-path.ts; both follow the
// `--platform` naming of @napi-rs/cli and are tested against the same names.
import path from 'node:path';

/** @typedef {import('./fuses.mjs').BuildFlavor} BuildFlavor */

/** File name stem of the module (`binaryName` in crates/piarc-napi/napi.json). */
export const CORE_BINARY_STEM = 'piarc-core';

/**
 * The four shipping targets (ADR-0014): Rust target triple → Node platform and architecture.
 * @type {Readonly<Record<string, { platform: 'darwin' | 'win32', arch: 'arm64' | 'x64' }>>}
 */
export const CORE_TARGETS = Object.freeze({
  'aarch64-apple-darwin': { platform: 'darwin', arch: 'arm64' },
  'x86_64-apple-darwin': { platform: 'darwin', arch: 'x64' },
  'x86_64-pc-windows-msvc': { platform: 'win32', arch: 'x64' },
  'aarch64-pc-windows-msvc': { platform: 'win32', arch: 'arm64' },
});

/**
 * File name of the module for a platform and architecture, for example
 * `piarc-core.darwin-arm64.node` or `piarc-core.win32-x64-msvc.node`.
 * @param {string} platform a `process.platform` value
 * @param {string} arch a `process.arch` value
 * @returns {string}
 */
export function coreBinaryName(platform, arch) {
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`PiArc Core is not built for architecture ${arch}`);
  }
  switch (platform) {
    case 'darwin':
      return `${CORE_BINARY_STEM}.darwin-${arch}.node`;
    case 'win32':
      return `${CORE_BINARY_STEM}.win32-${arch}-msvc.node`;
    default:
      throw new Error(`PiArc Core is not built for platform ${platform}`);
  }
}

/**
 * Directory that holds the modules of one build flavor: `development` builds carry the
 * testing exports (demo event sources, panic triggers), `release` builds do not.
 * @param {string} repoRoot
 * @param {BuildFlavor} flavor
 * @returns {string}
 */
export function coreBuildDir(repoRoot, flavor) {
  return path.join(repoRoot, 'target', CORE_BINARY_STEM, flavor);
}
