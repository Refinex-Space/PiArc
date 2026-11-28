import type { Api, Model } from '@earendil-works/pi-ai';
import type { CatalogModel } from '@piarc/protocol';
import { describe, expect, it } from 'vitest';

import { ModelPreferencesStore, parsePreferences } from './preferences.js';

const model = {
  provider: 'shop',
  id: 'example',
  contextWindow: 128_000,
  input: ['text', 'image'],
} as unknown as Model<Api>;

const entry: CatalogModel = {
  provider: 'shop',
  id: 'example',
  name: 'Example',
  contextWindow: 128_000,
  maxOutput: 8192,
  vision: true,
  efforts: ['off', 'low', 'high'],
  promptCache: false,
  toolReliability: 'unknown',
};

describe('model preferences (T29)', () => {
  it('apply the per-model settings over the catalog', () => {
    const store = new ModelPreferencesStore();
    expect(store.apply(entry)).toEqual(entry);
    store.set(
      parsePreferences({
        models: {
          'shop/example': {
            displayName: 'Example (work)',
            contextWindow: 64_000,
            vision: false,
            defaultEffort: 'high',
          },
        },
        auxiliary: { provider: 'shop', id: 'small' },
      }),
    );
    expect(store.apply(entry)).toMatchObject({
      name: 'Example (work)',
      contextWindow: 64_000,
      vision: false,
      defaultEffort: 'high',
    });
    expect(store.contextWindow(model)).toBe(64_000);
    expect(store.vision(model)).toBe(false);
    expect(store.auxiliary).toEqual({ provider: 'shop', id: 'small' });
    // An effort the model does not have is not applied.
    store.set(parsePreferences({ models: { 'shop/example': { defaultEffort: 'max' } } }));
    expect(store.defaultEffort(model, entry.efforts)).toBeUndefined();
  });

  it('choose the conservative profile for low reliability unless the user picks the default', () => {
    const store = new ModelPreferencesStore();
    expect(store.profile(model, 'unknown')).toBe('default');
    expect(store.profile(model, 'low')).toBe('conservative');
    store.set(parsePreferences({ models: { 'shop/example': { toolReliability: 'low' } } }));
    expect(store.profile(model, 'verified')).toBe('conservative');
    expect(store.apply(entry)).toMatchObject({
      toolReliability: 'low',
      toolProfile: 'conservative',
    });
    store.set(
      parsePreferences({
        models: { 'shop/example': { toolReliability: 'low', toolProfile: 'default' } },
      }),
    );
    expect(store.profile(model, 'verified')).toBe('default');
    expect(store.apply(entry).toolProfile).toBeUndefined();
  });

  it('reject malformed preferences at the boundary', () => {
    for (const bad of [
      null,
      { models: [] },
      { models: { 'a/b': { contextWindow: -1 } } },
      { models: { 'a/b': { toolProfile: 'strict' } } },
      { models: { 'a/b': { defaultEffort: 'minimal' } } },
      { auxiliary: { provider: 'a' } },
    ]) {
      expect(() => parsePreferences(bad)).toThrow(/Invalid model preferences/u);
    }
  });
});
