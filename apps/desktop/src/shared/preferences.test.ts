import { describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES, pointerOf, preferencesFrom } from './preferences.js';

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
