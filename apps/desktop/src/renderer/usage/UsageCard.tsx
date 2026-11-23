// The session rail's usage card (T41, architecture section 8.2): this session's tokens and
// estimated cost, by model, with its subagents and auxiliary calls listed. Read from Core when
// shown and again after every turn.
import type { SessionUsage } from '@piarc/protocol';
import { useEffect, useState } from 'react';

import { useApp } from '../app/app-context.js';
import { useTurnInfo } from '../store/hooks.js';
import { Cost, TokenList, purposeLabel } from './UsageViews.js';
import { parseSessionUsage, totalTokens, usageChanged } from './usage.js';

export function UsageCard({ sessionId }: { readonly sessionId: string }) {
  const { t } = useApp();
  const turn = useTurnInfo(sessionId);
  const [usage, setUsage] = useState<SessionUsage | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => {
      setRevision((previous) => previous + 1);
    };
    usageChanged.addEventListener(sessionId, refresh);
    return () => {
      usageChanged.removeEventListener(sessionId, refresh);
    };
  }, [sessionId]);
  useEffect(() => {
    let current = true;
    window.piarc
      .sessionUsage(sessionId)
      .then((raw) => {
        if (!current) return;
        setError(undefined);
        setUsage(parseSessionUsage(raw));
      })
      .catch((e: unknown) => {
        if (current) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      current = false;
    };
  }, [sessionId, turn.running, revision]);
  if (error !== undefined) {
    return (
      <p className="usage-card error-text" role="alert">
        {t('usage.failed', { reason: error })}
      </p>
    );
  }
  if (usage === undefined) return null;
  if (usage.tokens.requests === 0) {
    return (
      <div className="usage-card" data-testid="usage-card">
        <p className="muted">{t('usage.empty')}</p>
      </div>
    );
  }
  return (
    <div className="usage-card" data-testid="usage-card">
      <div className="usage-total">
        <Cost cost={usage.cost} partial={usage.partial} testId="usage-card-cost" />
        <span className="muted small">{t('usage.requests', { count: usage.tokens.requests })}</span>
      </div>
      <TokenList tokens={usage.tokens} />
      <ul className="usage-lines" data-testid="usage-card-models">
        {usage.models.map((m) => (
          <li key={`${m.provider}/${m.model}`} data-model={`${m.provider}/${m.model}`}>
            <span className="usage-line-name">{m.model}</span>
            <Cost cost={m.cost} />
          </li>
        ))}
      </ul>
      {(usage.subagents ?? []).length === 0 ? null : (
        <>
          <h3 className="usage-subheading">{t('usage.subagents')}</h3>
          <ul className="usage-lines" data-testid="usage-card-subagents">
            {(usage.subagents ?? []).map((s) => (
              <li key={s.sessionId}>
                <span className="usage-line-name">
                  {s.agentType == null
                    ? t('usage.subagentUntyped')
                    : t('usage.subagent', { type: s.agentType })}
                </span>
                <Cost cost={s.cost} />
              </li>
            ))}
          </ul>
        </>
      )}
      {(usage.auxiliary ?? []).length === 0 ? null : (
        <>
          <h3 className="usage-subheading">{t('usage.auxiliary')}</h3>
          <ul className="usage-lines" data-testid="usage-card-auxiliary">
            {(usage.auxiliary ?? []).map((a) => (
              <li key={a.purpose}>
                <span className="usage-line-name">{purposeLabel(t, a.purpose)}</span>
                {a.purpose === 'sideChat' &&
                  t('usage.tokenCount', { count: totalTokens(a.tokens) })}
                <Cost cost={a.cost} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
