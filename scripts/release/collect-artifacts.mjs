// Turns the release workflow's downloaded build artefacts into the flat release directory with
// the names of ADR-0111 rule 1 (the names are the app's contract; it guesses no others):
//
//   PiArc-<v>-macos-<arm64|x64>.dmg     ← Forge's  PiArc-<v>-<arch>.dmg
//   PiArc-<v>-macos-<arm64|x64>.zip     ← Forge's  PiArc-darwin-<arch>-<v>.zip
//   PiArc-<v>-windows-<arch>-Setup.exe  ← vpk's    <packId>-win-<arch>-Setup.exe
//   releases.win-<arch>.json and the Full .nupkg of <v> it lists (vpk's names, unchanged)
//
// vpk's portable zip, assets.*.json, RELEASES files and delta packages are left out. Anything
// else, a file of another version, a missing artefact or a feed whose Full package does not
// match its size and SHA-256 fails the run.
//
//   node scripts/release/collect-artifacts.mjs --version <v> --from <dir> --out <dir>
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';

import { isMain, isRecord } from '../lib/repo.mjs';
import { assertVersion } from './version.mjs';

const MAC_ARCHS = ['arm64', 'x64'];
const WINDOWS_ARCHS = ['x64', 'arm64'];

/** Files of a vpk release directory that are not release artefacts. */
const LEFT_OUT = [
  /-Portable\.zip$/,
  /^assets\.[\w-]+\.json$/,
  /^RELEASES(?:-[\w-]+)?$/,
  /-delta\.nupkg$/,
];

/**
 * Every file below `dir`.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function filesBelow(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesBelow(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/** @param {string} file */
async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * The release name of one build file, `null` for a file left out; throws for anything else.
 * Velopack feeds and packages are resolved later (`kind: 'feed' | 'nupkg'`).
 * @param {string} name
 * @param {string} version
 * @returns {{ kind: 'file', target: string } | { kind: 'feed', arch: string }
 *   | { kind: 'nupkg' } | null}
 */
export function classify(name, version) {
  if (LEFT_OUT.some((pattern) => pattern.test(name))) {
    return null;
  }
  const dmg = /^PiArc-(.+)-(arm64|x64)\.dmg$/.exec(name);
  if (dmg !== null) {
    expectVersion(name, dmg[1], version);
    return { kind: 'file', target: `PiArc-${version}-macos-${String(dmg[2])}.dmg` };
  }
  const zip = /^PiArc-darwin-(arm64|x64)-(.+)\.zip$/.exec(name);
  if (zip !== null) {
    expectVersion(name, zip[2], version);
    return { kind: 'file', target: `PiArc-${version}-macos-${String(zip[1])}.zip` };
  }
  const setup = /-win-(x64|arm64)-Setup\.exe$/.exec(name);
  if (setup !== null) {
    return { kind: 'file', target: `PiArc-${version}-windows-${String(setup[1])}-Setup.exe` };
  }
  const feed = /^releases\.win-(x64|arm64)\.json$/.exec(name);
  if (feed !== null) {
    return { kind: 'feed', arch: feed[1] ?? '' };
  }
  if (name.endsWith('.nupkg')) {
    return { kind: 'nupkg' };
  }
  throw new Error(`unexpected build file ${name}`);
}

/**
 * @param {string} name
 * @param {string | undefined} found
 * @param {string} version
 */
function expectVersion(name, found, version) {
  if (found !== version) {
    throw new Error(`${name} is version ${String(found)}, the release is ${version}`);
  }
}

/**
 * The Full asset of `version` in a Velopack feed (`releases.<channel>.json`).
 * @param {unknown} feed
 * @param {string} version
 * @param {string} feedName for messages
 */
export function fullAssetOf(feed, version, feedName) {
  /** @type {unknown[] | undefined} */
  const assets = isRecord(feed) && Array.isArray(feed.Assets) ? feed.Assets : undefined;
  if (assets === undefined) {
    throw new Error(`${feedName} has no Assets list`);
  }
  const full = assets.filter((a) => isRecord(a) && a.Type === 'Full' && a.Version === version);
  const asset = full[0];
  if (full.length !== 1 || !isRecord(asset)) {
    throw new Error(`${feedName} lists ${String(full.length)} Full packages of ${version}`);
  }
  const { FileName, Size, SHA256 } = asset;
  if (
    typeof FileName !== 'string' ||
    path.basename(FileName) !== FileName ||
    !FileName.endsWith('.nupkg') ||
    typeof Size !== 'number' ||
    typeof SHA256 !== 'string'
  ) {
    throw new Error(`${feedName}: the Full package entry is malformed`);
  }
  return { fileName: FileName, size: Size, sha256: SHA256.toLowerCase() };
}

/**
 * Collects the release files of `version` from `from` into `out` (created; must be empty).
 * @param {{ version: string, from: string, out: string }} options
 * @returns {Promise<string[]>} the release file names, sorted
 */
export async function collect({ version, from, out }) {
  assertVersion(version);
  /** @type {Map<string, string>} release name → source path */
  const chosen = new Map();
  /** @type {Map<string, string>} nupkg name → source path */
  const packages = new Map();
  /** @type {{ arch: string, file: string }[]} */
  const feeds = [];
  const take = (/** @type {string} */ target, /** @type {string} */ source) => {
    const other = chosen.get(target);
    if (other !== undefined) {
      throw new Error(`${target} comes from two files: ${other} and ${source}`);
    }
    chosen.set(target, source);
  };
  for (const file of await filesBelow(from)) {
    const name = path.basename(file);
    const what = classify(name, version);
    if (what === null) {
      continue;
    }
    if (what.kind === 'file') {
      take(what.target, file);
    } else if (what.kind === 'feed') {
      take(name, file);
      feeds.push({ arch: what.arch, file });
    } else {
      packages.set(name, file);
    }
  }
  for (const { file } of feeds) {
    const name = path.basename(file);
    /** @type {unknown} */
    const feed = JSON.parse(await readFile(file, 'utf8'));
    const full = fullAssetOf(feed, version, name);
    const source = packages.get(full.fileName);
    if (source === undefined) {
      throw new Error(`${name} lists ${full.fileName}, which is not among the build files`);
    }
    const size = (await stat(source)).size;
    if (size !== full.size || (await sha256(source)) !== full.sha256) {
      throw new Error(`${full.fileName} does not match its entry in ${name}`);
    }
    take(full.fileName, source);
    packages.delete(full.fileName);
  }
  if (packages.size > 0) {
    throw new Error(`packages no feed lists: ${[...packages.keys()].join(', ')}`);
  }
  const required = [
    ...MAC_ARCHS.flatMap((a) => [
      `PiArc-${version}-macos-${a}.dmg`,
      `PiArc-${version}-macos-${a}.zip`,
    ]),
    ...WINDOWS_ARCHS.flatMap((a) => [
      `PiArc-${version}-windows-${a}-Setup.exe`,
      `releases.win-${a}.json`,
    ]),
  ];
  const missing = required.filter((name) => !chosen.has(name));
  if (missing.length > 0) {
    throw new Error(`missing release files: ${missing.join(', ')}`);
  }
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length > 0) {
    throw new Error(`${out} is not empty`);
  }
  for (const [target, source] of chosen) {
    await copyFile(source, path.join(out, target));
  }
  return [...chosen.keys()].sort();
}

async function main() {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      from: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (values.version === undefined || values.from === undefined || values.out === undefined) {
    throw new Error('usage: --version <v> --from <build artefacts> --out <release dir>');
  }
  const names = await collect({ version: values.version, from: values.from, out: values.out });
  for (const name of names) {
    console.log(name);
  }
}

if (isMain(import.meta.url)) {
  await main();
}
