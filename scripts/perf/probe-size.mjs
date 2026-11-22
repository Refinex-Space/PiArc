// T44 probe: the release build's sizes (architecture chapter 11). The installer is the macOS
// DMG of this architecture (`npm run package:desktop -- --flavor release --arch <arch> --make`)
// or the Windows Velopack `*-Setup.exe` (`scripts/release/pack-windows.mjs --flavor release`);
// the installed size is the packaged application directory (the `.app` bundle on macOS, the
// directory Velopack installs on Windows), counted file by file without following links. MB is
// 10^6 bytes.
//
//   node scripts/perf/probe-size.mjs --out <file.json>
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { isMain, repoRoot } from '../lib/repo.mjs';
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
  return {
    values: {
      'installer-size': (await lstat(installer)).size / MB,
      'installed-size': (await directoryBytes(installed)) / MB,
    },
    samples: 1,
    detail: {
      installer: path.relative(repoRoot, installer),
      installed: path.relative(repoRoot, installed),
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
