import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classify, collect, fullAssetOf } from './collect-artifacts.mjs';

const V = '1.0.0';
let root = '';

/**
 * @param {string} rel
 * @param {string} content
 */
async function put(rel, content) {
  const file = path.join(root, 'from', rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** The artefacts the release workflow downloads, with Forge's and vpk's names. */
async function buildTree() {
  for (const arch of ['arm64', 'x64']) {
    await put(`release-macos-${arch}/dmg/${arch}/PiArc-${V}-${arch}.dmg`, `dmg ${arch}`);
    await put(
      `release-macos-${arch}/zip/darwin/${arch}/PiArc-darwin-${arch}-${V}.zip`,
      `zip ${arch}`,
    );
  }
  for (const arch of ['x64', 'arm64']) {
    const dir = `release-windows-${arch}`;
    const nupkg = `cn.piarc.desktop-${V}-win-${arch}-full.nupkg`;
    const bytes = `nupkg ${arch}`;
    await put(`${dir}/${nupkg}`, bytes);
    await put(`${dir}/cn.piarc.desktop-win-${arch}-Setup.exe`, `setup ${arch}`);
    await put(`${dir}/cn.piarc.desktop-win-${arch}-Portable.zip`, 'portable');
    await put(`${dir}/assets.win-${arch}.json`, '{}');
    await put(`${dir}/RELEASES-win-${arch}`, 'legacy');
    await put(
      `${dir}/releases.win-${arch}.json`,
      JSON.stringify({
        Assets: [
          {
            PackageId: 'cn.piarc.desktop',
            Version: V,
            Type: 'Full',
            FileName: nupkg,
            SHA1: '',
            SHA256: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
            Size: Buffer.byteLength(bytes),
          },
        ],
      }),
    );
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'piarc collect 产物-'));
  await buildTree();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('collect', () => {
  it('writes exactly the ADR-0111 release files', async () => {
    const out = path.join(root, 'out');
    const names = await collect({ version: V, from: path.join(root, 'from'), out });
    const expected = [
      'PiArc-1.0.0-macos-arm64.dmg',
      'PiArc-1.0.0-macos-arm64.zip',
      'PiArc-1.0.0-macos-x64.dmg',
      'PiArc-1.0.0-macos-x64.zip',
      'PiArc-1.0.0-windows-arm64-Setup.exe',
      'PiArc-1.0.0-windows-x64-Setup.exe',
      'cn.piarc.desktop-1.0.0-win-arm64-full.nupkg',
      'cn.piarc.desktop-1.0.0-win-x64-full.nupkg',
      'releases.win-arm64.json',
      'releases.win-x64.json',
    ];
    expect(names).toEqual(expected);
    expect((await readdir(out)).sort()).toEqual(expected);
  });

  it('fails on a missing artefact', async () => {
    await rm(path.join(root, 'from', 'release-macos-x64'), { recursive: true });
    await expect(
      collect({ version: V, from: path.join(root, 'from'), out: path.join(root, 'out') }),
    ).rejects.toThrow(/missing release files: PiArc-1\.0\.0-macos-x64\.dmg/);
  });

  it('fails on a package that does not match its feed entry', async () => {
    await put('release-windows-x64/cn.piarc.desktop-1.0.0-win-x64-full.nupkg', 'changed');
    await expect(
      collect({ version: V, from: path.join(root, 'from'), out: path.join(root, 'out') }),
    ).rejects.toThrow(/does not match its entry/);
  });

  it('fails on an unexpected file, a package no feed lists and a non-empty output', async () => {
    const from = path.join(root, 'from');
    await put('stray/notes.txt', 'x');
    await expect(collect({ version: V, from, out: path.join(root, 'a') })).rejects.toThrow(
      /unexpected build file notes\.txt/,
    );
    await rm(path.join(from, 'stray'), { recursive: true });
    await put('release-windows-x64/cn.piarc.desktop-0.9.0-win-x64-full.nupkg', 'old');
    await expect(collect({ version: V, from, out: path.join(root, 'b') })).rejects.toThrow(
      /packages no feed lists/,
    );
    await rm(path.join(from, 'release-windows-x64/cn.piarc.desktop-0.9.0-win-x64-full.nupkg'));
    await put('../c/existing', 'x');
    await expect(collect({ version: V, from, out: path.join(root, 'c') })).rejects.toThrow(
      /not empty/,
    );
  });
});

describe('classify', () => {
  it('refuses a build of another version', () => {
    expect(() => classify('PiArc-0.9.0-arm64.dmg', V)).toThrow(/version 0\.9\.0/);
    expect(() => classify('PiArc-darwin-x64-1.0.1.zip', V)).toThrow(/version 1\.0\.1/);
  });

  it('leaves out the portable zip, asset lists, RELEASES and deltas', () => {
    for (const name of [
      'cn.piarc.desktop-win-x64-Portable.zip',
      'assets.win-x64.json',
      'RELEASES-win-x64',
      'cn.piarc.desktop-1.0.0-win-x64-delta.nupkg',
    ]) {
      expect(classify(name, V)).toBeNull();
    }
  });
});

describe('fullAssetOf', () => {
  it('refuses a missing, repeated or path-like Full entry', () => {
    expect(() => fullAssetOf({ Assets: [] }, V, 'f')).toThrow(/0 Full packages/);
    const entry = { Type: 'Full', Version: V, FileName: '../x.nupkg', Size: 1, SHA256: 'a' };
    expect(() => fullAssetOf({ Assets: [entry] }, V, 'f')).toThrow(/malformed/);
    const ok = { ...entry, FileName: 'x.nupkg' };
    expect(() => fullAssetOf({ Assets: [ok, ok] }, V, 'f')).toThrow(/2 Full packages/);
  });
});
