import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { copyVelopackRuntime } from './velopack-runtime.mjs';

const repoRoot = path.join(import.meta.dirname, '..', '..', '..');

describe('copyVelopackRuntime', () => {
  it('copies the binding with only the native module of the target architecture', async () => {
    const buildPath = await realpath(await mkdtemp(path.join(os.tmpdir(), 'piarc velopack-')));
    try {
      await copyVelopackRuntime({ repoRoot, buildPath, arch: 'arm64' });
      const native = path.join(buildPath, 'node_modules', 'velopack', 'lib', 'native');
      expect(readdirSync(native)).toEqual(['velopack_nodeffi_win_arm64_msvc.node']);
      // The copied package resolves its own dependency the way the main process will load it.
      const load = createRequire(path.join(buildPath, 'package.json'));
      expect(path.relative(buildPath, load.resolve('velopack'))).toBe(
        path.join('node_modules', 'velopack', 'lib', 'index.js'),
      );
      expect(existsSync(path.join(buildPath, 'node_modules', '@neon-rs', 'load', 'dist'))).toBe(
        true,
      );
    } finally {
      await rm(buildPath, { recursive: true, force: true });
    }
  });

  it('refuses an architecture without a binding', async () => {
    await expect(
      copyVelopackRuntime({ repoRoot, buildPath: '/nonexistent', arch: 'ia32' }),
    ).rejects.toThrow('no Velopack binding');
  });
});
