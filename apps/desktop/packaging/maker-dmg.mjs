// A Forge maker that builds the macOS DMG with the system's `hdiutil`.
//
// Forge's own maker-dmg goes through appdmg, whose native modules (fs-xattr, macos-alias)
// are compiled by install scripts; the repository installs with `npm ci --ignore-scripts`
// (architecture section 13.1), so they are never built. `hdiutil` ships with macOS and needs
// nothing installed. The image holds the app and an `Applications` link, so the first-run
// guidance (drag into Applications before opening, ADR-0018 rule 2) works from the window.
import { spawn } from 'node:child_process';
import { mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';

import { MakerBase } from '@electron-forge/maker-base';

/**
 * @param {string} command
 * @param {string[]} args
 */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed (${String(code)}):\n${output}`));
      }
    });
  });
}

/** @extends {MakerBase<Record<string, never>>} */
export class MakerHdiutilDmg extends MakerBase {
  name = 'dmg-hdiutil';

  /** @type {import('@electron-forge/shared-types').ForgePlatform[]} */
  defaultPlatforms = ['darwin'];

  /** @override */
  isSupportedOnCurrentPlatform() {
    return process.platform === 'darwin';
  }

  /**
   * @override
   * @param {import('@electron-forge/maker-base').MakerOptions} options
   * @returns {Promise<string[]>}
   */
  async make({ dir, makeDir, appName, packageJSON, targetArch }) {
    /** @type {unknown} */
    const manifest = packageJSON;
    const version =
      typeof manifest === 'object' && manifest !== null && 'version' in manifest
        ? String(manifest.version)
        : '0.0.0';
    const outDir = path.join(makeDir, 'dmg', targetArch);
    const dmg = path.join(outDir, `${appName}-${version}-${targetArch}.dmg`);
    const staging = path.join(outDir, '.staging');
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      // ditto keeps symlinks, modes, extended attributes and signatures exactly.
      await run('ditto', [path.join(dir, `${appName}.app`), path.join(staging, `${appName}.app`)]);
      await symlink('/Applications', path.join(staging, 'Applications'));
      await rm(dmg, { force: true });
      // ULFO (LZFSE) needs macOS 10.11+, below Electron 45's minimum (macOS 13).
      await run('hdiutil', [
        'create',
        '-volname',
        appName,
        '-srcfolder',
        staging,
        '-fs',
        'HFS+',
        '-format',
        'ULFO',
        '-ov',
        dmg,
      ]);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return [dmg];
  }
}
