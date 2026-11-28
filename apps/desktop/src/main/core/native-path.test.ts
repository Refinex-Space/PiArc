import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { coreModuleName, resolveCoreModulePath } from './native-path.js';

describe('coreModuleName', () => {
  it('uses the @napi-rs/cli --platform names of the four shipping targets', () => {
    expect(coreModuleName('darwin', 'arm64')).toBe('piarc-core.darwin-arm64.node');
    expect(coreModuleName('darwin', 'x64')).toBe('piarc-core.darwin-x64.node');
    expect(coreModuleName('win32', 'x64')).toBe('piarc-core.win32-x64-msvc.node');
    expect(coreModuleName('win32', 'arm64')).toBe('piarc-core.win32-arm64-msvc.node');
  });

  it('rejects a platform or architecture Core is not built for', () => {
    expect(() => coreModuleName('linux', 'x64')).toThrow(/platform linux/);
    expect(() => coreModuleName('win32', 'ia32')).toThrow(/architecture ia32/);
  });
});

describe('resolveCoreModulePath', () => {
  it('loads the development build from target/ when running from the source tree', () => {
    const repo = path.join(path.sep, 'work', 'Pi Arc 仓库');
    expect(
      resolveCoreModulePath({
        isPackaged: false,
        appPath: path.join(repo, 'apps', 'desktop'),
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBe(path.join(repo, 'target', 'piarc-core', 'development', 'piarc-core.darwin-arm64.node'));
  });

  it('loads from app.asar.unpacked next to the archive when packaged', () => {
    const resources = path.join(path.sep, 'Applications', 'PiArc.app', 'Contents', 'Resources');
    expect(
      resolveCoreModulePath({
        isPackaged: true,
        appPath: path.join(resources, 'app.asar'),
        platform: 'darwin',
        arch: 'x64',
      }),
    ).toBe(path.join(resources, 'app.asar.unpacked', 'native', 'piarc-core.darwin-x64.node'));
  });

  it('builds the Windows path with the MSVC suffix', () => {
    const resources = path.join('C:', 'Program Files', 'PiArc', 'resources');
    expect(
      resolveCoreModulePath({
        isPackaged: true,
        appPath: path.join(resources, 'app.asar'),
        platform: 'win32',
        arch: 'arm64',
      }),
    ).toBe(path.join(resources, 'app.asar.unpacked', 'native', 'piarc-core.win32-arm64-msvc.node'));
  });
});
