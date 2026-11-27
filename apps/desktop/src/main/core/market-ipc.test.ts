import { describe, expect, it } from 'vitest';

import { exactVersion, marketInstall, marketQuery, npmName } from './market-ipc.js';

describe('market IPC (ADR-0102)', () => {
  it('accepts npm names and exact versions only', () => {
    for (const ok of ['pi-tools', '@scope/pi-tools', 'a.b', 'x~y']) {
      expect(npmName(ok)).toBe(ok);
    }
    for (const bad of [
      '',
      'Pi',
      '_x',
      '.x',
      '../x',
      '@s',
      '@s/a/b',
      'a b',
      'https://x.test/a.tgz',
      'git+ssh://git@x/y',
      'file:../x',
      'x@npm:y',
      'a'.repeat(215),
      7,
    ]) {
      expect(() => npmName(bad), String(bad)).toThrow(TypeError);
    }
    expect(exactVersion('1.2.3-beta.1+b')).toBe('1.2.3-beta.1+b');
    for (const bad of ['', '^1.2.3', 'latest', '1.2', '01.2.3', '1.2.3 ', '>=1', null]) {
      expect(() => exactVersion(bad), String(bad)).toThrow(TypeError);
    }
  });

  it('checks queries', () => {
    expect(marketQuery({ limit: 50 })).toEqual({
      query: '',
      category: 'all',
      sort: 'popular',
      offset: 0,
      limit: 50,
      workspace: null,
    });
    for (const bad of [
      null,
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: 10, offset: -1 },
      { limit: 10, offset: 20001 },
      { limit: 10, category: 'theme' },
      { limit: 10, sort: 'name' },
      { limit: 10, query: 'x'.repeat(201) },
      { limit: 10, query: 'a\u0000b' },
      { limit: 10, workspace: 'relative/path' },
    ]) {
      expect(() => marketQuery(bad), JSON.stringify(bad)).toThrow(TypeError);
    }
  });

  it('builds install requests from a name, a version and a scope, never a location', () => {
    expect(
      marketInstall({ name: 'pi-x', version: '1.0.0', scope: 'user', location: '/etc' }),
    ).toEqual({ name: 'pi-x', version: '1.0.0', scope: 'user', workspace: null });
    expect(() => marketInstall({ name: 'pi-x', version: '1.0.0', scope: 'project' })).toThrow(
      TypeError,
    );
    expect(() => marketInstall({ name: 'pi-x', version: '1.0.0', scope: 'global' })).toThrow(
      TypeError,
    );
  });
});
