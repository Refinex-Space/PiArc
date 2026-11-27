// The settings window's "Usage" page (T41, architecture section 8.2): tokens and estimated cost
// of every session (or one workspace's) by model and by session, subagents and auxiliary calls
// under their session, and the price table: each model's price with its source, which the user
// can replace (USD per million tokens, saved in the user settings) or reset to the catalog's.
import { PageHeadActions } from '../settings/page-head.js';
import { ScopePicker } from '../settings/ScopePicker.js';
import { WorkspaceOptions } from '../settings/WorkspaceOptions.js';
import { SettingsInfo, SettingsSection } from '../settings/layout.js';
import type { ModelUsage, UsageReport } from '@piarc/protocol';
import { useCallback, useEffect, useId, useState } from 'react';

import { useApp } from '../app/app-context.js';
import { parseWorkspaces } from '../settings/AgentsPage.js';
import { Cost, TokenList, purposeLabel } from './UsageViews.js';
import { parseUsageReport, totalTokens } from './usage.js';
import { Button } from '../app/Button.js';
import { reason } from '../shell/errors.js';

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
        setError(reason(e));
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

/** The last part of a workspace path, as the sidebar names it. */
function folderName(path: string): string {
  return (
    path
      .split(/[\\/]+/u)
      .filter(Boolean)
      .at(-1) ?? path
  );
}

/** One row per model: its share of the tokens, the tokens, the cost and its price. */
function ModelTable({
  models,
  onChanged,
}: {
  readonly models: readonly ModelUsage[];
  readonly onChanged: () => void;
}) {
  const { t, format } = useApp();
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const total = models.reduce((sum, m) => sum + totalTokens(m.tokens), 0);
  return (
    <div className="usage-models" data-testid="usage-models">
      {models.map((m) => {
        const key = `${m.provider}/${m.model}`;
        const tokens = totalTokens(m.tokens);
        const share = total === 0 ? 0 : Math.round((tokens / total) * 100);
        const breakdown = [
          `${t('usage.requestsColumn')} ${format.number(m.tokens.requests)}`,
          `${t('usage.tokens.input')} ${format.number(m.tokens.input)}`,
          `${t('usage.tokens.output')} ${format.number(m.tokens.output)}`,
          `${t('usage.tokens.cacheRead')} ${format.number(m.tokens.cacheRead)}`,
          `${t('usage.tokens.cacheWrite')} ${format.number(m.tokens.cacheWrite)}`,
        ].join(' · ');
        return (
          <div key={key} className="usage-model-block">
            <div className="usage-model" data-testid="usage-model-row" data-model={key}>
              <div className="usage-model-name">
                <span className="mono-text" title={key}>
                  {m.model}
                </span>
                <span className="usage-model-detail">
                  {t('usage.share', { share })}
                  {' · '}
                  <span data-testid="usage-price-source">
                    {t(`usage.price.source.${m.priceSource}`)}
                  </span>
                </span>
              </div>
              <span className="usage-share" aria-hidden="true">
                <span style={{ inlineSize: `${String(share)}%` }} />
              </span>
              <span className="usage-model-tokens" data-tooltip={breakdown}>
                {format.number(tokens, { notation: 'compact', maximumFractionDigits: 1 })}
              </span>
              <span className="usage-model-cost">
                <Cost cost={m.cost} testId="usage-model-cost" bare />
              </span>
              <Button
                size="small"
                variant="ghost"
                data-testid="usage-price-edit"
                aria-expanded={editing === key}
                onClick={() => {
                  setEditing(editing === key ? undefined : key);
                }}
              >
                {t('usage.price.edit')}
              </Button>
            </div>
            {editing === key ? (
              <PriceEditor
                model={m}
                onDone={() => {
                  setEditing(undefined);
                  onChanged();
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Sessions shown at first, and added by each "show more". */
const SESSION_PAGE = 10;

/**
 * The sessions that used the most tokens first, a filter by title or project, and a bounded
 * list that grows on request: a long history never turns into an endless page.
 */
function SessionTable({ report }: { readonly report: UsageReport }) {
  const { t, format } = useApp();
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(SESSION_PAGE);
  const needle = query.trim().toLowerCase();
  const sessions = [...report.sessions]
    .filter(
      (s) =>
        needle === '' ||
        (s.title ?? '').toLowerCase().includes(needle) ||
        (s.workspace ?? '').toLowerCase().includes(needle),
    )
    .sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens));
  const visible = sessions.slice(0, shown);
  return (
    <div className="usage-sessions" data-testid="usage-sessions">
      {report.sessions.length > SESSION_PAGE && (
        <input
          className="input usage-session-filter"
          type="search"
          value={query}
          aria-label={t('usage.sessions.filter')}
          placeholder={t('usage.sessions.filter')}
          data-testid="usage-session-filter"
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setShown(SESSION_PAGE);
          }}
        />
      )}
      {visible.map((s) => (
        <div
          key={s.sessionId}
          className="usage-session"
          data-testid="usage-session-row"
          data-session={s.sessionId}
        >
          <div className="usage-session-name">
            <span className="usage-session-title">{s.title ?? t('usage.untitled')}</span>
            {s.workspace == null ? null : (
              <span className="usage-model-detail" title={s.workspace}>
                {folderName(s.workspace)}
              </span>
            )}
            {(s.subagents ?? []).map((sub) => (
              <span
                key={sub.sessionId}
                className="usage-model-detail"
                data-testid="usage-session-subagent"
              >
                {sub.agentType == null
                  ? t('usage.subagentUntyped')
                  : t('usage.subagent', { type: sub.agentType })}
                {' · '}
                {t('usage.tokenCount', { count: totalTokens(sub.tokens) })}
                {' · '}
                <Cost cost={sub.cost} />
              </span>
            ))}
            {(s.auxiliary ?? []).map((a) => (
              <span
                key={a.purpose}
                className="usage-model-detail"
                data-testid="usage-session-auxiliary"
              >
                {purposeLabel(t, a.purpose)}
                {' · '}
                {t('usage.tokenCount', { count: totalTokens(a.tokens) })}
                {' · '}
                <Cost cost={a.cost} />
              </span>
            ))}
          </div>
          <span className="usage-model-tokens">
            {format.number(totalTokens(s.tokens), {
              notation: 'compact',
              maximumFractionDigits: 1,
            })}
          </span>
          <span className="usage-model-cost">
            <Cost cost={s.cost} partial={s.partial} testId="usage-session-cost" bare />
          </span>
        </div>
      ))}
      {sessions.length === 0 ? (
        <p className="settings-row-note">{t('settings.search.empty')}</p>
      ) : null}
      {sessions.length > shown ? (
        <div className="usage-session-more">
          <Button
            size="small"
            variant="ghost"
            data-testid="usage-session-more"
            onClick={() => {
              setShown((n) => n + 2 * SESSION_PAGE);
            }}
          >
            {t('usage.sessions.more', { count: sessions.length - shown })}
          </Button>
        </div>
      ) : null}
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
        setError(t('usage.failed', { reason: reason(e) }));
      });
  }, [chosen, t]);
  useEffect(load, [load]);
  return (
    <div className="settings-detail-page usage-page" data-testid="usage-page">
      <PageHeadActions>
        <ScopePicker
          all={{
            label: t('usage.all'),
            selected: chosen === '',
            onSelect: () => {
              setChosen('');
            },
            testId: 'usage-all',
          }}
        >
          <select
            id={selectId}
            aria-label={t('permissions.workspace')}
            className="settings-scope-select"
            value={chosen}
            data-testid="usage-workspace"
            onChange={(e) => {
              setChosen(e.currentTarget.value);
            }}
          >
            <option value="" hidden>
              {t('usage.chooseWorkspace')}
            </option>
            <WorkspaceOptions workspaces={workspaces} />
          </select>
        </ScopePicker>
        <Button size="small" data-testid="usage-refresh" onClick={load}>
          {t('usage.refresh')}
        </Button>
      </PageHeadActions>
      {error === '' ? null : (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {report === undefined ? null : (
        <>
          <UsageOverview report={report} />
          <SettingsSection
            title={t('usage.modelDetails')}
            aside={<SettingsInfo text={t('usage.hint')} />}
          >
            {report.models.length === 0 ? (
              <p className="settings-row-note">{t('usage.empty')}</p>
            ) : (
              <ModelTable models={report.models} onChanged={load} />
            )}
          </SettingsSection>
          <SettingsSection title={t('usage.sessions')}>
            {report.sessions.length === 0 ? (
              <p className="settings-row-note">{t('usage.empty')}</p>
            ) : (
              <SessionTable report={report} />
            )}
          </SettingsSection>
        </>
      )}
    </div>
  );
}
