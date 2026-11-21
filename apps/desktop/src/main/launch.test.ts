import { describe, expect, it } from 'vitest';

import { launchTargets, leadingArguments, parseLaunchUrl } from './launch.js';

describe('piarc:// links', () => {
  it('open a folder or show a session', () => {
    expect(parseLaunchUrl('piarc://open?path=%2Fwork%2F%E9%A1%B9%E7%9B%AE%20one')).toEqual({
      kind: 'workspace',
      path: '/work/项目 one',
    });
    expect(parseLaunchUrl('piarc://open?path=C%3A%5Cwork%5Crepo')).toEqual({
      kind: 'workspace',
      path: 'C:\\work\\repo',
    });
    expect(parseLaunchUrl('piarc://session/0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d')).toEqual({
      kind: 'session',
      sessionId: '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
    });
  });

  it('carry nothing that runs', () => {
    // A prompt or a command in the link is ignored; only the folder is taken.
    expect(parseLaunchUrl('piarc://open?path=%2Fw&prompt=rm%20-rf&run=1')).toEqual({
      kind: 'workspace',
      path: '/w',
    });
    for (const link of [
      'piarc://run?command=ls',
      'piarc://prompt?text=hello',
      'piarc://open?path=relative/dir',
      'piarc://open',
      'piarc://open?path=%2Fw%00x',
      'piarc://session/..%2F..%2Fetc',
      'piarc://session/a%20b',
      'piarc://oauth/callback?code=x',
      'https://open?path=%2Fw',
      'not a url',
    ]) {
      expect(parseLaunchUrl(link), link).toBeUndefined();
    }
  });
});

describe('command lines', () => {
  it('take links and folders after the leading arguments, ignoring switches', () => {
    const argv = [
      '/Applications/PiArc.app/Contents/MacOS/PiArc',
      '--user-data-dir=/tmp/x',
      'piarc://session/abc',
      'repo 仓库',
      '/abs/dir',
      '',
    ];
    expect(launchTargets(argv, leadingArguments(false), '/home/me')).toEqual([
      { kind: 'session', sessionId: 'abc' },
      { kind: 'workspace', path: '/home/me/repo 仓库' },
      { kind: 'workspace', path: '/abs/dir' },
    ]);
  });

  it('skip the app path when started as `electron <app>`', () => {
    expect(
      launchTargets(['electron', '.', 'piarc://session/s1'], leadingArguments(true), '/x'),
    ).toEqual([{ kind: 'session', sessionId: 's1' }]);
  });

  it('accept the Windows shell verb argument', () => {
    expect(launchTargets(['C:\\PiArc\\PiArc.exe', 'D:\\work\\repo'], 1, 'C:\\')).toEqual([
      { kind: 'workspace', path: 'D:\\work\\repo' },
    ]);
  });
});
