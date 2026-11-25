// The subagent card (T31, architecture section 8.2): one `Agent` call. Its name (the task
// description the model gave), type, color, the model it actually ran on, status, time, tool
// calls and tokens come from the run's state (`subagent` on the item, kept current by the
// `subagent/*` notifications); a background run is marked; warnings name ignored fields and
// fallbacks. Expanded, it shows the subagent's own transcript read-only (the same row
// components), read through the parent session; a running subagent can be stopped.
import type { AgentWarning, Item, SubagentState } from '@piarc/protocol';
import { useEffect, useMemo, useState } from 'react';

import { useT } from '../../app/app-context.js';
import type { MessageId } from '../../../shared/i18n/index.js';
import { parseWindow } from '../../store/history-window.js';
import { SessionTranscript } from '../../store/transcript.js';
import {
  TranscriptContext,
  useExpanded,
  useTranscriptView,
  type TranscriptView,
} from '../services.js';
import { useElapsedText, useNow } from './common.js';
import { RowArticle } from './RowView.js';

type SubagentItem = Extract<Item, { type: 'subagent' }>;

/** Items of the child's transcript a card loads. */
const CHILD_WINDOW = 200;

const STATUS: Record<SubagentState['status'], MessageId> = {
  running: 'subagent.status.running',
  completed: 'subagent.status.completed',
  partial: 'subagent.status.partial',
  failed: 'subagent.status.failed',
  interrupted: 'subagent.status.interrupted',
};

/** The definition colors the card shows; the others show without a color. */
const COLORS = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'cyan']);

function useWarningText(): (warning: AgentWarning) => string {
  const t = useT();
  return (w) => {
    const field = w.field ?? '';
    const value = w.value ?? '';
    switch (w.kind) {
      case 'ignoredField':
        return t('subagent.warning.ignoredField', { field });
      case 'inactiveField':
        return t('subagent.warning.inactiveField', { field, task: w.task ?? '' });
      case 'projectModeIgnored':
        return t('subagent.warning.projectModeIgnored', { value });
      case 'unsupportedMode':
        return t('subagent.warning.unsupportedMode', { value });
      case 'modeClamped':
        return t('subagent.warning.modeClamped', { value });
      case 'hooksUntrusted':
        return t('subagent.warning.hooksUntrusted');
      case 'aliasFallback':
        return t('subagent.warning.aliasFallback', { value });
      case 'effortUnsupported':
        return t('subagent.warning.effortUnsupported', { value });
    }
  };
}

/** The child's transcript, read-only, loaded again as the run makes progress. */
function ChildTranscript({ child, version }: { readonly child: string; readonly version: string }) {
  const t = useT();
  const parent = useTranscriptView();
  const load = parent.actions.subagentTranscript;
  const transcript = useMemo(() => new SessionTranscript(), []);
  const [ids, setIds] = useState<readonly string[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (load === undefined) return;
    let current = true;
    load(child, null, CHILD_WINDOW).then(
      (text) => {
        if (!current) return;
        const window = parseWindow(text);
        transcript.load(window.items, window.start);
        setIds(transcript.rowIds());
        setFailed(false);
      },
      (error: unknown) => {
        console.error('[subagent] cannot read the transcript', error);
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [load, child, version, transcript]);
  // Read-only: no retry, resend, rewind or branches inside a subagent's transcript.
  const view = useMemo<TranscriptView>(
    () => ({
      services: parent.services,
      transcript,
      actions: { retry: () => undefined, resend: () => undefined },
    }),
    [parent.services, transcript],
  );
  if (load === undefined) return null;
  return (
    <div className="subagent-transcript" data-testid="subagent-transcript">
      {failed ? (
        <p className="muted">{t('subagent.transcriptFailed')}</p>
      ) : ids.length === 0 ? (
        <p className="muted">{t('subagent.transcriptEmpty')}</p>
      ) : (
        <TranscriptContext.Provider value={view}>
          <div role="feed" aria-label={t('subagent.transcriptLabel')}>
            {ids.map((id) => (
              <RowArticle key={id} id={id} />
            ))}
          </div>
        </TranscriptContext.Provider>
      )}
    </div>
  );
}

/** One `Agent` call and its run. */
export function SubagentCard({
  id,
  item,
  startedAt,
}: {
  readonly id: string;
  readonly item: SubagentItem;
  readonly startedAt: number | undefined;
}) {
  const t = useT();
  const { actions } = useTranscriptView();
  const elapsedText = useElapsedText();
  const warningText = useWarningText();
  const state = item.subagent ?? undefined;
  const running = state === undefined ? item.status === 'inProgress' : state.status === 'running';
  const now = useNow(1000, running);
  const since = state?.startedAt ?? startedAt;
  const duration = state?.durationMs ?? (since === undefined ? undefined : now - since);
  const [open, setOpen] = useExpanded(`subagent:${id}`, false);
  const title = state?.description ?? item.description ?? t('subagent.untitled');
  const tokens = state?.tokens ?? undefined;
  const status: MessageId =
    state === undefined
      ? running
        ? 'subagent.status.running'
        : 'subagent.status.unknown'
      : STATUS[state.status];
  const color = state?.color != null && COLORS.has(state.color) ? state.color : undefined;
  const warnings = state?.warnings ?? [];
  return (
    <div
      className={`row row-subagent is-${state?.status ?? item.status}`}
      data-testid="subagent-card"
      data-row-id={id}
      data-status={state?.status ?? item.status}
    >
      <div className="subagent-box">
        <div className="subagent-head">
          <span
            className="subagent-dot"
            data-color={color ?? 'none'}
            aria-hidden="true"
            title={state?.color ?? undefined}
          />
          <span className="subagent-title truncate" data-testid="subagent-title">
            {title}
          </span>
          {state === undefined ? null : (
            <span className="subagent-type" data-testid="subagent-type">
              {state.agentType}
            </span>
          )}
          {state?.background === true ? (
            <span className="subagent-badge" data-testid="subagent-background">
              {t('subagent.background')}
            </span>
          ) : null}
          <span
            className={`subagent-status${running ? ' shimmer' : ''}`}
            data-testid="subagent-status"
          >
            {t(status)}
          </span>
        </div>
        <div className="subagent-facts muted" data-testid="subagent-facts">
          {state?.model == null ? null : (
            <span data-testid="subagent-model">
              {t('subagent.model', { model: `${state.model.provider}/${state.model.id}` })}
            </span>
          )}
          {duration === undefined ? null : <span>{elapsedText(duration)}</span>}
          {state === undefined ? null : (
            <span data-testid="subagent-tools">
              {t('subagent.toolCalls', { count: state.toolCalls })}
            </span>
          )}
          {tokens === undefined ? null : (
            <span data-testid="subagent-tokens">
              {t('subagent.tokens', {
                input: tokens.input + tokens.cacheRead,
                output: tokens.output,
              })}
            </span>
          )}
        </div>
        {running && state?.activity != null && state.activity !== '' ? (
          <div className="subagent-activity shimmer truncate" data-testid="subagent-activity">
            {state.activity}
          </div>
        ) : null}
        {state?.error == null ? null : (
          <div className="row-status is-warning" data-testid="subagent-error">
            {state.error}
          </div>
        )}
        {warnings.length === 0 ? null : (
          <ul className="subagent-warnings" data-testid="subagent-warnings">
            {warnings.map((warning, index) => (
              <li key={`${warning.kind}-${String(index)}`} className="muted">
                {warningText(warning)}
              </li>
            ))}
          </ul>
        )}
        <div className="subagent-actions">
          {state === undefined || actions.subagentTranscript === undefined ? null : (
            <button
              type="button"
              className="approval-link"
              data-testid="subagent-toggle"
              aria-expanded={open}
              onClick={() => {
                setOpen(!open);
              }}
            >
              {t(open ? 'subagent.hideTranscript' : 'subagent.showTranscript')}
            </button>
          )}
          {running && state !== undefined && actions.stopSubagent !== undefined ? (
            <button
              type="button"
              className="button button-small"
              data-testid="subagent-stop"
              onClick={() => {
                actions.stopSubagent?.(state.sessionId);
              }}
            >
              {t('subagent.stop')}
            </button>
          ) : null}
        </div>
        {open && state !== undefined ? (
          <ChildTranscript
            child={state.sessionId}
            version={`${state.status}:${String(state.toolCalls)}`}
          />
        ) : null}
      </div>
    </div>
  );
}
