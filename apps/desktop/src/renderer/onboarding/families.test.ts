import { describe, expect, it } from 'vitest';

import type { ProviderSettings } from '../settings/provider-form.js';
import {
  FAMILIES,
  availableFamilies,
  defaultVariant,
  familyConnected,
  isConnected,
  type Family,
} from './families.js';

// Pi 1.5.2's built-in API-key providers (`builtinProviders`); openai-codex signs in only.
const PI_BUILTIN = [
  'amazon-bedrock',
  'ant-ling',
  'anthropic',
  'azure',
  'deepseek',
  'google',
  'google-vertex',
  'kimi-coding',
  'minimax',
  'minimax-cn',
  'moonshotai',
  'moonshotai-cn',
  'openai',
  'openrouter',
  'qwen-token-plan',
  'qwen-token-plan-cn',
  'qwen-token-plan-individual',
  'qwen-token-plan-individual-cn',
  'xai',
  'xiaomi',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
  'zai',
  'zai-coding-cn',
];

function family(id: Family['id'], list = availableFamilies(PI_BUILTIN, 'zh-CN')): Family {
  const found = list.find((f) => f.id === id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
}

function settings(partial: Partial<ProviderSettings>): ProviderSettings {
  return {
    providers: [],
    builtinProviders: [],
    catalogRefresh: false,
    loginProviders: [],
    catalogModels: [],
    models: {},
    auxiliary: null,
    auxiliaryAlias: null,
    aliases: {},
    disabled: [],
    accounts: [],
    ...partial,
  };
}

describe('provider families', () => {
  it('lists every variant of Pi’s catalog once, and sign-in-only providers never as a key', () => {
    const ids = FAMILIES.flatMap((f) => f.variants.map((v) => v.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('openai-codex');
    for (const id of ids) expect(PI_BUILTIN).toContain(id);
    expect(family('kimi').variants.map((v) => v.id)).toEqual([
      'moonshotai-cn',
      'moonshotai',
      'kimi-coding',
    ]);
    expect(family('qwen').variants).toHaveLength(4);
    expect(family('mimo').variants).toHaveLength(4);
    expect(family('openai').login).toBe('openai-codex');
  });

  it('hides variants the catalog lacks and families with none left', () => {
    const list = availableFamilies(['deepseek', 'zai', 'openai'], 'zh-CN');
    expect(list.map((f) => f.id)).toEqual(['deepseek', 'glm', 'openai']);
    expect(family('glm', list).variants.map((v) => v.id)).toEqual(['zai']);
  });

  it('puts the families used abroad first in English', () => {
    expect(availableFamilies(PI_BUILTIN, 'zh-CN').map((f) => f.id)).toEqual([
      'deepseek',
      'glm',
      'kimi',
      'qwen',
      'minimax',
      'mimo',
      'openai',
      'anthropic',
      'gemini',
      'openrouter',
    ]);
    expect(availableFamilies(PI_BUILTIN, 'en').map((f) => f.id)).toEqual([
      'openai',
      'anthropic',
      'gemini',
      'openrouter',
      'deepseek',
      'glm',
      'kimi',
      'qwen',
      'minimax',
      'mimo',
    ]);
  });

  it('picks the mainland variant in Chinese and the international one in English', () => {
    expect(defaultVariant(family('glm'), 'zh-CN')?.id).toBe('zai-coding-cn');
    expect(defaultVariant(family('glm'), 'en')?.id).toBe('zai');
    expect(defaultVariant(family('kimi'), 'zh-CN')?.id).toBe('moonshotai-cn');
    expect(defaultVariant(family('kimi'), 'en')?.id).toBe('moonshotai');
    expect(defaultVariant(family('mimo'), 'zh-CN')?.id).toBe('xiaomi-token-plan-cn');
    expect(defaultVariant(family('mimo'), 'en')?.id).toBe('xiaomi');
    expect(defaultVariant(family('deepseek'), 'zh-CN')?.id).toBe('deepseek');
  });

  it('marks a family connected by a saved key or its sign-in', () => {
    const keyed = settings({
      providers: [{ id: 'minimax-cn', kind: 'builtin', hasCredential: true }],
    });
    expect(isConnected(keyed, 'minimax-cn')).toBe(true);
    expect(familyConnected(keyed, family('minimax'))).toBe(true);
    expect(familyConnected(keyed, family('kimi'))).toBe(false);
    const signedIn = settings({
      loginProviders: [
        {
          id: 'openai-codex',
          name: 'ChatGPT',
          label: 'ChatGPT',
          subscription: true,
          signedIn: true,
        },
      ],
    });
    expect(familyConnected(signedIn, family('openai'))).toBe(true);
    const unkeyed = settings({
      providers: [{ id: 'deepseek', kind: 'builtin', hasCredential: false }],
    });
    expect(isConnected(unkeyed, 'deepseek')).toBe(false);
  });
});
