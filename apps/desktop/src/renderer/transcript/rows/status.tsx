// Rows about the turn rather than its content (architecture sections 7.5, 8.2, 8.5): the
// compaction notice, the error card (Core's kind of failure, a retry when Core says it may help),
// the "outcome unknown" card after an Agent Host restart, and the working row (current tool,
// elapsed time, tokens, retry n / max, compaction).
import type { Item, TurnErrorKind } from '@piarc/protocol';

import { useT } from '../../app/app-context.js';
import type { MessageId } from '../../../shared/i18n/index.js';
import type { TranscriptRow, TurnInfo } from '../../store/transcript.js';
import { useExpanded, useShownRowIds, useTranscriptView, useTurn } from '../services.js';
import { isApprovalRow } from '../../store/transcript.js';
import { ActivityMark, type Activity } from './ActivityMark.js';
import { Segments } from './parts.js';
import { useElapsedText, useNow } from './common.js';
import { targetOf } from './summary.js';
import { InfoGlyph, StepCaret, WarningGlyph } from '../../shell/icons.js';

type CompactionItem = Extract<Item, { type: 'contextCompaction' }>;
type ReminderItem = Extract<Item, { type: 'reminder' }>;

/** A system reminder the model received (T27), shown in the detailed view only (T29); a
 * Monitor's output (T32) shows in every view as a Monitor event. Its text is the model's input,
 * shown as text. */
export function ReminderRow({ id, item }: { readonly id: string; readonly item: ReminderItem }) {
  const t = useT();
  const kinds = [...new Set(item.reminders.map((r) => t(`transcript.reminder.${r.type}`)))];
  const monitor = item.reminders.every((r) => r.type === 'monitorOutput');
  return (
    <div
      className={monitor ? 'row row-reminder row-monitor' : 'row row-reminder'}
      data-testid={monitor ? 'monitor-row' : 'reminder-row'}
      data-row-id={id}
      role="note"
    >
      <div className="row-reminder-body">
        <div className="row-reminder-head">
          {monitor
            ? t('transcript.monitor.title')
            : t('transcript.reminder.title', {
                kinds: kinds.join(t('transcript.reminder.separator')),
              })}
        </div>
        <div className="row-reminder-text">{item.text}</div>
      </div>
    </div>
  );
}

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
      <span className={`row-compaction-text${item.status === 'inProgress' ? ' shimmer' : ''}`}>
        {text}
        {item.autoCompactStopped == null ? null : (
          <span className="row-compaction-stopped" data-testid="compaction-stopped">
            {t('transcript.compaction.stopped', { reason: item.autoCompactStopped })}
          </span>
        )}
      </span>
    </div>
  );
}

export const ERROR_TITLE: Record<TurnErrorKind, MessageId> = {
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
      <div className="row-error-box">
        <div className="row-error-head">
          <WarningGlyph />
          <span className="row-error-title" data-testid="error-title">
            {t(ERROR_TITLE[row.errorKind])}
          </span>
        </div>
        <div className="row-error-body">
          <div className="row-error-hint">{t(ERROR_HINT[row.errorKind])}</div>
          {details ? (
            <pre className="row-error-details" data-testid="error-details">
              {row.message}
            </pre>
          ) : null}
          <div className="row-error-actions">
            {row.message === '' ? null : (
              <button
                type="button"
                className="row-error-more"
                aria-expanded={details}
                onClick={() => {
                  setDetails(!details);
                }}
              >
                {t('transcript.error.details')}
                <span className="step-caret" aria-hidden="true">
                  <StepCaret />
                </span>
              </button>
            )}
            {row.retryable ? (
              <button
                type="button"
                className="button button-primary"
                data-testid="error-retry"
                onClick={() => {
                  actions.retry(row.turnId);
                }}
              >
                {t('transcript.error.retry')}
              </button>
            ) : null}
          </div>
        </div>
      </div>
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
      <div className="row-error-box">
        <div className="row-error-head">
          <InfoGlyph />
          <span className="row-error-title">{t('transcript.uncertain')}</span>
        </div>
        <div className="row-error-body">
          <div className="row-error-hint">{t('transcript.uncertain.hint')}</div>
          <div className="row-error-actions">
            <button
              type="button"
              className="button button-primary"
              data-testid="uncertain-retry"
              onClick={() => {
                actions.retry(row.turnId);
              }}
            >
              {t('transcript.error.retry')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Elapsed time and tokens show once the turn has run this long (ms). */
const WORKING_DETAILS_AFTER_MS = 2_000;

/**
 * While a turn runs: the working mark hung in the gutter, what the turn is doing (the current
 * tool, compaction, or that it waits for the user), and after a moment how long it has run, its
 * tokens and its retries.
 */
export function WorkingRow() {
  const t = useT();
  const { transcript } = useTranscriptView();
  const turn: TurnInfo = useTurn();
  const waiting = useShownRowIds().some(isApprovalRow);
  const now = useNow(1000, turn.running);
  const elapsedText = useElapsedText();
  const label = (item: Item): string =>
    t('transcript.working.tool', {
      tool: 'tool' in item ? item.tool : item.type,
      target: targetOf(item),
    });
  const currentId = turn.openTools.at(-1);
  const current = currentId === undefined ? undefined : transcript.row(currentId);
  const text = waiting
    ? t('transcript.needsInput')
    : turn.compacting
      ? t('transcript.working.compacting')
      : current?.kind === 'item'
        ? label(current.item)
        : t('transcript.working');
  const activity: Activity = waiting ? 'blocked' : current?.kind === 'item' ? 'tool' : 'think';
  const tokens = turn.usage === undefined ? undefined : turn.usage.outputTokens;
  const elapsed = turn.startedAt === undefined ? undefined : now - turn.startedAt;
  const details = elapsed !== undefined && elapsed >= WORKING_DETAILS_AFTER_MS;
  return (
    <div
      className="row row-working"
      data-testid="working-row"
      data-activity={activity}
      aria-live="off"
    >
      <span className="working-mark">
        <ActivityMark activity={activity} />
      </span>
      {/* A new label eases in; the key starts its entrance again. */}
      <span
        key={text}
        className={`working-activity${waiting ? ' status-pill' : ' shimmer'}`}
        data-testid="working-activity"
        data-compacting={turn.compacting}
      >
        {text}
      </span>
      <span className="working-facts">
        <Segments>
          {[
            details ? (
              <span key="elapsed" className="working-elapsed" data-testid="working-elapsed">
                {elapsedText(elapsed)}
              </span>
            ) : null,
            details && tokens !== undefined ? (
              <span key="tokens" className="working-tokens" data-testid="working-tokens">
                {t('transcript.working.tokens', { count: tokens })}
              </span>
            ) : null,
            turn.retry === undefined ? null : (
              <span key="retry" className="working-retry" data-testid="working-retry">
                {t('transcript.working.retry', {
                  attempt: turn.retry.attempt,
                  max: turn.retry.max,
                })}
              </span>
            ),
          ]}
        </Segments>
      </span>
    </div>
  );
}
