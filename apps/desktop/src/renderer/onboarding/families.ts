// The quick-setup tiles of the first-run guide (ADR-0110): each tile is a provider family,
// and a family's region or plan variants are Pi's separate built-in provider ids. The table
// only names ids; which of them exist comes from Core's `builtinProviders` at run time, so a
// variant Pi dropped is hidden and a family with none left is not shown.
import type { ProviderSettings } from '../settings/provider-form.js';

/** Where a variant serves: mainland China, outside it, or one endpoint for everyone. */
export type Region = 'cn' | 'intl' | 'global';

export interface Variant {
  /** Pi's built-in provider id. */
  readonly id: string;
  readonly region: Region;
}

export const FAMILY_IDS = [
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
] as const;
export type FamilyId = (typeof FAMILY_IDS)[number];

export interface Family {
  readonly id: FamilyId;
  /** The provider id whose brand mark the tile shows. */
  readonly mark: string;
  readonly variants: readonly Variant[];
  /** A sign-in (`loginProviders` id) offered under the key field, when Pi lists it. */
  readonly login?: string;
  /** Mostly used outside China: listed first in English. */
  readonly abroad: boolean;
}

/** In the order Chinese-language users see them. */
export const FAMILIES: readonly Family[] = [
  {
    id: 'deepseek',
    mark: 'deepseek',
    abroad: false,
    variants: [{ id: 'deepseek', region: 'global' }],
  },
  {
    id: 'glm',
    mark: 'zai-coding-cn',
    abroad: false,
    variants: [
      { id: 'zai-coding-cn', region: 'cn' },
      { id: 'zai', region: 'intl' },
    ],
  },
  {
    id: 'kimi',
    mark: 'kimi',
    abroad: false,
    login: 'kimi-coding',
    variants: [
      { id: 'moonshotai-cn', region: 'cn' },
      { id: 'moonshotai', region: 'intl' },
      { id: 'kimi-coding', region: 'global' },
    ],
  },
  {
    id: 'qwen',
    mark: 'qwen',
    abroad: false,
    variants: [
      { id: 'qwen-token-plan-individual-cn', region: 'cn' },
      { id: 'qwen-token-plan-cn', region: 'cn' },
      { id: 'qwen-token-plan-individual', region: 'intl' },
      { id: 'qwen-token-plan', region: 'intl' },
    ],
  },
  {
    id: 'minimax',
    mark: 'minimax',
    abroad: false,
    variants: [
      { id: 'minimax-cn', region: 'cn' },
      { id: 'minimax', region: 'intl' },
    ],
  },
  {
    id: 'mimo',
    mark: 'xiaomi',
    abroad: false,
    variants: [
      { id: 'xiaomi', region: 'global' },
      { id: 'xiaomi-token-plan-cn', region: 'cn' },
      { id: 'xiaomi-token-plan-sgp', region: 'intl' },
      { id: 'xiaomi-token-plan-ams', region: 'intl' },
    ],
  },
  {
    id: 'openai',
    mark: 'openai',
    abroad: true,
    login: 'openai-codex',
    variants: [{ id: 'openai', region: 'global' }],
  },
  {
    id: 'anthropic',
    mark: 'anthropic',
    abroad: true,
    variants: [{ id: 'anthropic', region: 'global' }],
  },
  { id: 'gemini', mark: 'google', abroad: true, variants: [{ id: 'google', region: 'global' }] },
  {
    id: 'openrouter',
    mark: 'openrouter',
    abroad: true,
    login: 'openrouter',
    variants: [{ id: 'openrouter', region: 'global' }],
  },
];

/** Whether the interface language is Chinese (the families used in China come first). */
export function chineseFirst(locale: string): boolean {
  return locale.toLowerCase().startsWith('zh');
}

/**
 * The families to show: variants Core does not list are dropped, families without any are
 * left out; in English the families mostly used abroad come first.
 */
export function availableFamilies(builtin: readonly string[], locale: string): Family[] {
  const known = new Set(builtin);
  const shown = FAMILIES.map((family) => ({
    ...family,
    variants: family.variants.filter((variant) => known.has(variant.id)),
  })).filter((family) => family.variants.length > 0);
  if (chineseFirst(locale)) return shown;
  return [...shown.filter((f) => f.abroad), ...shown.filter((f) => !f.abroad)];
}

/** The variant picked first: mainland China in Chinese, otherwise abroad or global. */
export function defaultVariant(family: Family, locale: string): Variant | undefined {
  const wanted: readonly Region[] = chineseFirst(locale) ? ['cn'] : ['intl', 'global'];
  return family.variants.find((v) => wanted.includes(v.region)) ?? family.variants[0];
}

/** Whether `id` already has a saved credential or a signed-in account. */
export function isConnected(settings: ProviderSettings, id: string): boolean {
  return (
    settings.providers.some((p) => p.id === id && p.hasCredential) ||
    settings.loginProviders.some((p) => p.id === id && p.signedIn)
  );
}

/** Whether any variant of `family` (or its sign-in) is connected. */
export function familyConnected(settings: ProviderSettings, family: Family): boolean {
  return (
    family.variants.some((v) => isConnected(settings, v.id)) ||
    (family.login !== undefined && isConnected(settings, family.login))
  );
}
