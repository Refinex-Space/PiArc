// Rows about the turn rather than its content (architecture sections 7.5, 8.2, 8.5): the
// compaction notice, the error card (Core's kind of failure, a retry when Core says it may help),
// the "outcome unknown" card after an Agent Host restart, and the working row (current tool,
// elapsed time, tokens, retry n / max, compaction).
import type { Item, TurnErrorKind } from '@piarc/protocol';

import { useT } from '../../app/app-context.js';
import type { MessageId } from '../../../shared/i18n/index.js';
import type { TranscriptRow, TurnInfo } from '../../store/transcript.js';
import { useExpanded, useTranscriptView, useTurn } from '../services.js';
import { useElapsedText, useNow } from './common.js';
import { targetOf } from './summary.js';

type CompactionItem = Extract<Item, { type: 'contextCompaction' }>;

export function CompactionRow({
  id,
  item,
}: {
  readonly id: string;
  readonly item: CompactionItem;
}) {
  const t = useT();
  let text: string;
  if (item.status === 'inProgress') {
    text = t('transcript.compaction.running');
  } else if (item.status === 'failed') {
    text = t('transcript.compaction.failed', { message: item.errorMessage ?? '' });
  } else if (item.status === 'interrupted') {
    text = t('transcript.compaction.interrupted');
  } else if (item.reason === 'rewind') {
    // T28's "summarize from here": the rest of the branch is a summary.
    text = t('transcript.compaction.summary');
  } else if (
    item.tokensBefore !== undefined &&
    item.tokensBefore !== null &&
    item.tokensAfter !== undefined &&
    item.tokensAfter !== null
  ) {
    text = t('transcript.compaction.done', {
      reason: item.reason ?? 'other',
      before: item.tokensBefore,
      after: item.tokensAfter,
    });
  } else {
    text = t('transcript.compaction.doneShort');
  }
  return (
    <div
      className={`row row-compaction is-${item.status}`}
      data-testid="compaction-row"
      data-row-id={id}
      data-status={item.status}
      role="status"
    >
      <span className="row-rule" aria-hidden="true" />
      <span className="row-compaction-text">
        {text}
        {item.autoCompactStopped == null ? null : (
          <span className="row-compaction-stopped" data-testid="compaction-stopped">
            {t('transcript.compaction.stopped', { reason: item.autoCompactStopped })}
          </span>
        )}
      </span>
      <span className="row-rule" aria-hidden="true" />
    </div>
  );
}

const ERROR_TITLE: Record<TurnErrorKind, MessageId> = {
  auth: 'transcript.error.auth',
  rateLimit: 'transcript.error.rateLimit',
  provider: 'transcript.error.provider',
  network: 'transcript.error.network',
  contextOverflow: 'transcript.error.contextOverflow',
  invalidRequest: 'transcript.error.invalidRequest',
  internal: 'transcript.error.internal',
};

const ERROR_HINT: Record<TurnErrorKind, MessageId> = {
  auth: 'transcript.error.auth.hint',
  rateLimit: 'transcript.error.rateLimit.hint',
  provider: 'transcript.error.provider.hint',
  network: 'transcript.error.network.hint',
  contextOverflow: 'transcript.error.contextOverflow.hint',
  invalidRequest: 'transcript.error.invalidRequest.hint',
  internal: 'transcript.error.internal.hint',
};

export function ErrorCard({ row }: { readonly row: Extract<TranscriptRow, { kind: 'error' }> }) {
  const t = useT();
  const { actions } = useTranscriptView();
  const [details, setDetails] = useExpanded(row.id, false);
  return (
    <div
      className="row row-error"
      data-testid="error-card"
      data-row-id={row.id}
      data-kind={row.errorKind}
      data-retryable={row.retryable}
      role="alert"
    >
      <div className="row-error-title" data-testid="error-title">
        {t(ERROR_TITLE[row.errorKind])}
      </div>
      <div className="row-error-hint">{t(ERROR_HINT[row.errorKind])}</div>
      <div className="row-error-actions">
        {row.retryable ? (
          <button
            type="button"
            className="button"
            data-testid="error-retry"
            onClick={() => {
              actions.retry(row.turnId);
            }}
          >
            {t('transcript.error.retry')}
          </button>
        ) : null}
        {row.message === '' ? null : (
          <button
            type="button"
            className="row-action"
            aria-expanded={details}
            onClick={() => {
              setDetails(!details);
            }}
          >
            {t('transcript.error.details')}
          </button>
        )}
      </div>
      {details ? (
        <pre className="row-error-details" data-testid="error-details">
          {row.message}
        </pre>
      ) : null}
    </div>
  );
}

export function UncertainCard({
  row,
}: {
  readonly row: Extract<TranscriptRow, { kind: 'uncertain' }>;
}) {
  const t = useT();
  const { actions } = useTranscriptView();
  return (
    <div
      className="row row-error is-uncertain"
      data-testid="uncertain-card"
      data-row-id={row.id}
      role="alert"
    >
      <div className="row-error-title">{t('transcript.uncertain')}</div>
      <div className="row-error-hint">{t('transcript.uncertain.hint')}</div>
      <div className="row-error-actions">
        <button
          type="button"
          className="button"
          data-testid="uncertain-retry"
          onClick={() => {
            actions.retry(row.turnId);
          }}
        >
          {t('transcript.error.retry')}
        </button>
      </div>
    </div>
  );
}

/** While a turn runs: what it is doing, for how long, how many tokens, retries, compaction. */
export function WorkingRow() {
  const t = useT();
  const { transcript } = useTranscriptView();
  const turn: TurnInfo = useTurn();
  const now = useNow(1000, turn.running);
  const elapsedText = useElapsedText();
  const label = (item: Item): string =>
    t('transcript.working.tool', {
      tool: 'tool' in item ? item.tool : item.type,
      target: targetOf(item),
    });
  const currentId = turn.openTools.at(-1);
  const current = currentId === undefined ? undefined : transcript.row(currentId);
  const activity = turn.compacting
    ? t('transcript.working.compacting')
    : current?.kind === 'item'
      ? label(current.item)
      : t('transcript.working');
  const tokens = turn.usage === undefined ? undefined : turn.usage.outputTokens;
  return (
    <div className="row row-working" data-testid="working-row" aria-live="off">
      <span className="working-spinner" aria-hidden="true" />
      <span
        className="working-activity"
        data-testid="working-activity"
        data-compacting={turn.compacting}
      >
        {activity}
      </span>
      {turn.startedAt === undefined ? null : (
        <span className="working-elapsed" data-testid="working-elapsed">
          {elapsedText(now - turn.startedAt)}
        </span>
      )}
      {tokens === undefined ? null : (
        <span className="working-tokens" data-testid="working-tokens">
          {t('transcript.working.tokens', { count: tokens })}
        </span>
      )}
      {turn.retry === undefined ? null : (
        <span className="working-retry" data-testid="working-retry">
          {t('transcript.working.retry', { attempt: turn.retry.attempt, max: turn.retry.max })}
        </span>
      )}
    </div>
  );
}
