// The pieces the rail card and the settings page share (T41): a cost (estimate, unknown, or
// partial), the token breakdown, and labels for subagents and auxiliary calls.
import type { UsageTokens } from '@piarc/protocol';

import type { MessageId } from '../../shared/i18n/index.js';
import { useApp } from '../app/app-context.js';
import { formatCost } from './usage.js';

type Translate = (id: MessageId, values?: Record<string, string | number>) => string;

const PURPOSES: Readonly<Record<string, MessageId>> = {
  webFetch: 'usage.purpose.webFetch',
  webSearch: 'usage.purpose.webSearch',
  hookPrompt: 'usage.purpose.hookPrompt',
  cache_warm: 'usage.purpose.cacheWarm',
};

/** What an auxiliary call was for. */
export function purposeLabel(t: Translate, purpose: string): string {
  const id = PURPOSES[purpose];
  return id === undefined ? purpose : t(id);
}

/** A cost: the estimate, "unknown" without a price, a note when some models have none. */
export function Cost({
  cost,
  partial = false,
  testId,
  bare = false,
}: {
  readonly cost: number | null | undefined;
  readonly partial?: boolean | undefined;
  readonly testId?: string;
  /** Only the amount: a table's header says it is an estimate. */
  readonly bare?: boolean;
}) {
  const { t, locale } = useApp();
  if (cost == null) {
    return (
      <span className="usage-cost is-unknown" data-testid={testId} data-cost="unknown">
        {t('usage.costUnknown')}
      </span>
    );
  }
  const text = formatCost(cost, locale);
  return (
    <span className="usage-cost" data-testid={testId} data-cost={String(cost)}>
      {bare ? text : t(partial ? 'usage.costPartial' : 'usage.cost', { cost: text })}
    </span>
  );
}

/** Input, output, cache reads and writes (and reasoning when reported). */
export function TokenList({ tokens }: { readonly tokens: UsageTokens }) {
  const { t, format } = useApp();
  const rows: [MessageId, number][] = [
    ['usage.tokens.input', tokens.input],
    ['usage.tokens.output', tokens.output],
    ['usage.tokens.cacheRead', tokens.cacheRead],
    ['usage.tokens.cacheWrite', tokens.cacheWrite],
  ];
  if (tokens.reasoning > 0) rows.push(['usage.tokens.reasoning', tokens.reasoning]);
  return (
    <dl className="usage-tokens" data-testid="usage-tokens">
      {rows.map(([label, value]) => (
        <div key={label} className="usage-token">
          <dt>{t(label)}</dt>
          <dd>{format.number(value)}</dd>
        </div>
      ))}
    </dl>
  );
}
