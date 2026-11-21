// Usage and cost (T41): Core's `UsageReport` and `SessionUsage` as the rail card and the
// settings page read them, and how costs are written (an estimate in US dollars, "unknown" when
// a model has no price, never 0).
import type {
  AuxiliaryUsage,
  ModelPrice,
  ModelUsage,
  SessionUsage,
  SubagentUsage,
  UsageReport,
  UsageTokens,
} from '@piarc/protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function tokens(value: unknown): UsageTokens {
  const v = isRecord(value) ? value : {};
  return {
    requests: count(v.requests),
    input: count(v.input),
    output: count(v.output),
    cacheRead: count(v.cacheRead),
    cacheWrite: count(v.cacheWrite),
    reasoning: count(v.reasoning),
  };
}

function cost(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function price(value: unknown): ModelPrice | undefined {
  if (!isRecord(value)) return undefined;
  const rates = ['input', 'output', 'cacheRead', 'cacheWrite'].map((k) => value[k]);
  if (!rates.every((r) => typeof r === 'number' && Number.isFinite(r))) return undefined;
  return {
    input: count(value.input),
    output: count(value.output),
    cacheRead: count(value.cacheRead),
    cacheWrite: count(value.cacheWrite),
    ...(Array.isArray(value.tiers) && value.tiers.length > 0 ? { tiers: [] } : {}),
  };
}

function models(value: unknown): ModelUsage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((m): ModelUsage[] => {
    if (typeof m.provider !== 'string' || typeof m.model !== 'string') return [];
    const source = m.priceSource;
    const known = price(m.price);
    const spent = cost(m.cost);
    return [
      {
        provider: m.provider,
        model: m.model,
        tokens: tokens(m.tokens),
        priceSource: source === 'catalog' || source === 'user' ? source : 'unknown',
        ...(spent === undefined ? {} : { cost: spent }),
        ...(known === undefined ? {} : { price: known }),
      },
    ];
  });
}

function session(value: unknown): SessionUsage | undefined {
  if (!isRecord(value) || typeof value.sessionId !== 'string') return undefined;
  const subagents = (Array.isArray(value.subagents) ? value.subagents : [])
    .filter(isRecord)
    .flatMap((s): SubagentUsage[] => {
      if (typeof s.sessionId !== 'string') return [];
      const spent = cost(s.cost);
      return [
        {
          sessionId: s.sessionId,
          tokens: tokens(s.tokens),
          ...(typeof s.agentType === 'string' ? { agentType: s.agentType } : {}),
          ...(spent === undefined ? {} : { cost: spent }),
        },
      ];
    });
  const auxiliary = (Array.isArray(value.auxiliary) ? value.auxiliary : [])
    .filter(isRecord)
    .flatMap((a): AuxiliaryUsage[] => {
      if (typeof a.purpose !== 'string') return [];
      const spent = cost(a.cost);
      return [
        {
          purpose: a.purpose,
          tokens: tokens(a.tokens),
          ...(spent === undefined ? {} : { cost: spent }),
        },
      ];
    });
  const spent = cost(value.cost);
  return {
    sessionId: value.sessionId,
    tokens: tokens(value.tokens),
    models: models(value.models),
    subagents,
    auxiliary,
    partial: value.partial === true,
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.workspace === 'string' ? { workspace: value.workspace } : {}),
    ...(spent === undefined ? {} : { cost: spent }),
  };
}

/** Core's `SessionUsage` JSON, the members this window reads checked. */
export function parseSessionUsage(text: string): SessionUsage {
  const parsed = session(JSON.parse(text) as unknown);
  if (parsed === undefined) throw new Error('Invalid session usage');
  return parsed;
}

/** Core's `UsageReport` JSON, the members this window reads checked. */
export function parseUsageReport(text: string): UsageReport {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error('Invalid usage report');
  const spent = cost(value.cost);
  return {
    tokens: tokens(value.tokens),
    models: models(value.models),
    sessions: (Array.isArray(value.sessions) ? value.sessions : []).flatMap((s) => {
      const parsed = session(s);
      return parsed === undefined ? [] : [parsed];
    }),
    partial: value.partial === true,
    ...(spent === undefined ? {} : { cost: spent }),
  };
}

/** A cost estimate in US dollars: cents above a dollar, four significant digits below. */
export function formatCost(value: number, locale: string): string {
  const options: Intl.NumberFormatOptions =
    value >= 1 || value === 0
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : { maximumSignificantDigits: 4 };
  // `narrowSymbol`: "$" in every locale (Chinese would write "US$").
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    ...options,
  }).format(value);
}

/** Every token of a usage: input, output and both cache kinds. */
export function totalTokens(t: UsageTokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}
