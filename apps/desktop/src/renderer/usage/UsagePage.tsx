// The settings window's "Usage" page (T41, architecture section 8.2): tokens and estimated cost
// of every session (or one workspace's) by model and by session, subagents and auxiliary calls
// under their session, and the price table: each model's price with its source, which the user
// can replace (USD per million tokens, saved in the user settings) or reset to the catalog's.
import type { ModelUsage, UsageReport } from '@piarc/protocol';
import { useCallback, useEffect, useId, useState } from 'react';

import { useApp } from '../app/app-context.js';
import { parseWorkspaces } from '../settings/AgentsPage.js';
import { Cost, TokenList, purposeLabel } from './UsageViews.js';
import { parseUsageReport, totalTokens } from './usage.js';
import { Button } from '../app/Button.js';

const RATES = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
type Rate = (typeof RATES)[number];

const RATE_LABELS = {
  input: 'usage.tokens.input',
  output: 'usage.tokens.output',
  cacheRead: 'usage.tokens.cacheRead',
  cacheWrite: 'usage.tokens.cacheWrite',
} as const;

/** The typed rates as numbers, or undefined when one is not a non-negative number. */
export function parseRates(draft: Record<Rate, string>): Record<Rate, number> | undefined {
  const out: Partial<Record<Rate, number>> = {};
  for (const rate of RATES) {
    const text = draft[rate].trim();
    const value = Number(text);
    if (text === '' || !Number.isFinite(value) || value < 0) return undefined;
    out[rate] = value;
  }
  return out as Record<Rate, number>;
}

function PriceEditor({
  model,
  onDone,
}: {
  readonly model: ModelUsage;
  readonly onDone: () => void;
}) {
  const { t } = useApp();
  const baseId = useId();
  const [draft, setDraft] = useState<Record<Rate, string>>(() => ({
    input: String(model.price?.input ?? ''),
    output: String(model.price?.output ?? ''),
    cacheRead: String(model.price?.cacheRead ?? ''),
    cacheWrite: String(model.price?.cacheWrite ?? ''),
  }));
  const [error, setError] = useState<string | undefined>(undefined);
  const save = (rates: Record<Rate, number> | null) => {
    window.piarc
      .setModelPrice(model.provider, model.model, rates)
      .then(onDone)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  };
  return (
    <form
      className="usage-price-form"
      data-testid="usage-price-form"
      onSubmit={(event) => {
        event.preventDefault();
        const rates = parseRates(draft);
        if (rates === undefined) {
          setError(t('usage.price.invalid'));
          return;
        }
        save(rates);
      }}
    >
      <p className="muted small">{t('usage.price.unit')}</p>
      <div className="usage-price-fields">
        {RATES.map((rate) => (
          <label key={rate} htmlFor={`${baseId}-${rate}`} className="usage-price-field">
            <span>{t(RATE_LABELS[rate])}</span>
            <input
              id={`${baseId}-${rate}`}
              className="input"
              inputMode="decimal"
              data-testid={`usage-price-${rate}`}
              value={draft[rate]}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setDraft((d) => ({ ...d, [rate]: value }));
              }}
            />
          </label>
        ))}
      </div>
      {error === undefined ? null : (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="usage-price-actions">
        <Button type="submit" variant="primary" data-testid="usage-price-save">
          {t('usage.price.save')}
        </Button>
        {model.priceSource === 'user' ? (
          <Button
            size="small"
            data-testid="usage-price-reset"
            onClick={() => {
              save(null);
            }}
          >
            {t('usage.price.reset')}
          </Button>
        ) : null}
        <Button variant="ghost" size="small" onClick={onDone}>
          {t('usage.price.cancel')}
        </Button>
      </div>
    </form>
  );
}

function ModelTable({
  models,
  onChanged,
}: {
  readonly models: readonly ModelUsage[];
  readonly onChanged: () => void;
}) {
  const { t, format } = useApp();
  const [editing, setEditing] = useState<string | undefined>(undefined);
  return (
    <div className="usage-table-wrap">
      <table className="diagnostics-table usage-table" data-testid="usage-models">
        <thead>
          <tr>
            <th>{t('usage.model')}</th>
            <th className="usage-number">{t('usage.requestsColumn')}</th>
            <th className="usage-number">{t('usage.tokens.input')}</th>
            <th className="usage-number">{t('usage.tokens.output')}</th>
            <th className="usage-number">{t('usage.tokens.cacheRead')}</th>
            <th className="usage-number">{t('usage.tokens.cacheWrite')}</th>
            <th className="usage-number">{t('usage.costColumn')}</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => {
            const key = `${m.provider}/${m.model}`;
            return [
              <tr key={key} data-testid="usage-model-row" data-model={key}>
                <td className="usage-model-cell">
                  <div className="diagnostics-code">{key}</div>
                  <div className="usage-price-line">
                    <span className="muted small" data-testid="usage-price-source">
                      {t(`usage.price.source.${m.priceSource}`)}
                    </span>
                    <Button
                      size="small"
                      data-testid="usage-price-edit"
                      onClick={() => {
                        setEditing(editing === key ? undefined : key);
                      }}
                    >
                      {t('usage.price.edit')}
                    </Button>
                  </div>
                </td>
                <td className="usage-number">{format.number(m.tokens.requests)}</td>
                <td className="usage-number">{format.number(m.tokens.input)}</td>
                <td className="usage-number">{format.number(m.tokens.output)}</td>
                <td className="usage-number">{format.number(m.tokens.cacheRead)}</td>
                <td className="usage-number">{format.number(m.tokens.cacheWrite)}</td>
                <td className="usage-number">
                  <Cost cost={m.cost} testId="usage-model-cost" bare />
                </td>
              </tr>,
              editing === key ? (
                <tr key={`${key}-edit`}>
                  <td colSpan={7}>
                    <PriceEditor
                      model={m}
                      onDone={() => {
                        setEditing(undefined);
                        onChanged();
                      }}
                    />
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function SessionTable({ report }: { readonly report: UsageReport }) {
  const { t, format } = useApp();
  return (
    <div className="usage-table-wrap">
      <table className="diagnostics-table usage-table" data-testid="usage-sessions">
        <thead>
          <tr>
            <th>{t('usage.session')}</th>
            <th className="usage-number">{t('usage.tokensColumn')}</th>
            <th className="usage-number">{t('usage.costColumn')}</th>
          </tr>
        </thead>
        <tbody>
          {report.sessions.map((s) => (
            <tr key={s.sessionId} data-testid="usage-session-row" data-session={s.sessionId}>
              <td>
                <div>{s.title ?? t('usage.untitled')}</div>
                {s.workspace === undefined ? null : (
                  <div className="muted small diagnostics-code">{s.workspace}</div>
                )}
                {(s.subagents ?? []).map((sub) => (
                  <div
                    key={sub.sessionId}
                    className="muted small"
                    data-testid="usage-session-subagent"
                  >
                    {sub.agentType == null
                      ? t('usage.subagentUntyped')
                      : t('usage.subagent', { type: sub.agentType })}
                    {' · '}
                    {t('usage.tokenCount', { count: totalTokens(sub.tokens) })}
                    {' · '}
                    <Cost cost={sub.cost} />
                  </div>
                ))}
                {(s.auxiliary ?? []).map((a) => (
                  <div
                    key={a.purpose}
                    className="muted small"
                    data-testid="usage-session-auxiliary"
                  >
                    {purposeLabel(t, a.purpose)}
                    {' · '}
                    {t('usage.tokenCount', { count: totalTokens(a.tokens) })}
                    {' · '}
                    <Cost cost={a.cost} />
                  </div>
                ))}
              </td>
              <td className="usage-number">{format.number(totalTokens(s.tokens))}</td>
              <td className="usage-number">
                <Cost cost={s.cost} partial={s.partial} testId="usage-session-cost" bare />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The report provides cumulative counts. Per-model shares use the same token total as the cards. */
function UsageOverview({ report }: { readonly report: UsageReport }) {
  const { t, format } = useApp();
  const total = totalTokens(report.tokens);
  return (
    <section className="usage-overview" data-testid="usage-summary">
      <h2 className="settings-heading">{t('usage.overview')}</h2>
      <dl className="usage-metrics">
        <div>
          <dt>{t('usage.tokensColumn')}</dt>
          <dd>{format.number(total)}</dd>
        </div>
        <div>
          <dt>{t('usage.requestsColumn')}</dt>
          <dd>{format.number(report.tokens.requests)}</dd>
        </div>
        <div>
          <dt>{t('usage.costColumn')}</dt>
          <dd>
            <Cost cost={report.cost} partial={report.partial} testId="usage-total-cost" />
          </dd>
        </div>
      </dl>
      {(total > 0 || report.tokens.reasoning > 0) && (
        <div className="usage-distribution">
          <section>
            <h3>{t('usage.breakdown')}</h3>
            <div className="usage-stack" aria-hidden="true">
              {RATES.filter((rate) => report.tokens[rate] > 0).map((rate) => (
                <span
                  key={rate}
                  data-rate={RATE_LABELS[rate]}
                  style={{ flexGrow: report.tokens[rate] }}
                />
              ))}
            </div>
            <TokenList tokens={report.tokens} />
          </section>
          {total > 0 && report.models.length > 0 && (
            <section>
              <h3>{t('usage.models')}</h3>
              <ul className="usage-model-shares">
                {report.models.map((model) => {
                  const key = `${model.provider}/${model.model}`;
                  const tokens = totalTokens(model.tokens);
                  return (
                    <li key={key}>
                      <span className="usage-share-model" title={key}>
                        {model.model}
                      </span>
                      <span className="usage-share-meter" aria-hidden="true">
                        <span style={{ width: `${String((tokens / total) * 100)}%` }} />
                      </span>
                      <span>{format.number(tokens)}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      )}
    </section>
  );
}

export function UsagePage() {
  const { t } = useApp();
  const selectId = useId();
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string>('');
  const [report, setReport] = useState<UsageReport | undefined>(undefined);
  const [error, setError] = useState('');
  useEffect(() => {
    window.piarc
      .configDiagnostics(null)
      .then((raw) => {
        setWorkspaces(parseWorkspaces(raw).workspaces);
      })
      .catch(() => {
        // The list of workspaces only narrows the report; all of them are still shown.
      });
  }, []);
  const load = useCallback(() => {
    window.piarc
      .usageReport(chosen === '' ? null : chosen)
      .then((raw) => {
        setError('');
        setReport(parseUsageReport(raw));
      })
      .catch((e: unknown) => {
        setError(t('usage.failed', { reason: e instanceof Error ? e.message : String(e) }));
      });
  }, [chosen, t]);
  useEffect(load, [load]);
  return (
    <div className="settings-detail-page usage-page" data-testid="usage-page">
      <div className="permission-filters">
        <label htmlFor={selectId} className="permission-filter-label">
          {t('permissions.workspace')}
        </label>
        <select
          id={selectId}
          className="input"
          value={chosen}
          data-testid="usage-workspace"
          onChange={(e) => {
            setChosen(e.currentTarget.value);
          }}
        >
          <option value="">{t('usage.allWorkspaces')}</option>
          {workspaces.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
        <Button size="small" data-testid="usage-refresh" onClick={load}>
          {t('usage.refresh')}
        </Button>
      </div>
      {error === '' ? null : (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {report === undefined ? null : (
        <>
          <UsageOverview report={report} />
          <h2 className="settings-heading">{t('usage.modelDetails')}</h2>
          <p className="muted">{t('usage.hint')}</p>
          {report.models.length === 0 ? (
            <p className="muted">{t('usage.empty')}</p>
          ) : (
            <ModelTable models={report.models} onChanged={load} />
          )}
          <h2 className="settings-heading">{t('usage.sessions')}</h2>
          {report.sessions.length === 0 ? (
            <p className="muted">{t('usage.empty')}</p>
          ) : (
            <SessionTable report={report} />
          )}
        </>
      )}
    </div>
  );
}
