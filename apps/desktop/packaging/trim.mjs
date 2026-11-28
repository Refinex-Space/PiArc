// What packaging leaves out of the app to stay within the installed-size budget (architecture
// chapter 11, I41; T44):
//
// - npm's documentation and man pages in the bundled Node (`npm help` is never run: PiArc uses
//   npm only to install packages, ADR-0058);
// - on macOS, Electron's UI locales other than the app's languages (English and Chinese):
//   Chromium falls back to English for any other system language, like the app itself;
// - on macOS, the packaged Core module's local symbols (strip -x before signing; the
//   original build output keeps them for source-tree debugging).
//
// The bundle is signed again afterwards (packaging/macos-sign.mjs), so the changed files are
// sealed like the rest.
import { execFile } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

/** Electron's locales the app keeps (`<name>.lproj`): its own languages. */
export const KEPT_ELECTRON_LOCALES = Object.freeze(['en', 'zh_CN', 'zh_TW']);

/**
 * Whether `source` (a path under the bundled Node runtime) is copied into the app: everything
 * except npm's own `docs/` and `man/`.
 * @param {string} source
 */
export function keepInNodeRuntime(source) {
  const parts = source.split(/[\\/]/u);
  const npm = parts.lastIndexOf('npm');
  if (npm < 1 || parts[npm - 1] !== 'node_modules') return true;
  const next = parts[npm + 1];
  return next !== 'docs' && next !== 'man';
}

/**
 * The directory of Electron's locales in a macOS app bundle.
 * @param {string} appPath the `.app`
 */
export function electronLocalesDir(appPath) {
  return path.join(
    appPath,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Resources',
  );
}

/**
 * Removes Electron's locales other than `KEPT_ELECTRON_LOCALES`; returns the removed folders.
 * @param {string} appPath the `.app`
 * @returns {Promise<string[]>}
 */
export async function trimElectronLocales(appPath) {
  const dir = electronLocalesDir(appPath);
  const entries = await readdir(dir);
  const kept = new Set(KEPT_ELECTRON_LOCALES.map((l) => `${l}.lproj`));
  const missing = [...kept].filter((name) => !entries.includes(name));
  if (missing.length > 0) {
    throw new Error(`Electron Framework has no ${missing.join(', ')} in ${dir}`);
  }
  const removed = entries.filter((name) => name.endsWith('.lproj') && !kept.has(name));
  for (const name of removed) {
    await rm(path.join(dir, name), { recursive: true, force: true });
  }
  return removed;
}

/**
 * Removes the local symbols of a Mach-O file (macOS `strip -x`); its signature must be redone.
 * @param {string} file
 */
export async function stripLocalSymbols(file) {
  await promisify(execFile)('strip', ['-x', file]);
}
