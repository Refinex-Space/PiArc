import { describe, expect, it } from 'vitest';

import { PreferenceStore, type SettingsCore } from './preferences.js';

function fakeCore(
  initial: Record<string, unknown>,
): SettingsCore & { file: Record<string, unknown> } {
  const state = { file: initial };
  return {
    get file() {
      return state.file;
    },
    userSettings: () => Promise.resolve(JSON.stringify(state.file)),
    writeClientSetting: (pointer: string, value?: string | null) => {
      const [group, key] = pointer.slice(1).split('/');
      if (group === undefined) {
        return Promise.reject(new Error('bad pointer'));
      }
      const parsed: unknown = value === null || value === undefined ? undefined : JSON.parse(value);
      if (key === undefined) {
        state.file = { ...state.file, [group]: parsed };
      } else {
        const inner = new Map(
          Object.entries((state.file[group] as Record<string, unknown> | undefined) ?? {}),
        );
        if (parsed === undefined) {
          inner.delete(key);
        } else {
          inner.set(key, parsed);
        }
        state.file = { ...state.file, [group]: Object.fromEntries(inner) };
      }
      return Promise.resolve(JSON.stringify(state.file));
    },
  };
}

describe('PreferenceStore', () => {
  it('loads, writes one key through Core and tells listeners', async () => {
    const core = fakeCore({ language: 'zh-CN', shell: { gitBashPath: 'x' } });
    const store = new PreferenceStore(core, () => ['en-US']);
    expect((await store.load()).language).toBe('zh-CN');
    expect(store.locale()).toBe('zh-CN');
    const seen: string[] = [];
    store.onChange((p) => seen.push(p.keybindings['session.new'] ?? 'default'));
    await store.set({ key: 'keybinding', command: 'session.new', value: 'Mod+Shift+N' });
    expect(core.file.keybindings).toEqual({ 'session.new': 'Mod+Shift+N' });
    await store.set({ key: 'keybinding', command: 'session.new', value: null });
    expect(seen).toEqual(['Mod+Shift+N', 'default']);
    await expect(store.set({ key: 'permissions', value: [] })).rejects.toThrow(TypeError);
  });

  it('falls back to the defaults when the file cannot be read', async () => {
    const store = new PreferenceStore(
      {
        userSettings: () => Promise.reject(new Error('not an object')),
        writeClientSetting: () => Promise.resolve('{}'),
      },
      () => ['zh-Hans'],
    );
    expect((await store.load()).language).toBe('system');
    expect(store.locale()).toBe('zh-CN');
  });
});
