import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORE_TARGETS, coreBinaryName, coreBuildDir } from '../../apps/desktop/core-binary.mjs';
import { DECLARATION_FILES } from './build-core.mjs';

describe('coreBinaryName', () => {
  it('follows the @napi-rs/cli --platform names of the four shipping targets', () => {
    const names = Object.values(CORE_TARGETS).map(({ platform, arch }) =>
      coreBinaryName(platform, arch),
    );
    expect(names).toEqual([
      'piarc-core.darwin-arm64.node',
      'piarc-core.darwin-x64.node',
      'piarc-core.win32-x64-msvc.node',
      'piarc-core.win32-arm64-msvc.node',
    ]);
  });

  it('rejects platforms and architectures Core is not built for', () => {
    expect(() => coreBinaryName('linux', 'x64')).toThrow(/platform linux/);
    expect(() => coreBinaryName('darwin', 'ia32')).toThrow(/architecture ia32/);
  });
});

describe('build layout', () => {
  it('keeps each flavor in its own directory under target/', () => {
    const root = path.join('repo dir', '仓库');
    expect(coreBuildDir(root, 'development')).toBe(
      path.join(root, 'target', 'piarc-core', 'development'),
    );
    expect(coreBuildDir(root, 'release')).toBe(path.join(root, 'target', 'piarc-core', 'release'));
  });

  it('snapshots the release API and the testing API separately', () => {
    expect(DECLARATION_FILES).toEqual({
      release: 'piarc-core.d.ts',
      development: 'piarc-core.testing.d.ts',
    });
  });
});
