// Model preferences from Core (T29): the user's per-model settings, which replace catalog values,
// and the auxiliary model for one-off calls. Core sends them in `core/welcome` and again with
// `models/reload` whenever they change.
//
// Where each setting takes effect: the display name in `models/list`; the context window in the
// compaction threshold and the usage ring (`SessionCompaction`); image input in `models/list`
// (the composer refuses images) and the request policy (providers/policy.ts); the default effort
// when the model is selected (session-models.ts); the Tool Profile when a session opens on the
// model (tools/profile.ts).
import type { Api, Model } from '@earendil-works/pi-ai';
import type {
  CatalogModel,
  EffortLevel,
  ModelOverride,
  ModelPreferences,
  ModelRef,
  ToolProfileKind,
  ToolReliability,
} from '@piarc/protocol';

import { AhpError } from '../protocol/errors.js';
import { isObject } from '../runtime/items.js';

const EFFORTS = new Set<string>(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
const PROFILES = new Set<string>(['default', 'conservative']);
const RELIABILITY = new Set<string>(['verified', 'unknown', 'low']);

function fail(member: string): never {
  throw new AhpError('invalidParams', `Invalid model preferences: ${member}`, {
    details: { member },
  });
}

function parseOverride(key: string, value: unknown): ModelOverride {
  if (!isObject(value)) fail(`models.${key}`);
  const out: { -readonly [K in keyof ModelOverride]: ModelOverride[K] } = {};
  const { displayName, contextWindow, vision, defaultEffort, toolProfile, toolReliability } = value;
  if (displayName !== undefined) {
    if (typeof displayName !== 'string' || displayName.trim() === '') fail(`${key}.displayName`);
    out.displayName = displayName;
  }
  if (contextWindow !== undefined) {
    if (
      typeof contextWindow !== 'number' ||
      !Number.isSafeInteger(contextWindow) ||
      contextWindow < 1
    )
      fail(`${key}.contextWindow`);
    out.contextWindow = contextWindow;
  }
  if (vision !== undefined) {
    if (typeof vision !== 'boolean') fail(`${key}.vision`);
    out.vision = vision;
  }
  if (defaultEffort !== undefined) {
    if (typeof defaultEffort !== 'string' || !EFFORTS.has(defaultEffort))
      fail(`${key}.defaultEffort`);
    out.defaultEffort = defaultEffort as EffortLevel;
  }
  if (toolProfile !== undefined) {
    if (typeof toolProfile !== 'string' || !PROFILES.has(toolProfile)) fail(`${key}.toolProfile`);
    out.toolProfile = toolProfile as ToolProfileKind;
  }
  if (toolReliability !== undefined) {
    if (typeof toolReliability !== 'string' || !RELIABILITY.has(toolReliability))
      fail(`${key}.toolReliability`);
    out.toolReliability = toolReliability as ToolReliability;
  }
  return out;
}

/** The preferences in an AHP message (validated at the boundary). */
export function parsePreferences(value: unknown): ModelPreferences {
  if (!isObject(value)) fail('preferences');
  const models: Record<string, ModelOverride> = {};
  if (value.models !== undefined) {
    if (!isObject(value.models)) fail('models');
    for (const [key, entry] of Object.entries(value.models)) {
      models[key] = parseOverride(key, entry);
    }
  }
  let auxiliary: ModelRef | undefined;
  if (value.auxiliary !== undefined) {
    const aux = value.auxiliary;
    if (!isObject(aux) || typeof aux.provider !== 'string' || typeof aux.id !== 'string')
      fail('auxiliary');
    auxiliary = { provider: aux.provider, id: aux.id };
  }
  return { models, ...(auxiliary === undefined ? {} : { auxiliary }) };
}

type ModelKey = Pick<Model<Api>, 'provider' | 'id'>;

/** The current preferences of one Agent Host. */
export class ModelPreferencesStore {
  #prefs: ModelPreferences = { models: {} };

  set(prefs: ModelPreferences): void {
    this.#prefs = prefs;
  }

  /** The auxiliary model the user chose, if any. */
  get auxiliary(): ModelRef | undefined {
    return this.#prefs.auxiliary ?? undefined;
  }

  override(model: ModelKey): ModelOverride | undefined {
    return this.#prefs.models?.[`${model.provider}/${model.id}`];
  }

  /** The context window the threshold and the usage ring measure against. */
  contextWindow(model: Model<Api>): number {
    return this.override(model)?.contextWindow ?? model.contextWindow;
  }

  /** Whether image attachments are accepted. */
  vision(model: Model<Api>): boolean {
    return this.override(model)?.vision ?? model.input.includes('image');
  }

  /** The effort applied when `model` is selected without one, if supported. */
  defaultEffort(model: ModelKey, supported: readonly string[]): EffortLevel | undefined {
    const effort = this.override(model)?.defaultEffort;
    return effort != null && supported.includes(effort) ? effort : undefined;
  }

  /** The Tool Profile of a model with catalog reliability `reliability`: the user's choice, else
   * conservative for low reliability. */
  profile(model: ModelKey | undefined, reliability: ToolReliability): ToolProfileKind {
    if (model === undefined) return 'default';
    const override = this.override(model);
    const effective = override?.toolReliability ?? reliability;
    return override?.toolProfile ?? (effective === 'low' ? 'conservative' : 'default');
  }

  /** `entry` with the user's settings applied. */
  apply(entry: CatalogModel): CatalogModel {
    const override = this.override(entry);
    const toolReliability = override?.toolReliability ?? entry.toolReliability;
    const defaultEffort = this.defaultEffort(entry, entry.efforts);
    const profile = this.profile(entry, toolReliability);
    return {
      ...entry,
      ...(override?.displayName == null ? {} : { name: override.displayName }),
      ...(override?.contextWindow == null ? {} : { contextWindow: override.contextWindow }),
      ...(override?.vision == null ? {} : { vision: override.vision }),
      toolReliability,
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
      ...(profile === 'default' ? {} : { toolProfile: profile }),
    };
  }
}
