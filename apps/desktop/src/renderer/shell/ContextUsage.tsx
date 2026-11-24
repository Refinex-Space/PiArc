// The context usage of a session (T27, architecture section 8.2): the ring in the environment
// bar (a hint at 75 %, a warning at 90 %) and the rail's context card with the percentage, the
// breakdown by category and a button that compacts like `/compact` without a focus.
import { useState } from 'react';
import type { ContextUsage } from '@piarc/protocol';

import { useApp, useT } from '../app/app-context.js';
import { CATEGORY_ORDER, levelOf, percentOf } from '../store/context-usage.js';
import { useContextUsage, useTurnInfo } from '../store/hooks.js';
import { showPanel } from './registry.js';

/** Ring geometry (SVG user units). */
const SIZE = 16;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function Ring({ percent }: { readonly percent: number }) {
  return (
    <svg
      className="usage-ring-svg"
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${String(SIZE)} ${String(SIZE)}`}
      aria-hidden="true"
    >
      <circle
        className="usage-ring-track"
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        strokeWidth={STROKE}
      />
      <circle
        className="usage-ring-value"
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        strokeWidth={STROKE}
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)}
        transform={`rotate(-90 ${String(SIZE / 2)} ${String(SIZE / 2)})`}
      />
    </svg>
  );
}

/** The environment bar's ring; it opens the context card. */
export function UsageRing({ sessionId }: { readonly sessionId: string }) {
  const t = useT();
  const usage = useContextUsage(sessionId);
  const percent = usage === undefined ? undefined : percentOf(usage);
  const level = levelOf(percent);
  const label =
    percent === undefined
      ? t('context.ring.unknown')
      : level === 'normal'
        ? t('context.ring', { percent })
        : t(level === 'warning' ? 'context.ring.warning' : 'context.ring.critical', { percent });
  return (
    <button
      type="button"
      className="row-action usage-ring"
      data-testid="usage-ring"
      data-level={level}
      data-percent={percent ?? ''}
      aria-label={label}
      title={label}
      onClick={() => {
        showPanel('context');
      }}
    >
      <Ring percent={percent ?? 0} />
      <span className="usage-ring-text">{percent === undefined ? '–' : `${String(percent)}%`}</span>
    </button>
  );
}

function AutoCompactLine({ usage }: { readonly usage: ContextUsage }) {
  const t = useT();
  if (usage.autoCompact === 'stopped') {
    return (
      <p className="context-auto is-stopped" data-testid="context-auto">
        {t('context.autoStopped', { reason: usage.autoCompactStopped ?? 'failed' })}
      </p>
    );
  }
  if (usage.autoCompact === 'off') {
    return (
      <p className="context-auto muted" data-testid="context-auto">
        {t('context.autoOff')}
      </p>
    );
  }
  return (
    <p className="context-auto muted" data-testid="context-auto">
      {t('context.threshold', { threshold: usage.autoCompactThreshold })}
    </p>
  );
}

/** The rail's context card. */
export function ContextPanel({ sessionId }: { readonly sessionId: string }) {
  const { t, format } = useApp();
  const usage = useContextUsage(sessionId);
  const turn = useTurnInfo(sessionId);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const percent = usage === undefined ? undefined : percentOf(usage);
  const categories = usage
    ? CATEGORY_ORDER.filter((category) => usage.categories[category] > 0).sort(
        (left, right) => usage.categories[right] - usage.categories[left],
      )
    : [];
  const free = usage ? Math.max(0, usage.contextWindow - usage.tokens) : 0;
  const shareOf = (tokens: number, capacity: number) => {
    const share = tokens / capacity;
    return format.number(
      share,
      share > 0 && share < 0.001
        ? { style: 'percent', maximumSignificantDigits: 2 }
        : { style: 'percent', maximumFractionDigits: 1 },
    );
  };
  return (
    <div className="context-panel" data-testid="context-panel" data-level={levelOf(percent)}>
      {usage === undefined || percent === undefined ? (
        <p className="muted">{t('context.empty')}</p>
      ) : (
        <>
          <div className="context-summary">
            <strong data-testid="context-percent">{t('context.percent', { percent })}</strong>
            <span
              className="context-window"
              aria-hidden="true"
              title={t('context.tokens', { tokens: usage.tokens, window: usage.contextWindow })}
            >
              {format.number(usage.tokens, { notation: 'compact' })} /{' '}
              {format.number(usage.contextWindow, { notation: 'compact' })}
            </span>
          </div>
          <div className="context-meter" aria-hidden="true">
            {categories.map((category) => (
              <span
                key={category}
                className={`context-swatch swatch-${category}`}
                style={{
                  inlineSize:
                    String((100 * usage.categories[category]) / usage.contextWindow) + '%',
                }}
              />
            ))}
          </div>
          <span className="visually-hidden">
            {t('context.tokens', { tokens: usage.tokens, window: usage.contextWindow })}
          </span>
          <ul className="context-categories" data-testid="context-categories">
            {categories.map((category) => {
              const tokens = usage.categories[category];
              return (
                <li key={category} className="context-category" data-category={category}>
                  <span className={`context-swatch swatch-${category}`} aria-hidden="true" />
                  <span className="context-category-name">{t(`context.category.${category}`)}</span>
                  <span className="context-category-tokens">{format.number(tokens)}</span>
                  <span className="context-share">{shareOf(tokens, usage.contextWindow)}</span>
                </li>
              );
            })}
            <li className="context-category" data-category="free">
              <span className="context-swatch swatch-free" aria-hidden="true" />
              <span className="context-category-name">{t('context.free')}</span>
              <span className="context-category-tokens">{format.number(free)}</span>
              <span className="context-share">{shareOf(free, usage.contextWindow)}</span>
            </li>
          </ul>
          <div className="context-meta">
            <span>
              {t(
                usage.source === 'provider' ? 'context.source.provider' : 'context.source.estimate',
              )}
            </span>
            <AutoCompactLine usage={usage} />
          </div>
          {usage.serverFallback === true && <p role="status">{t('context.serverFallback')}</p>}
        </>
      )}
      <button
        type="button"
        className="button"
        data-testid="context-compact"
        disabled={turn.running || usage === undefined}
        onClick={() => {
          setFailure(undefined);
          window.piarc.compact(sessionId).catch((error: unknown) => {
            setFailure(error instanceof Error ? error.message : String(error));
          });
        }}
      >
        {turn.compacting ? t('context.compacting') : t('context.compact')}
      </button>
      {failure === undefined ? null : (
        <p className="context-error" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
