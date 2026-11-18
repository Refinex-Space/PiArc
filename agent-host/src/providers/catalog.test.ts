import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import { assert, describe, expect, it } from 'vitest';

import { capabilities, supportedEffort, switchPreview } from './catalog.js';

const base = getBuiltinModels('anthropic')[0] as Model<Api>;
const model: Model<Api> = {
  ...base,
  provider: 'custom',
  id: 'chat',
  api: 'anthropic-messages',
  reasoning: true,
  thinkingLevelMap: { low: null, xhigh: 'high', max: null },
  cost: {
    input: 1,
    output: 3,
    cacheRead: 0.5,
    cacheWrite: 2,
    tiers: [{ inputTokensAbove: 2000, input: 4, output: 7, cacheRead: 1, cacheWrite: 5 }],
  },
};

describe('model capabilities', () => {
  it('applies the PiArc strict-tool assessment to explicit catalog support and hides unsupported efforts', () => {
    expect(capabilities({ ...model, compat: { supportsStrictTools: true } })).toMatchObject({
      toolReliability: 'verified',
      efforts: ['off', 'medium', 'high', 'xhigh'],
      maxOutput: model.maxTokens,
      contextWindow: model.contextWindow,
    });
    expect(capabilities({ ...model, compat: {} }).toolReliability).toBe('unknown');
    expect(supportedEffort(model, 'xhigh')).toBe('xhigh');
    expect(() => supportedEffort(model, 'low')).toThrow();
    expect(() => supportedEffort(model, 'minimal')).toThrow();
    expect(capabilities({ ...model, reasoning: false }).efforts).toEqual(['off']);
  });

  it('overlays documented Token Plan cache support only on the matching provider and model', () => {
    const plan = getBuiltinModels('qwen-token-plan-cn').find(
      (entry) => entry.id === 'qwen3.6-plus',
    );
    assert.isDefined(plan);
    expect(plan.promptCache).toBeUndefined();
    expect(plan.cost.cacheRead).toBe(0);
    expect(capabilities(plan).promptCache).toBe(true);
    expect(capabilities({ ...plan, provider: 'third-party-relay' }).promptCache).toBe(false);
    expect(capabilities({ ...plan, id: 'unknown-model' }).promptCache).toBe(false);
    const session = {
      model: plan,
      messages: [],
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    };
    expect(switchPreview(session, plan, new Set()).cacheWriteUsd).toBeNull();
  });

  it('uses the active price tier and compares thinking to the target provider, api and model', () => {
    const message: AssistantMessage = {
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: 0,
      content: [{ type: 'thinking', thinking: 'reason' }],
      stopReason: 'stop',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const session = {
      model,
      messages: [message],
      getContextUsage: () => ({ tokens: 3000, contextWindow: 5000, percent: 60 }),
    };
    expect(switchPreview(session, { ...model, id: 'next' }, new Set())).toEqual({
      contextTokens: 3000,
      cacheInvalidated: true,
      cacheWriteUsd: 0.015,
      dropsThinking: true,
    });
    expect(switchPreview(session, model, new Set(['custom/chat']))).toMatchObject({
      cacheWriteUsd: null,
      dropsThinking: false,
      cacheInvalidated: false,
    });
    expect(
      switchPreview(
        { ...session, messages: [], getContextUsage: () => undefined },
        model,
        new Set(),
      ),
    ).toMatchObject({
      cacheWriteUsd: null,
      contextTokens: null,
      dropsThinking: false,
    });
  });
});
