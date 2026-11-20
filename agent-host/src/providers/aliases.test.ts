import type { Api, Model } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { aliasTarget, resolveModel, type AliasContext } from './aliases.js';

function model(provider: string, id: string): Model<Api> {
  return { provider, id, name: id } as Model<Api>;
}

const parent = model('anthropic', 'parent-model');
const cheap = model('openai', 'cheap');
const middle = model('qwen', 'middle');
const big = model('anthropic', 'big');
const twin = model('other', 'big');

function context(aliases: Record<string, string>): AliasContext {
  return { aliases, inherit: parent, available: [parent, cheap, middle, big, twin] };
}

describe('resolveModel', () => {
  it('inherits for nothing and for inherit', () => {
    for (const spec of [undefined, '', 'inherit', '  inherit ']) {
      const result = resolveModel(spec, context({ fast: 'openai/cheap' }));
      expect(result).toEqual({ ok: true, model: parent, via: 'inherit' });
    }
  });

  it('maps the three tiers to their settings', () => {
    const table = { fast: 'openai/cheap', balanced: 'qwen/middle', strong: 'anthropic/big' };
    expect(resolveModel('fast', context(table))).toMatchObject({ model: cheap, alias: 'fast' });
    expect(resolveModel('balanced', context(table))).toMatchObject({
      model: middle,
      alias: 'balanced',
    });
    expect(resolveModel('strong', context(table))).toMatchObject({ model: big, alias: 'strong' });
  });

  it('lets haiku, sonnet and opus follow the tiers unless set on their own', () => {
    const table = { fast: 'openai/cheap', balanced: 'qwen/middle', strong: 'anthropic/big' };
    expect(resolveModel('haiku', context(table))).toMatchObject({ model: cheap, alias: 'fast' });
    expect(resolveModel('sonnet', context(table))).toMatchObject({
      model: middle,
      alias: 'balanced',
    });
    expect(resolveModel('opus', context(table))).toMatchObject({ model: big, alias: 'strong' });
    const own = { ...table, haiku: 'qwen/middle' };
    expect(resolveModel('haiku', context(own))).toMatchObject({ model: middle, alias: 'haiku' });
    expect(aliasTarget('sonnet', own)).toEqual({ target: 'qwen/middle', from: 'balanced' });
  });

  it('takes provider/model and a bare id that names one model', () => {
    expect(resolveModel('qwen/middle', context({}))).toMatchObject({ model: middle, via: 'id' });
    expect(resolveModel('cheap', context({}))).toMatchObject({ model: cheap, via: 'id' });
  });

  it('falls back to inherit with a warning for an alias that is not set or not available', () => {
    expect(resolveModel('fast', context({}))).toEqual({
      ok: true,
      model: parent,
      via: 'inherit',
      warning: { kind: 'aliasUnset', alias: 'fast' },
    });
    expect(resolveModel('opus', context({ strong: 'gone/model' }))).toEqual({
      ok: true,
      model: parent,
      via: 'inherit',
      warning: { kind: 'aliasUnavailable', alias: 'opus', target: 'gone/model' },
    });
  });

  it('refuses what it cannot resolve and lists the aliases', () => {
    for (const spec of ['fable', 'gone/model', 'big']) {
      const result = resolveModel(spec, context({}));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain(spec);
        expect(result.message).toContain('fast, balanced, strong, haiku, sonnet, opus');
      }
    }
  });
});
