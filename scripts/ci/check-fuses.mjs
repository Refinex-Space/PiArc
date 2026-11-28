// Reads the Electron fuses of a packaged desktop app and compares them with the settings in
// apps/desktop/fuses.mjs (ADR-0018 rule 1, architecture section 10.3). Run it after
// `npm run package:desktop`; the packaging (T12) and release (T50) pipelines call it too.
//
// Usage: node scripts/ci/check-fuses.mjs [--flavor release|development] [--arch <arch>] [--app <path>]
//   --flavor  settings to expect and default output directory (default: release)
//   --arch    architecture of the default output directory (default: this machine's)
//   --app     packaged app to read: the .app bundle on macOS, the .exe on Windows
//             (default: apps/desktop/out/<flavor>/<name>-<platform>-<arch>/...)
// Exit code 0 when every fuse matches, 1 on any mismatch or when the app is missing.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

import { fuseSettingsFor, parseBuildFlavor } from '../../apps/desktop/fuses.mjs';
import { isMain, isRecord, readJsonFile, repoRoot } from '../lib/repo.mjs';

/**
 * @typedef {import('../../apps/desktop/fuses.mjs').FuseSettings} FuseSettings
 * @typedef {keyof typeof FuseV1Options} FuseName
 * @typedef {{ fuse: string, expected: string, actual: string }} Mismatch
 */

export const desktopDir = path.join(repoRoot, 'apps', 'desktop');

/**
 * Fuses known to @electron/fuses, in wire order.
 * @returns {{ name: FuseName, index: number }[]}
 */
export function knownFuses() {
  return Object.entries(FuseV1Options).flatMap(([name, index]) =>
    typeof index === 'number' ? [{ name: /** @type {FuseName} */ (name), index }] : [],
  );
}

/**
 * @param {unknown} state
 * @returns {string}
 */
export function describeFuseState(state) {
  switch (state) {
    case FuseState.ENABLE:
      return 'enabled';
    case FuseState.DISABLE:
      return 'disabled';
    case FuseState.REMOVED:
      return 'removed';
    case FuseState.INHERIT:
      return 'inherit';
    case undefined:
      return 'missing';
    default:
      return typeof state === 'number'
        ? `unknown (0x${state.toString(16)})`
        : `unknown (${String(state)})`;
  }
}

/**
 * Compares the fuse wire read from a binary with the expected settings. Reports every fuse
 * whose state differs, and every fuse in the binary that the settings do not cover (a newer
 * Electron added it).
 * @param {FuseSettings} expected
 * @param {Readonly<Record<string, unknown>>} wire result of `getCurrentFuseWire`
 * @returns {Mismatch[]}
 */
export function compareFuses(expected, wire) {
  /** @type {Mismatch[]} */
  const mismatches = [];
  const fuses = knownFuses();
  for (const { name, index } of fuses) {
    const want = expected[name] ? FuseState.ENABLE : FuseState.DISABLE;
    const actual = wire[String(index)];
    if (actual !== want) {
      mismatches.push({
        fuse: name,
        expected: describeFuseState(want),
        actual: describeFuseState(actual),
      });
    }
  }
  const known = new Set(fuses.map(({ index }) => String(index)));
  for (const [key, state] of Object.entries(wire)) {
    if (key !== 'version' && !known.has(key)) {
      mismatches.push({
        fuse: `fuse #${key}`,
        expected: 'configured in apps/desktop/fuses.mjs',
        actual: describeFuseState(state),
      });
    }
  }
  return mismatches;
}

/** @returns {string} */
export function productName() {
  const manifest = readJsonFile(path.join(desktopDir, 'package.json'));
  if (!isRecord(manifest) || typeof manifest.productName !== 'string') {
    throw new Error('apps/desktop/package.json has no productName');
  }
  return manifest.productName;
}

/**
 * Default location of a packaged app written by `npm run package:desktop`.
 * @param {import('../../apps/desktop/fuses.mjs').BuildFlavor} flavor
 * @param {string} name product name
 * @param {NodeJS.Platform} platform
 * @param {string} arch
 */
export function packagedAppPath(flavor, name, platform, arch) {
  const appDir = path.join(desktopDir, 'out', flavor, `${name}-${platform}-${arch}`);
  switch (platform) {
    case 'darwin':
      return path.join(appDir, `${name}.app`);
    case 'win32':
      return path.join(appDir, `${name}.exe`);
    default:
      return path.join(appDir, name);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      flavor: { type: 'string' },
      arch: { type: 'string', default: process.arch },
      app: { type: 'string' },
    },
  });
  const flavor = parseBuildFlavor(values.flavor);
  const appPath =
    values.app ?? packagedAppPath(flavor, productName(), process.platform, values.arch);
  if (!existsSync(appPath)) {
    console.error(
      `Packaged app not found: ${appPath}\nRun: npm run package:desktop -- --flavor ${flavor}`,
    );
    process.exitCode = 1;
    return;
  }
  const expected = fuseSettingsFor(flavor);
  /** @type {Readonly<Record<string, unknown>>} */
  const wire = await getCurrentFuseWire(appPath);
  const mismatches = compareFuses(expected, wire);
  console.log(`Fuses of ${appPath} (expected: ${flavor} settings)`);
  for (const { name, index } of knownFuses()) {
    const actual = describeFuseState(wire[String(index)]);
    const want = expected[name] ? 'enabled' : 'disabled';
    console.log(`  ${actual === want ? '✔' : '✖'} ${name.padEnd(40)} ${actual}`);
  }
  if (mismatches.length === 0) {
    console.log(`All ${String(knownFuses().length)} fuses match the ${flavor} settings.`);
    return;
  }
  console.error(`\n${String(mismatches.length)} fuse(s) differ from apps/desktop/fuses.mjs:`);
  for (const { fuse, expected: want, actual } of mismatches) {
    console.error(`  ${fuse}: expected ${want}, found ${actual}`);
  }
  process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  await main();
}
