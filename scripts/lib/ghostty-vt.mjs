// The libghostty-vt artefact that crates/piarc-ghostty-sys/build.rs verified and unpacked for a
// target: where its headers and, on Windows, its DLL are. Shared by
// scripts/dev/gen-ghostty-bindings.mjs (headers) and scripts/dev/build-core.mjs (the DLL that
// ships next to the Core module). The build script stays the only place that downloads and
// verifies; this module asks cargo where it put the result.
import path from 'node:path';

import { capture, isRecord, readJsonFile, repoRoot } from './repo.mjs';

export const GHOSTTY_SYS_PACKAGE = 'piarc-ghostty-sys';

/** The supply-chain lock of the prebuilt artefacts. */
export const GHOSTTY_LOCK_PATH = path.join(
  repoRoot,
  'crates',
  GHOSTTY_SYS_PACKAGE,
  'ghostty-vt.lock.json',
);

/**
 * @typedef {object} GhosttyArtifact
 * @property {string} version libghostty-vt version from the lock file
 * @property {string} file archive name
 * @property {string} include directory that holds `ghostty/vt.h`
 * @property {string | undefined} dll absolute path of `ghostty-vt.dll` (Windows targets only)
 */

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function unknownArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * The lock entry for `target`.
 * @param {unknown} lock parsed `ghostty-vt.lock.json`
 * @param {string} target Rust target triple
 * @returns {{ version: string, file: string, includeDir: string, dll: string | undefined }}
 */
export function lockEntryFor(lock, target) {
  if (!isRecord(lock) || typeof lock.version !== 'string') {
    throw new Error(`${GHOSTTY_LOCK_PATH} is malformed`);
  }
  for (const entry of unknownArray(lock.artifacts)) {
    if (!isRecord(entry) || !unknownArray(entry.targets).includes(target)) {
      continue;
    }
    if (typeof entry.file !== 'string' || typeof entry.includeDir !== 'string') {
      throw new Error(`${GHOSTTY_LOCK_PATH}: the entry for ${target} is malformed`);
    }
    return {
      version: lock.version,
      file: entry.file,
      includeDir: entry.includeDir,
      dll: typeof entry.dll === 'string' ? entry.dll : undefined,
    };
  }
  throw new Error(`${GHOSTTY_LOCK_PATH} locks no artefact for ${target}`);
}

/**
 * Finds the `OUT_DIR` of piarc-ghostty-sys's build script in cargo's `--message-format=json`
 * output (one JSON object per line).
 * @param {string} output
 * @returns {string}
 */
export function findBuildScriptOutDir(output) {
  let found;
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) {
      continue;
    }
    /** @type {unknown} */
    const message = JSON.parse(line);
    if (
      isRecord(message) &&
      message.reason === 'build-script-executed' &&
      typeof message.package_id === 'string' &&
      message.package_id.includes(GHOSTTY_SYS_PACKAGE) &&
      typeof message.out_dir === 'string'
    ) {
      found = message.out_dir;
    }
  }
  if (found === undefined) {
    throw new Error(`cargo reported no build script output for ${GHOSTTY_SYS_PACKAGE}`);
  }
  return found;
}

/** @returns {Promise<string>} the host target triple */
export async function hostTarget() {
  const info = await capture('rustc', ['-vV']);
  const line = info.split('\n').find((l) => l.startsWith('host: '));
  if (line === undefined) {
    throw new Error('rustc -vV printed no host line');
  }
  return line.slice('host: '.length).trim();
}

/**
 * Builds piarc-ghostty-sys (a no-op when it is fresh) the way a dependent build would, so its
 * build script has downloaded, verified and unpacked the artefact, and returns where the pieces
 * are. Without `target` the host is built without `--target`, which shares cargo's default
 * target directory with `cargo test` and host builds of the Core module.
 * @param {{ target?: string | undefined, release?: boolean }} [options]
 * @returns {Promise<GhosttyArtifact>}
 */
export async function ghosttyArtifact(options = {}) {
  const args = ['build', '--locked', '--message-format=json', '-p', GHOSTTY_SYS_PACKAGE];
  if (options.target !== undefined) {
    args.push('--target', options.target);
  }
  if (options.release === true) {
    args.push('--release');
  }
  const outDir = findBuildScriptOutDir(await capture('cargo', args));
  const triple = options.target ?? (await hostTarget());
  const entry = lockEntryFor(readJsonFile(GHOSTTY_LOCK_PATH), triple);
  const root = path.join(outDir, 'ghostty-vt');
  return {
    version: entry.version,
    file: entry.file,
    include: path.join(root, entry.includeDir),
    dll: entry.dll === undefined ? undefined : path.join(root, entry.dll),
  };
}
