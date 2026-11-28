// T13-A02 (main process): the data and cache directories of architecture section 9.1 on both
// platforms, and that they are applied before `ready`.
import { describe, expect, it } from 'vitest';

import { applyDataDirs, resolveDataDirs, type PathApp } from './data-dirs.js';

describe('resolveDataDirs', () => {
  it('uses Application Support and Caches on macOS', () => {
    expect(
      resolveDataDirs({
        platform: 'darwin',
        home: '/Users/测试 用户',
        localAppData: undefined,
        userDataOverride: undefined,
      }),
    ).toEqual({
      data: '/Users/测试 用户/Library/Application Support/PiArc',
      cache: '/Users/测试 用户/Library/Caches/PiArc',
      sessionData: '/Users/测试 用户/Library/Caches/PiArc/Chromium',
    });
  });

  it('uses LOCALAPPDATA, not the roaming APPDATA, on Windows', () => {
    expect(
      resolveDataDirs({
        platform: 'win32',
        home: 'C:\\Users\\测试 用户',
        localAppData: 'C:\\Users\\测试 用户\\AppData\\Local',
        userDataOverride: undefined,
      }),
    ).toEqual({
      data: 'C:\\Users\\测试 用户\\AppData\\Local\\PiArc',
      cache: 'C:\\Users\\测试 用户\\AppData\\Local\\PiArc\\Cache',
      sessionData: 'C:\\Users\\测试 用户\\AppData\\Local\\PiArc\\Cache\\Chromium',
    });
    // Without the variable, the default location under the profile.
    expect(
      resolveDataDirs({
        platform: 'win32',
        home: 'C:\\Users\\dev',
        localAppData: '',
        userDataOverride: undefined,
      }).data,
    ).toBe('C:\\Users\\dev\\AppData\\Local\\PiArc');
  });

  it('puts everything under --user-data-dir when it is given', () => {
    expect(
      resolveDataDirs({
        platform: 'darwin',
        home: '/Users/dev',
        localAppData: undefined,
        userDataOverride: '/tmp/piarc l4 中文',
      }),
    ).toEqual({
      data: '/tmp/piarc l4 中文',
      cache: '/tmp/piarc l4 中文/Cache',
      sessionData: '/tmp/piarc l4 中文/Cache/Chromium',
    });
    expect(
      resolveDataDirs({
        platform: 'win32',
        home: 'C:\\Users\\dev',
        localAppData: 'C:\\Users\\dev\\AppData\\Local',
        userDataOverride: 'D:\\profiles\\a b',
      }).cache,
    ).toBe('D:\\profiles\\a b\\Cache');
  });
});

function fakeApp(ready: boolean, userDataDir = ''): { app: PathApp; set: [string, string][] } {
  const set: [string, string][] = [];
  return {
    set,
    app: {
      isReady: () => ready,
      getPath: () => '/Users/dev',
      setPath: (name, value) => set.push([name, value]),
      commandLine: { getSwitchValue: (name) => (name === 'user-data-dir' ? userDataDir : '') },
    },
  };
}

describe('applyDataDirs', () => {
  it('sets userData and sessionData before ready', () => {
    const { app, set } = fakeApp(false);
    const dirs = applyDataDirs(app, {}, 'darwin');
    expect(set).toEqual([
      ['userData', '/Users/dev/Library/Application Support/PiArc'],
      ['sessionData', '/Users/dev/Library/Caches/PiArc/Chromium'],
    ]);
    expect(dirs.cache).toBe('/Users/dev/Library/Caches/PiArc');
  });

  it('honours --user-data-dir', () => {
    const { app, set } = fakeApp(false, '/tmp/profile');
    applyDataDirs(app, {}, 'darwin');
    expect(set[0]).toEqual(['userData', '/tmp/profile']);
  });

  it('refuses to run once the app is ready', () => {
    const { app, set } = fakeApp(true);
    expect(() => applyDataDirs(app, {}, 'darwin')).toThrow('before the app is ready');
    expect(set).toEqual([]);
  });
});
