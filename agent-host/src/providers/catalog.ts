// Capabilities and switch costs for chat models (architecture section 6.13).
import { readFile } from 'node:fs/promises';

import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai';
import type { CatalogModel, ModelSwitchPreviewResult } from '@piarc/protocol';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

import { AhpError } from '../protocol/errors.js';
import { isObject } from '../runtime/items.js';

export type Effort = Exclude<ReturnType<typeof getSupportedThinkingLevels>[number], 'minimal'>;

export function supportedEfforts(model: Model<Api>): Effort[] {
  return getSupportedThinkingLevels(model).filter((level) => level !== 'minimal');
}

export function supportedEffort(model: Model<Api>, requested: string): Effort {
  const effort = supportedEfforts(model).find((level) => level === requested);
  if (effort === undefined) {
    throw new AhpError('invalidParams', 'Select an effort supported by the target model', {
      details: { member: 'effort', supported: supportedEfforts(model) },
    });
  }
  return effort;
}

// PiArc grades schema-constrained tool arguments only when the catalog explicitly declares
// support for the adapter's strict encoding. Unknown endpoints get no implicit grade.
const STRICT_TOOLS: Readonly<Record<string, string>> = {
  'anthropic-messages': 'supportsStrictTools',
  'openai-completions': 'supportsStrictMode',
  'openai-responses': 'supportsStrictMode',
  'azure-openai-responses': 'supportsStrictMode',
};
// Model Studio documents cached input on this exact Team Token Plan model. Its credit
// tariff is absent from Pi's USD cost table (see the primary source in AGENTS.md).
const CAPABILITY_OVERRIDES = new Map<string, Pick<CatalogModel, 'promptCache'>>([
  ['qwen-token-plan-cn/qwen3.6-plus', { promptCache: true }],
]);
const CREDIT_PLANS = new Set([
  'qwen-token-plan',
  'qwen-token-plan-cn',
  'qwen-token-plan-individual',
  'qwen-token-plan-individual-cn',
]);

export function capabilities(model: Model<Api>): CatalogModel {
  const compat: unknown = model.compat;
  const strict = STRICT_TOOLS[model.api];
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxOutput: model.maxTokens,
    vision: model.input.includes('image'),
    efforts: supportedEfforts(model),
    promptCache:
      (model.promptCache?.short ?? 0) > 0 ||
      (model.promptCache?.long ?? 0) > 0 ||
      model.cost.cacheRead > 0 ||
      model.cost.cacheWrite > 0,
    toolReliability:
      strict && isObject(compat) && compat[strict] === true
        ? ('verified' as const)
        : ('unknown' as const),
    ...CAPABILITY_OVERRIDES.get(`${model.provider}/${model.id}`),
  };
}

/** Preserve the provenance lost when Pi fills missing custom-model prices with zeros. */
export async function unpricedModels(modelsPath: string): Promise<Set<string>> {
  let data: string;
  try {
    data = await readFile(modelsPath, 'utf8');
  } catch (error) {
    if (isObject(error) && error.code === 'ENOENT') return new Set();
    throw error;
  }
  const parsed: unknown = JSON.parse(data);
  const result = new Set<string>();
  if (!isObject(parsed) || !isObject(parsed.providers)) return result;
  for (const [id, provider] of Object.entries(parsed.providers)) {
    if (!isObject(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!isObject(model) || typeof model.id !== 'string') continue;
      const override = isObject(provider.modelOverrides)
        ? provider.modelOverrides[model.id]
        : undefined;
      if (
        (!isObject(model.cost) || typeof model.cost.cacheWrite !== 'number') &&
        !(
          isObject(override) &&
          isObject(override.cost) &&
          typeof override.cost.cacheWrite === 'number'
        )
      ) {
        result.add(`${id}/${model.id}`);
      }
    }
  }
  return result;
}

export function switchPreview(
  session: Pick<AgentSession, 'model' | 'messages' | 'getContextUsage'>,
  target: Model<Api>,
  unpriced: ReadonlySet<string>,
): ModelSwitchPreviewResult {
  const contextTokens = session.getContextUsage()?.tokens ?? null;
  const changed =
    session.model !== undefined &&
    (session.model.provider !== target.provider ||
      session.model.api !== target.api ||
      session.model.id !== target.id);
  const dropsThinking = session.messages.some(
    (message) =>
      message.role === 'assistant' &&
      (message.provider !== target.provider ||
        message.api !== target.api ||
        message.model !== target.id) &&
      message.content.some((block) => block.type === 'thinking'),
  );
  const price =
    contextTokens === null
      ? undefined
      : target.cost.tiers
          ?.filter((tier) => contextTokens > tier.inputTokensAbove)
          .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0];
  const cacheWriteUsd =
    contextTokens === null ||
    CREDIT_PLANS.has(target.provider) ||
    unpriced.has(`${target.provider}/${target.id}`)
      ? null
      : (contextTokens * (price?.cacheWrite ?? target.cost.cacheWrite)) / 1_000_000;
  return { contextTokens, cacheInvalidated: changed, cacheWriteUsd, dropsThinking };
}
