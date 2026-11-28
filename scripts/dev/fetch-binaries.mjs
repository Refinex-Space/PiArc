// Downloads the third-party binaries locked in third-party/binaries.lock.json and stages the
// Agent Host runtime that packaging copies into Resources/agent-host/ (architecture 5.6).
//
//   node scripts/dev/fetch-binaries.mjs [--platform darwin|win32] [--arch arm64|x64]
//       Stages node, rg and fd for one target (default: this machine) in
//       target/agent-host-runtime/<platform>-<arch>/ and prints the directory.
//   node scripts/dev/fetch-binaries.mjs --binary vpk
//       Downloads one locked artefact (the `any` target, or --platform/--arch) and prints its path.
//   node scripts/dev/fetch-binaries.mjs --all
//       Downloads and checks every locked artefact (after bumping a version).
//
// Every download lands in .tools/cache/binaries/<binary>/ and is checked against the size and
// SHA-256 in the lock file; a mismatch fails the run and the bad file is removed. Cached files
// are re-checked on every use, so a corrupted cache is noticed rather than packaged.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';

import { isMain, isRecord, readJsonFile, repoRoot, run } from '../lib/repo.mjs';

export const LOCK_FILE = path.join(repoRoot, 'third-party', 'binaries.lock.json');
export const CACHE_DIR = path.join(repoRoot, '.tools', 'cache', 'binaries');
export const RUNTIME_DIR = path.join(repoRoot, 'target', 'agent-host-runtime');

/**
 * @typedef {{ url: string, size: number, sha256: string, root?: string }} Artefact
 * @typedef {{ version: string, artefacts: Record<string, Artefact> }} LockedBinary
 */

/** @returns {Record<string, LockedBinary>} */
export function readLock() {
  const lock = readJsonFile(LOCK_FILE);
  if (!isRecord(lock) || !isRecord(lock.binaries)) {
    throw new Error(`${LOCK_FILE} has no "binaries" object`);
  }
  /** @type {Record<string, LockedBinary>} */
  const binaries = {};
  for (const [name, entry] of Object.entries(lock.binaries)) {
    if (!isRecord(entry) || typeof entry.version !== 'string' || !isRecord(entry.artefacts)) {
      throw new Error(`${LOCK_FILE}: "${name}" needs "version" and "artefacts"`);
    }
    /** @type {Record<string, Artefact>} */
    const artefacts = {};
    for (const [target, a] of Object.entries(entry.artefacts)) {
      if (
        !isRecord(a) ||
        typeof a.url !== 'string' ||
        typeof a.size !== 'number' ||
        typeof a.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(a.sha256) ||
        (a.root !== undefined && typeof a.root !== 'string')
      ) {
        throw new Error(`${LOCK_FILE}: "${name}.${target}" needs url, size and a sha256 hex`);
      }
      artefacts[target] = {
        url: a.url,
        size: a.size,
        sha256: a.sha256,
        ...(typeof a.root === 'string' ? { root: a.root } : {}),
      };
    }
    binaries[name] = { version: entry.version, artefacts };
  }
  return binaries;
}

/**
 * @param {string} file
 * @returns {Promise<string>}
 */
export async function sha256Of(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * Checks a file against its lock entry; returns a description of the mismatch, or null.
 * @param {string} file
 * @param {{ size: number, sha256: string }} artefact
 */
export async function mismatch(file, artefact) {
  const { size } = await stat(file);
  if (size !== artefact.size) {
    return `size ${String(size)}, expected ${String(artefact.size)}`;
  }
  const digest = await sha256Of(file);
  return digest === artefact.sha256 ? null : `SHA-256 ${digest}, expected ${artefact.sha256}`;
}

/**
 * Downloads one artefact into the cache (or reuses the cached copy) and verifies it.
 * @param {string} name binary name in the lock file
 * @param {string} target `<platform>-<arch>` or `any`
 * @returns {Promise<string>} path of the verified file
 */
export async function fetchArtefact(name, target) {
  const binary = readLock()[name];
  const artefact = binary?.artefacts[target];
  if (binary === undefined || artefact === undefined) {
    throw new Error(`${LOCK_FILE} has no artefact "${name}" for ${target}`);
  }
  return downloadVerified(artefact, path.join(CACHE_DIR, name), LOCK_FILE);
}

/**
 * Downloads `artefact.url` into `dir` (or reuses the cached copy) and checks its size and
 * SHA-256; a mismatch removes the file and fails.
 * @param {{ url: string, size: number, sha256: string }} artefact
 * @param {string} dir cache directory
 * @param {string} lockFile named in the error when the download does not match
 * @returns {Promise<string>} path of the verified file
 */
export async function downloadVerified(artefact, dir, lockFile) {
  const file = path.join(dir, path.posix.basename(new URL(artefact.url).pathname));
  if (existsSync(file)) {
    const problem = await mismatch(file, artefact);
    if (problem === null) {
      return file;
    }
    console.warn(`cached ${path.relative(repoRoot, file)} does not match the lock (${problem})`);
    await rm(file);
  }
  await mkdir(dir, { recursive: true });
  console.log(`downloading ${artefact.url}`);
  const response = await fetch(artefact.url, { redirect: 'follow' });
  if (!response.ok || response.body === null) {
    throw new Error(`downloading ${artefact.url} failed: HTTP ${String(response.status)}`);
  }
  const partial = `${file}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const problem = await mismatch(partial, artefact);
  if (problem !== null) {
    await rm(partial);
    throw new Error(
      `${artefact.url} does not match ${path.relative(repoRoot, lockFile)}: ${problem}`,
    );
  }
  await rename(partial, file);
  return file;
}

/**
 * Extracts an archive with the system `tar` (bsdtar on macOS and Windows 10+, which also reads
 * zip and bzip2 files), keeping file modes and the code signatures embedded in Mach-O files.
 * @param {string} archive
 * @param {string} into
 */
export async function extract(archive, into) {
  await mkdir(into, { recursive: true });
  // On Windows, Git's GNU tar can come first on PATH and cannot read zip files.
  const tar =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  const code = await run(tar, ['-xf', archive, '-C', into]);
  if (code !== 0) {
    throw new Error(`tar could not extract ${archive} (exit code ${String(code)})`);
  }
}

/**
 * Files of the Node.js distribution that the Agent Host runtime keeps: the executable, npm and
 * npx (MCP servers and Pi packages need them, ADR-0015) and the licence. Headers, man pages,
 * docs and corepack are left out.
 * @param {string} platform
 */
function nodeKeep(platform) {
  return platform === 'win32'
    ? ['node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd', path.join('node_modules', 'npm'), 'LICENSE']
    : [
        path.join('bin', 'node'),
        path.join('bin', 'npm'),
        path.join('bin', 'npx'),
        path.join('lib', 'node_modules', 'npm'),
        'LICENSE',
      ];
}

/**
 * Stages node, rg and fd for one target in target/agent-host-runtime/<platform>-<arch>/:
 * `node/` (the trimmed Node.js distribution) and `bin/rg`, `bin/fd` (`.exe` on Windows).
 * The directory is rebuilt from the verified archives every time.
 * @param {string} platform `darwin` or `win32`
 * @param {string} arch `arm64` or `x64`
 * @returns {Promise<string>} the staged directory
 */
export async function stageAgentHostRuntime(platform, arch) {
  const target = `${platform}-${arch}`;
  const lock = readLock();
  const out = path.join(RUNTIME_DIR, target);
  await rm(out, { recursive: true, force: true });
  await mkdir(path.join(out, 'bin'), { recursive: true });
  const scratch = await mkdtemp(path.join(RUNTIME_DIR, `.${target}-`));
  try {
    const nodeArtefact = lock.node?.artefacts[target];
    await extract(await fetchArtefact('node', target), path.join(scratch, 'node'));
    const nodeRoot = path.join(scratch, 'node', nodeArtefact?.root ?? '');
    for (const relative of nodeKeep(platform)) {
      const from = path.join(nodeRoot, relative);
      if (!existsSync(from)) {
        throw new Error(`the Node.js archive for ${target} has no ${relative}`);
      }
      await mkdir(path.dirname(path.join(out, 'node', relative)), { recursive: true });
      await rename(from, path.join(out, 'node', relative));
    }
    const exe = platform === 'win32' ? '.exe' : '';
    /** @type {Array<[string, string]>} */
    const tools = [
      ['ripgrep', `rg${exe}`],
      ['fd', `fd${exe}`],
    ];
    for (const [name, file] of tools) {
      await extract(await fetchArtefact(name, target), path.join(scratch, name));
      const from = path.join(scratch, name, lock[name]?.artefacts[target]?.root ?? '', file);
      if (!existsSync(from)) {
        throw new Error(`the ${name} archive for ${target} has no ${file}`);
      }
      await rename(from, path.join(out, 'bin', file));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return out;
}

async function main() {
  const { values } = parseArgs({
    options: {
      platform: { type: 'string', default: process.platform },
      arch: { type: 'string', default: process.arch },
      binary: { type: 'string' },
      all: { type: 'boolean', default: false },
    },
  });
  if (values.all) {
    for (const [name, binary] of Object.entries(readLock())) {
      for (const target of Object.keys(binary.artefacts)) {
        console.log(`${name} ${binary.version} ${target}: ${await fetchArtefact(name, target)}`);
      }
    }
    return;
  }
  if (values.binary !== undefined) {
    const binary = readLock()[values.binary];
    const target =
      binary?.artefacts.any !== undefined ? 'any' : `${values.platform}-${values.arch}`;
    console.log(await fetchArtefact(values.binary, target));
    return;
  }
  console.log(await stageAgentHostRuntime(values.platform, values.arch));
}

if (isMain(import.meta.url)) {
  await main();
}
