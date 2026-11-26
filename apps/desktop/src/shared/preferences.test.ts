import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PREFERENCES,
  isBranchPrefix,
  pointerOf,
  preferencesFrom,
  proxyUrlProblem,
} from './preferences.js';

describe('preferences', () => {
  it('reads valid values and falls back to defaults', () => {
    expect(preferencesFrom(undefined)).toEqual(DEFAULT_PREFERENCES);
    const prefs = preferencesFrom({
      language: 'zh-CN',
      appearance: { theme: 'dark', contrast: 'weird', density: 'compact' },
      keybindings: {
        'session.new': 'Mod+Shift+N',
        'not.a.command': 'Mod+K',
        'session.close': 'bad',
      },
      notifications: { enabled: false },
      memory: { readBoth: true },
      permissions: { allow: ['Bash'] },
    });
    expect(prefs.language).toBe('zh-CN');
    expect(prefs.appearance).toEqual({
      theme: 'dark',
      contrast: 'system',
      density: 'compact',
      reduceMotion: 'system',
    });
    expect(prefs.keybindings).toEqual({ 'session.new': 'Mod+Shift+N' });
    expect(prefs.notifications.enabled).toBe(false);
    expect(prefs.memory.readBoth).toBe(true);
    expect(preferencesFrom({ memory: { readBoth: 'true' } }).memory.readBoth).toBe(false);
    expect(
      preferencesFrom({ permissions: { enableBypassPermissions: true } }).permissions
        .enableBypassPermissions,
    ).toBe(true);
    expect(
      preferencesFrom({ permissions: { enableBypassPermissions: 'yes' } }).permissions
        .enableBypassPermissions,
    ).toBe(false);
    expect(pointerOf({ key: 'permissions.enableBypassPermissions', value: true })).toEqual({
      pointer: '/permissions/enableBypassPermissions',
      value: true,
    });
    expect(pointerOf({ key: 'permissions.enableBypassPermissions', value: 'on' })).toBe(undefined);
  });

  it('reads and writes Auto review settings (T46)', () => {
    const prefs = preferencesFrom({
      permissions: { enableAutoMode: true },
      autoMode: {
        model: 'anthropic/claude-haiku-4-5',
        environment: ['$defaults', 'github.com/acme', 7],
        hard_deny: ['Touching billing'],
      },
    });
    expect(prefs.permissions.enableAutoMode).toBe(true);
    expect(prefs.autoMode).toEqual({
      model: 'anthropic/claude-haiku-4-5',
      lists: {
        environment: ['github.com/acme'],
        allow: [],
        soft_deny: [],
        hard_deny: ['Touching billing'],
      },
    });
    // An alias or a bare id is not a reviewer reference.
    expect(preferencesFrom({ autoMode: { model: 'fast' } }).autoMode.model).toBe('');
    expect(pointerOf({ key: 'permissions.enableAutoMode', value: true })).toEqual({
      pointer: '/permissions/enableAutoMode',
      value: true,
    });
    expect(pointerOf({ key: 'autoMode.model', value: 'p/m' })).toEqual({
      pointer: '/autoMode/model',
      value: 'p/m',
    });
    expect(pointerOf({ key: 'autoMode.model', value: null })).toEqual({
      pointer: '/autoMode/model',
      value: null,
    });
    for (const bad of ['fast', 'p/', '/m', 'p/m n', 7]) {
      expect(pointerOf({ key: 'autoMode.model', value: bad })).toBe(undefined);
    }
    expect(pointerOf({ key: 'autoMode.list', list: 'soft_deny', value: [' Deploys '] })).toEqual({
      pointer: '/autoMode/soft_deny',
      value: ['Deploys'],
    });
    for (const change of [
      { key: 'autoMode.list', list: 'model', value: [] },
      { key: 'autoMode.list', list: 'allow', value: [''] },
      { key: 'autoMode.list', list: 'allow', value: ['x'.repeat(501)] },
      { key: 'autoMode.list', list: 'allow', value: Array.from({ length: 101 }, () => 'x') },
      { key: 'autoMode.list', list: 'allow', value: 'x' },
    ]) {
      expect(pointerOf(change)).toBe(undefined);
    }
  });

  it('maps only valid changes to settings pointers', () => {
    expect(pointerOf({ key: 'language', value: 'en' })).toEqual({
      pointer: '/language',
      value: 'en',
    });
    expect(pointerOf({ key: 'memory.readBoth', value: false })).toEqual({
      pointer: '/memory/readBoth',
      value: false,
    });
    expect(pointerOf({ key: 'keybinding', command: 'session.new', value: null })).toEqual({
      pointer: '/keybindings/session.new',
      value: null,
    });
    for (const bad of [
      { key: 'language', value: 'fr' },
      { key: 'keybinding', command: '../permissions', value: 'Mod+N' },
      { key: 'keybinding', command: 'session.new', value: 'Hyper+N' },
      { key: 'permissions.allow', value: ['Bash'] },
      { key: 'memory.readBoth', value: 1 },
      { key: 'memory.other', value: true },
      'language',
    ]) {
      expect(pointerOf(bad)).toBeUndefined();
    }
  });
});

describe('the proxy preference (ADR-0082)', () => {
  it('reads auto by default and a manual address as written', () => {
    expect(preferencesFrom({}).proxy).toEqual({ mode: 'auto', url: '' });
    expect(
      preferencesFrom({ proxy: { mode: 'manual', url: 'http://127.0.0.1:7897' } }).proxy,
    ).toEqual({
      mode: 'manual',
      url: 'http://127.0.0.1:7897',
    });
    expect(preferencesFrom({ proxy: { mode: 'pac' } }).proxy.mode).toBe('auto');
  });

  it('accepts a host and port, like Core, and says what is wrong otherwise', () => {
    expect(proxyUrlProblem('http://127.0.0.1:7897')).toBeUndefined();
    expect(proxyUrlProblem(' https://proxy.example.com/ ')).toBeUndefined();
    expect(proxyUrlProblem('http://[::1]:8080')).toBeUndefined();
    expect(proxyUrlProblem('socks5://127.0.0.1:1080')).toBe('scheme');
    expect(proxyUrlProblem('127.0.0.1:7897')).toBe('scheme');
    expect(proxyUrlProblem('http://user:secret@host:1')).toBe('credentials');
    expect(proxyUrlProblem('http://host:1/pac')).toBe('path');
    expect(proxyUrlProblem('http://host:0')).toBe('port');
    expect(proxyUrlProblem('http://host:70000')).toBe('port');
    expect(proxyUrlProblem('http://:1')).toBe('host');
  });

  it('writes a manual address or the return to auto, and nothing else', () => {
    expect(
      pointerOf({ key: 'proxy', value: { mode: 'manual', url: ' http://127.0.0.1:7897 ' } }),
    ).toEqual({
      pointer: '/proxy',
      value: { mode: 'manual', url: 'http://127.0.0.1:7897' },
    });
    expect(pointerOf({ key: 'proxy', value: { mode: 'auto' } })).toEqual({
      pointer: '/proxy/mode',
      value: 'auto',
    });
    expect(
      pointerOf({ key: 'proxy', value: { mode: 'manual', url: 'http://u:p@h:1' } }),
    ).toBeUndefined();
    expect(pointerOf({ key: 'proxy', value: { mode: 'system' } })).toBeUndefined();
  });
});

describe('the Git preferences (ADR-0085)', () => {
  it('reads the defaults and the values Git accepts', () => {
    expect(preferencesFrom({}).git).toEqual({
      branchPrefix: '',
      protectedBranches: ['main', 'master'],
      pullMode: 'config',
      alwaysForcePush: false,
      commitInstructions: '',
    });
    const git = preferencesFrom({
      git: {
        branchPrefix: 'feature/',
        protectedBranches: ['main', ' release/* ', 'has space', 3],
        pullMode: 'rebase',
        alwaysForcePush: true,
        commitInstructions: 'Be brief.',
      },
    }).git;
    expect(git).toEqual({
      branchPrefix: 'feature/',
      protectedBranches: ['main', 'release/*'],
      pullMode: 'rebase',
      alwaysForcePush: true,
      commitInstructions: 'Be brief.',
    });
    // An empty list is a choice: nothing is protected.
    expect(preferencesFrom({ git: { protectedBranches: [] } }).git.protectedBranches).toEqual([]);
    expect(preferencesFrom({ git: { branchPrefix: 'a b', pullMode: 'squash' } }).git).toMatchObject(
      {
        branchPrefix: '',
        pullMode: 'config',
      },
    );
  });

  it('accepts branch prefixes Git can start a name with', () => {
    for (const ok of ['', 'feature/', 'me-', 'team/me/']) expect(isBranchPrefix(ok)).toBe(true);
    for (const bad of ['-x', '/x', 'a..b', 'a//b', 'a b', 'a~', 'a:b', 'a\\b', 'x'.repeat(65)]) {
      expect(isBranchPrefix(bad)).toBe(false);
    }
  });

  it('writes Git settings to their pointers and removes defaults', () => {
    expect(pointerOf({ key: 'git.branchPrefix', value: 'feature/' })).toEqual({
      pointer: '/git/branchPrefix',
      value: 'feature/',
    });
    expect(pointerOf({ key: 'git.branchPrefix', value: '' })).toEqual({
      pointer: '/git/branchPrefix',
      value: null,
    });
    expect(pointerOf({ key: 'git.branchPrefix', value: '-bad' })).toBeUndefined();
    expect(pointerOf({ key: 'git.protectedBranches', value: ['main', ' main ', 'rel/*'] })).toEqual(
      {
        pointer: '/git/protectedBranches',
        value: ['main', 'rel/*'],
      },
    );
    expect(pointerOf({ key: 'git.protectedBranches', value: null })).toEqual({
      pointer: '/git/protectedBranches',
      value: null,
    });
    expect(pointerOf({ key: 'git.protectedBranches', value: ['a b'] })).toBeUndefined();
    expect(
      pointerOf({
        key: 'git.protectedBranches',
        value: Array.from({ length: 33 }, (_, i) => `b${String(i)}`),
      }),
    ).toBeUndefined();
    expect(pointerOf({ key: 'git.pullMode', value: 'ffOnly' })).toEqual({
      pointer: '/git/pullMode',
      value: 'ffOnly',
    });
    expect(pointerOf({ key: 'git.pullMode', value: 'config' })).toEqual({
      pointer: '/git/pullMode',
      value: null,
    });
    expect(pointerOf({ key: 'git.pullMode', value: 'squash' })).toBeUndefined();
    expect(pointerOf({ key: 'git.alwaysForcePush', value: true })).toEqual({
      pointer: '/git/alwaysForcePush',
      value: true,
    });
    expect(pointerOf({ key: 'git.alwaysForcePush', value: false })).toEqual({
      pointer: '/git/alwaysForcePush',
      value: null,
    });
    expect(pointerOf({ key: 'git.alwaysForcePush', value: 'yes' })).toBeUndefined();
    expect(pointerOf({ key: 'git.commitInstructions', value: '  ' })).toEqual({
      pointer: '/git/commitInstructions',
      value: null,
    });
    expect(
      pointerOf({ key: 'git.commitInstructions', value: 'x'.repeat(8 * 1024 + 1) }),
    ).toBeUndefined();
  });
});
