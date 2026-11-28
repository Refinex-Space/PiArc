import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  KEPT_ELECTRON_LOCALES,
  electronLocalesDir,
  keepInNodeRuntime,
  trimElectronLocales,
} from './trim.mjs';

const roots = /** @type {string[]} */ ([]);
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('keepInNodeRuntime', () => {
  it("drops npm's documentation and man pages on both layouts", () => {
    const mac = path.join('rt', 'node', 'lib', 'node_modules', 'npm');
    const win = path.join('rt', 'node', 'node_modules', 'npm');
    for (const npm of [mac, win]) {
      expect(keepInNodeRuntime(path.join(npm, 'docs'))).toBe(false);
      expect(keepInNodeRuntime(path.join(npm, 'docs', 'content', 'npm.md'))).toBe(false);
      expect(keepInNodeRuntime(path.join(npm, 'man', 'man1', 'npm.1'))).toBe(false);
      expect(keepInNodeRuntime(path.join(npm, 'lib', 'npm.js'))).toBe(true);
      expect(keepInNodeRuntime(path.join(npm, 'bin', 'npm-cli.js'))).toBe(true);
    }
  });

  it('keeps folders named docs or man inside npm dependencies', () => {
    const dep = path.join('rt', 'node', 'lib', 'node_modules', 'npm', 'node_modules', 'x');
    expect(keepInNodeRuntime(path.join(dep, 'docs', 'a.md'))).toBe(true);
    expect(keepInNodeRuntime(path.join(dep, 'man'))).toBe(true);
    expect(keepInNodeRuntime(path.join('rt', 'node', 'bin', 'node'))).toBe(true);
  });
});

describe('trimElectronLocales', () => {
  it('keeps only the locales of the app and the other resources', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'piarc-trim-'));
    roots.push(root);
    const app = path.join(root, 'PiArc.app');
    const dir = electronLocalesDir(app);
    for (const name of ['en.lproj', 'zh_CN.lproj', 'zh_TW.lproj', 'fr.lproj', 'de.lproj']) {
      await mkdir(path.join(dir, name), { recursive: true });
      await writeFile(path.join(dir, name, 'locale.pak'), 'x');
    }
    await writeFile(path.join(dir, 'Info.plist'), '<plist/>');
    await mkdir(path.join(dir, 'MainMenu.nib'));

    const removed = await trimElectronLocales(app);

    expect(removed.sort()).toEqual(['de.lproj', 'fr.lproj']);
    expect((await readdir(dir)).sort()).toEqual(
      ['Info.plist', 'MainMenu.nib', ...KEPT_ELECTRON_LOCALES.map((l) => `${l}.lproj`)].sort(),
    );
  });

  it('fails when the framework has none of the kept locales', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'piarc-trim-'));
    roots.push(root);
    const app = path.join(root, 'PiArc.app');
    await mkdir(path.join(electronLocalesDir(app), 'fr.lproj'), { recursive: true });
    await expect(trimElectronLocales(app)).rejects.toThrow(/en\.lproj/u);
  });
});
