import { describe, expect, it } from 'vitest';

import { Translator } from '../../shared/i18n/index.js';
import { confirmationText, installInput, listedPackage, NativeConfirm } from './plugins-ipc.js';

const list = JSON.stringify({
  packages: [
    {
      id: 'demo',
      kind: 'claudePlugin',
      source: { kind: 'git', location: 'https://example.com/demo.git', commit: 'abc123' },
      path: '/data/pi/git/example.com/demo',
      enabled: false,
      active: false,
      components: { commands: ['demo:hello'], hooks: ['Stop'] },
      executables: [
        { kind: 'hook', name: 'Stop[*] echo done', confirmed: true },
        { kind: 'piExtension', name: 'ext/index.ts', confirmed: false },
      ],
      installedAt: 1,
      updatedAt: 1,
    },
  ],
});

describe('extension package IPC', () => {
  it('checks install requests', () => {
    expect(installInput({ kind: 'npm', location: ' pkg@1.0.0 ', scope: 'user' })).toEqual({
      kind: 'npm',
      location: 'pkg@1.0.0',
      scope: 'user',
    });
    expect(() =>
      installInput({ kind: 'directory', location: 'relative', scope: 'user' }),
    ).toThrow();
    expect(() => installInput({ kind: 'git', location: 'a\nb', scope: 'user' })).toThrow();
    expect(() => installInput({ kind: 'npm', location: 'x', scope: 'project' })).toThrow(
      'needs a workspace',
    );
    expect(() => installInput({ kind: 'svn', location: 'x', scope: 'user' })).toThrow();
  });

  it('lists the source and every executable item, with the extension note', () => {
    const pkg = listedPackage(list, 'demo');
    expect(pkg).toBeDefined();
    if (pkg === undefined) return;
    const t = new Translator('en');
    const text = confirmationText(t, pkg, pkg.executables, 'plugins.confirmEnable');
    expect(text.message).toBe('Turn on demo?');
    expect(text.detail).toContain('Git repository: https://example.com/demo.git');
    expect(text.detail).toContain('Commit abc123');
    expect(text.detail).toContain('• Stop[*] echo done');
    expect(text.detail).toContain('• ext/index.ts');
    expect(text.detail).toContain('same permissions as the agent');
    const none = confirmationText(t, pkg, [], 'plugins.confirmEnable');
    expect(none.detail).toContain('commands: demo:hello');
    expect(listedPackage(list, 'other')).toBeUndefined();
  });

  it('names the npm package, its type, registry, scripts, unsupported parts and scope (M-18)', () => {
    const market = JSON.stringify({
      packages: [
        {
          id: 'pi-tools',
          kind: 'piPackage',
          unsupported: ['themes'],
          source: {
            kind: 'npm',
            location: 'https://registry.npmjs.org/pi-tools',
            version: '1.2.0',
            integrity: 'sha512-abc',
            npmName: 'pi-tools',
            installScripts: ['postinstall'],
          },
          components: {},
          executables: [{ kind: 'piExtension', name: 'index.ts', confirmed: false }],
        },
        {
          id: 'other-id',
          kind: 'claudePlugin',
          source: { kind: 'npm', location: 'some-npm', npmName: 'some-npm' },
          components: {},
          executables: [],
        },
      ],
    });
    const t = new Translator('en');
    const pkg = listedPackage(market, 'pi-tools');
    if (pkg === undefined) throw new Error('listed');
    const { detail } = confirmationText(t, pkg, pkg.executables, 'plugins.confirmEnable', 'user');
    for (const line of [
      'Pi package',
      'npm package pi-tools',
      'Registry registry.npmjs.org',
      'Version 1.2.0',
      'Integrity sha512-abc',
      'Declares install scripts (postinstall); PiArc never runs them',
      'Not supported: themes',
      'Every workspace',
      '• index.ts',
    ]) {
      expect(detail).toContain(line);
    }
    const other = listedPackage(market, 'other-id');
    if (other === undefined) throw new Error('listed');
    expect(confirmationText(t, other, [], 'plugins.confirmEnable', 'project').detail).toContain(
      'Warning: the npm package some-npm names itself other-id',
    );
  });

  it('answers planned confirmations and records them', async () => {
    const confirm = new NativeConfirm();
    confirm.answerNext(false);
    confirm.answerNext(true);
    const text = { message: 'm', detail: 'd' };
    expect(await confirm.ask(null, text, ['OK', 'Cancel'])).toBe(false);
    expect(await confirm.ask(null, text, ['OK', 'Cancel'])).toBe(true);
    expect(confirm.shown()).toEqual([text, text]);
  });
});
