// T44 probe: the release build's sizes (architecture chapter 11). The installer is the macOS
// DMG of this architecture (`npm run package:desktop -- --flavor release --arch <arch> --make`)
// or the Windows Velopack `*-Setup.exe` (`scripts/release/pack-windows.mjs --flavor release`);
// the installed size is the packaged application directory (the `.app` bundle on macOS, the
// directory Velopack installs on Windows), counted file by file without following links. MB is
// 10^6 bytes.
//
// ADR-0095: the voice dictation assets (`speech/` under the resources) have a budget of their
// own and the two existing rows are judged without them. Installed: the speech directory's
// files. Installer (macOS): the same `.app` made into a DMG the way the DMG maker does (HFS+,
// ULFO), once as it is and once without `speech/`; the difference is the speech share of the
// installer. Windows: the speech files deflated at level 9 (Velopack packs deflate), an
// estimate of the same share.
//
//   node scripts/perf/probe-size.mjs --out <file.json>
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { deflateRawSync } from 'node:zlib';

import { isMain, repoRoot, run } from '../lib/repo.mjs';
import { MB } from './lib.mjs';

const OUT = path.join(repoRoot, 'apps', 'desktop', 'out', 'release');

/**
 * Bytes of the files under `dir` (links count as themselves).
 * @param {string} dir
 * @returns {Promise<number>}
 */
export async function directoryBytes(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(full);
    else total += (await lstat(full)).size;
  }
  return total;
}

/**
 * The first file under `dir` whose name matches `pattern`, searched breadth first.
 * @param {string} dir
 * @param {RegExp} pattern
 * @returns {Promise<string | undefined>}
 */
async function find(dir, pattern) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const file = entries.find((e) => e.isFile() && pattern.test(e.name));
  if (file !== undefined) return path.join(dir, file.name);
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const found = await find(path.join(dir, entry.name), pattern);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Bytes of a DMG made like the DMG maker's from a copy of `app`, with or without `speech/`.
 * @param {string} app the `.app`
 * @param {boolean} withSpeech
 * @returns {Promise<number>}
 */
async function dmgBytes(app, withSpeech) {
  const staging = await mkdtemp(path.join(os.tmpdir(), 'piarc-size-'));
  try {
    const copy = path.join(staging, 'source', path.basename(app));
    await mkdir(path.dirname(copy), { recursive: true });
    if ((await run('ditto', [app, copy])) !== 0) throw new Error('ditto failed');
    if (!withSpeech)
      await rm(path.join(copy, 'Contents', 'Resources', 'speech'), { recursive: true });
    const dmg = path.join(staging, 'probe.dmg');
    const code = await run('hdiutil', [
      'create',
      '-quiet',
      '-volname',
      'PiArc',
      '-srcfolder',
      path.dirname(copy),
      '-fs',
      'HFS+',
      '-format',
      'ULFO',
      '-ov',
      dmg,
    ]);
    if (code !== 0) throw new Error('hdiutil create failed');
    return (await lstat(dmg)).size;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Bytes of the files under `dir` deflated at level 9.
 * @param {string} dir
 * @returns {Promise<number>}
 */
async function deflatedBytes(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await deflatedBytes(full);
    else total += deflateRawSync(await readFile(full), { level: 9 }).length;
  }
  return total;
}

export async function measure() {
  const arch = process.arch;
  const installer =
    process.platform === 'win32'
      ? await find(path.join(OUT, 'velopack', `win32-${arch}`), /-Setup\.exe$/u)
      : await find(path.join(OUT, 'make', 'dmg', arch), /\.dmg$/u);
  if (installer === undefined) {
    throw new Error('no release installer: build it first (see the header of this script)');
  }
  const appDir = path.join(OUT, `PiArc-${process.platform}-${arch}`);
  const installed = process.platform === 'darwin' ? path.join(appDir, 'PiArc.app') : appDir;
  const speech =
    process.platform === 'darwin'
      ? path.join(installed, 'Contents', 'Resources', 'speech')
      : path.join(installed, 'resources', 'speech');
  const speechInstalled = await directoryBytes(speech);
  const speechInstaller =
    process.platform === 'darwin'
      ? (await dmgBytes(installed, true)) - (await dmgBytes(installed, false))
      : await deflatedBytes(speech);
  const installerBytes = (await lstat(installer)).size;
  const installedBytes = await directoryBytes(installed);
  return {
    values: {
      'installer-size': (installerBytes - speechInstaller) / MB,
      'installed-size': (installedBytes - speechInstalled) / MB,
      'speech-installed-size': speechInstalled / MB,
      'speech-installer-delta': speechInstaller / MB,
    },
    samples: 1,
    detail: {
      installer: path.relative(repoRoot, installer),
      installed: path.relative(repoRoot, installed),
      installerTotal: installerBytes / MB,
      installedTotal: installedBytes / MB,
      speechInstallerMethod: process.platform === 'darwin' ? 'dmg difference' : 'deflate estimate',
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      form: { type: 'string' },
      lane: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const result = await measure();
  console.log(JSON.stringify(result, null, 2));
  if (values.out !== undefined) {
    await mkdir(path.dirname(values.out), { recursive: true });
    await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
  }
}

if (isMain(import.meta.url)) await main();
