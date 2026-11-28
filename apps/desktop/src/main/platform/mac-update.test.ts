import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SWAP_SCRIPT,
  bundleOf,
  replaceable,
  stageMacUpdate,
  stagingDir,
  type MacInstallPorts,
} from './mac-update.js';

describe('bundleOf', () => {
  it('finds the bundle of the executable', () => {
    expect(bundleOf('/Applications/PiArc.app/Contents/MacOS/PiArc')).toBe(
      '/Applications/PiArc.app',
    );
    expect(bundleOf('/Users/me/Applications/PiArc 2.app/Contents/MacOS/PiArc')).toBe(
      '/Users/me/Applications/PiArc 2.app',
    );
  });

  it('answers nothing outside a bundle', () => {
    expect(bundleOf('/usr/local/bin/piarc')).toBeUndefined();
    expect(bundleOf('/Applications/PiArc/Contents/MacOS/PiArc')).toBeUndefined();
  });
});

describe('replaceable', () => {
  const writable = (paths: string[]) => (target: string) => Promise.resolve(paths.includes(target));

  it('accepts a writable bundle in a writable folder', async () => {
    expect(
      await replaceable(
        '/Applications/PiArc.app',
        writable(['/Applications', '/Applications/PiArc.app']),
      ),
    ).toBeUndefined();
  });

  it('refuses App Translocation, read-only places and non-bundles', async () => {
    const translocated = '/private/var/folders/x/T/AppTranslocation/0A1B/d/PiArc.app';
    expect(await replaceable(translocated, () => Promise.resolve(true))).toBe('translocated');
    expect(
      await replaceable('/Applications/PiArc.app', writable(['/Applications/PiArc.app'])),
    ).toBe('notWritable');
    expect(await replaceable('/Applications/PiArc.app', writable(['/Applications']))).toBe(
      'notWritable',
    );
    expect(await replaceable(undefined, () => Promise.resolve(true))).toBe('notBundle');
  });
});

function fakePorts(plist: Record<string, string>, dittoCode = 0) {
  const calls: { command: string; args: readonly string[] }[] = [];
  const removed: string[] = [];
  const ports: MacInstallPorts = {
    run: (command, args) => {
      calls.push({ command, args });
      if (command.endsWith('ditto')) return Promise.resolve({ code: dittoCode, stdout: '' });
      const key = args[1] ?? '';
      return Promise.resolve(
        key in plist ? { code: 0, stdout: `${plist[key] ?? ''}\n` } : { code: 1, stdout: '' },
      );
    },
    writable: () => Promise.resolve(true),
    removeDir: (dir) => {
      removed.push(dir);
      return Promise.resolve();
    },
    makeDir: () => Promise.resolve(),
    writeFile: () => Promise.resolve(),
    spawnDetached: () => undefined,
  };
  return { ports, calls, removed };
}

const OPTIONS = {
  archive: '/cache/updates/1.1.0/PiArc-1.1.0-macos-arm64.zip',
  bundle: '/Applications/PiArc.app',
  version: '1.1.0',
  identifier: 'cn.piarc.desktop',
};

describe('stageMacUpdate', () => {
  it('extracts next to the bundle and checks the identity', async () => {
    const { ports, calls } = fakePorts({
      CFBundleIdentifier: 'cn.piarc.desktop',
      CFBundleShortVersionString: '1.1.0',
    });
    const app = await stageMacUpdate(ports, OPTIONS);
    const staging = stagingDir(OPTIONS.bundle, '1.1.0');
    expect(staging).toBe('/Applications/.PiArc.app.update-1.1.0');
    expect(app).toBe(path.join(staging, 'PiArc.app'));
    expect(calls[0]).toEqual({
      command: '/usr/bin/ditto',
      args: ['-x', '-k', OPTIONS.archive, staging],
    });
  });

  it('THR-09 refuses another app or another version and removes the staging folder', async () => {
    for (const plist of [
      { CFBundleIdentifier: 'com.example.other', CFBundleShortVersionString: '1.1.0' },
      { CFBundleIdentifier: 'cn.piarc.desktop', CFBundleShortVersionString: '1.0.9' },
      { CFBundleIdentifier: 'cn.piarc.desktop' },
    ]) {
      const { ports, removed } = fakePorts(plist);
      await expect(stageMacUpdate(ports, OPTIONS)).rejects.toThrow();
      expect(removed.at(-1)).toBe(stagingDir(OPTIONS.bundle, '1.1.0'));
    }
  });

  it('reports a failed extraction', async () => {
    const { ports } = fakePorts({}, 1);
    await expect(stageMacUpdate(ports, OPTIONS)).rejects.toThrow(/could not be extracted/);
  });
});

// The helper itself, on the real shell: the swap, and the restore when the new app cannot move.
describe.runIf(process.platform === 'darwin')('the swap helper', () => {
  let root: string;
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function app(dir: string, marker: string): Promise<void> {
    await mkdir(path.join(dir, 'Contents'), { recursive: true });
    await writeFile(path.join(dir, 'Contents', 'marker'), marker);
  }

  /** A pid that has exited. */
  async function exitedPid(): Promise<number> {
    const child = spawn('/usr/bin/true');
    const pid = child.pid ?? 0;
    await new Promise((resolve) => child.on('exit', resolve));
    return pid;
  }

  function runScript(args: string[]): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
      // `open` is replaced by a stub that records what would open.
      const bin = path.join(root, 'bin');
      execFile(
        '/bin/sh',
        [path.join(root, 'swap.sh'), ...args],
        { env: { PATH: `${bin}:/usr/bin:/bin` } },
        (error, stdout) => {
          resolve({ code: error === null ? 0 : 1, out: stdout });
        },
      );
    });
  }

  async function setUp(): Promise<{ target: string; staging: string; next: string }> {
    root = mkdtempSync(path.join(os.tmpdir(), 'piarc swap 更新 '));
    await mkdir(path.join(root, 'bin'));
    await writeFile(
      path.join(root, 'bin', 'open'),
      `#!/bin/sh\necho "$1" >> "${path.join(root, 'opened')}"\n`,
      { mode: 0o755 },
    );
    await writeFile(path.join(root, 'swap.sh'), SWAP_SCRIPT);
    const target = path.join(root, 'Applications', 'PiArc.app');
    const staging = stagingDir(target, '1.1.0');
    const next = path.join(staging, 'PiArc.app');
    await app(target, 'old');
    await app(next, 'new');
    return { target, staging, next };
  }

  it('replaces the bundle, opens it and cleans up', async () => {
    const { target, staging, next } = await setUp();
    const result = await runScript([String(await exitedPid()), next, target, staging]);
    expect(result.code).toBe(0);
    expect(readFileSync(path.join(target, 'Contents', 'marker'), 'utf8')).toBe('new');
    expect(existsSync(`${target}.piarc-old`)).toBe(false);
    expect(existsSync(staging)).toBe(false);
    expect(readFileSync(path.join(root, 'opened'), 'utf8').trim()).toBe(target);
  });

  it('puts the installed bundle back when the new one cannot move in', async () => {
    const { target, staging } = await setUp();
    const missing = path.join(staging, 'Missing.app');
    const result = await runScript([String(await exitedPid()), missing, target, staging]);
    expect(result.code).toBe(1);
    expect(readFileSync(path.join(target, 'Contents', 'marker'), 'utf8')).toBe('old');
    expect(existsSync(`${target}.piarc-old`)).toBe(false);
    expect(readFileSync(path.join(root, 'opened'), 'utf8').trim()).toBe(target);
  });
});
