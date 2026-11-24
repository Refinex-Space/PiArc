// The message rows (architecture section 8.2): the user's input with its mention and attachment
// chips, the agent's reply (Markdown from the worker, raw HTML as text), and the thinking block
// (open and not collapsible while it is generated, then folded to "thought for N seconds").
import type { Item } from '@piarc/protocol';
import { useEffect, type ReactNode } from 'react';

import { useT } from '../../app/app-context.js';
import { chipOf, type ShownInput, type TranscriptRow } from '../../store/transcript.js';
import { blocksText } from '../copy.js';
import { MarkdownView } from '../markdown/MarkdownView.js';
import { BranchSwitcher } from '../../changes/BranchSwitcher.js';
import {
  useBranchPoint,
  useExpanded,
  useParsedDoc,
  useTranscriptView,
  useTurn,
} from '../services.js';
import { AttachmentChips, CopyButton, MentionText } from './common.js';
import { useListActions, useRowCommitted } from './list-actions.js';

type AgentMessageItem = Extract<Item, { type: 'agentMessage' }>;
type ReasoningItem = Extract<Item, { type: 'reasoning' }>;
type UserMessageItem = Extract<Item, { type: 'userMessage' }>;

/** A user message from Core; the first of a turn can be rewound to and branched from (T28). */
export function UserMessageRow({
  id,
  item,
  turnId,
}: {
  readonly id: string;
  readonly item: UserMessageItem;
  readonly turnId: string | undefined;
}) {
  const t = useT();
  const { actions, transcript } = useTranscriptView();
  const point = useBranchPoint(turnId);
  const { running } = useTurn();
  const start = turnId !== undefined && transcript.isTurnStart(id);
  const { rewind, branchFrom, switchBranch } = actions;
  return (
    <UserBubble
      id={id}
      input={{
        text: item.text,
        mentions: item.mentions ?? [],
        attachments: (item.attachments ?? []).flatMap(chipOf),
      }}
      extra={
        <>
          {start && rewind !== undefined ? (
            <button
              type="button"
              className="row-action"
              data-testid="rewind-here"
              disabled={running}
              onClick={() => {
                rewind(turnId, item.text);
              }}
            >
              {t('transcript.rewind')}
            </button>
          ) : null}
          {start && branchFrom !== undefined ? (
            <button
              type="button"
              className="row-action"
              data-testid="branch-from-here"
              onClick={() => {
                branchFrom(turnId, item.text);
              }}
            >
              {t('transcript.branchFrom')}
            </button>
          ) : null}
        </>
      }
      branches={
        point === undefined || switchBranch === undefined ? null : (
          <BranchSwitcher point={point} onSwitch={switchBranch} disabled={running} />
        )
      }
    />
  );
}

/** The user's input before Core echoed it: sending, or not delivered with a resend button. */
export function OptimisticRow({
  row,
}: {
  readonly row: Extract<TranscriptRow, { kind: 'optimistic' }>;
}) {
  const t = useT();
  const { actions } = useTranscriptView();
  return (
    <UserBubble id={row.id} input={row.input} state={row.state}>
      {row.state === 'undelivered' ? (
        <div className="row-status is-danger" role="alert" data-testid="undelivered">
          <span>{t('transcript.user.undelivered', { reason: row.failure ?? '' })}</span>
          <button
            type="button"
            className="row-action"
            data-testid="resend"
            onClick={() => {
              actions.resend(row.clientId);
            }}
          >
            {t('transcript.user.resend')}
          </button>
        </div>
      ) : row.turnId === undefined ? (
        <div className="row-status muted" data-testid="sending">
          {t('transcript.user.sending')}
        </div>
      ) : null}
    </UserBubble>
  );
}

function UserBubble({
  id,
  input,
  state,
  children,
  extra,
  branches,
}: {
  readonly id: string;
  readonly input: ShownInput;
  readonly state?: 'sending' | 'undelivered';
  readonly children?: ReactNode;
  /** More actions after copy and select (rewind, branch). */
  readonly extra?: ReactNode;
  /** The branch switcher, shown at all times. */
  readonly branches?: ReactNode;
}) {
  const { openFile } = useTranscriptView().actions;
  const t = useT();
  const list = useListActions();
  return (
    <div
      className={`row row-user${state === undefined ? '' : ` is-${state}`}`}
      data-testid="user-row"
      data-row-id={id}
      data-state={state}
    >
      <div className="row-user-bubble" data-testid="user-message" data-state={state}>
        <div className="row-user-text">
          <MentionText text={input.text} mentions={input.mentions} onOpen={openFile} />
        </div>
        <AttachmentChips attachments={input.attachments} />
      </div>
      {children}
      <div className="row-actions is-hover" data-testid="user-actions">
        <CopyButton label={t('transcript.copyText')} text={() => input.text} />
        <button
          type="button"
          className="row-action"
          data-testid="select-turn"
          onClick={() => {
            list.selectExchange(id);
          }}
        >
          {t('transcript.selectTurn')}
        </button>
        {extra}
      </div>
      {branches}
    </div>
  );
}

/** The agent's reply. */
export function AgentMessageRow({
  id,
  item,
}: {
  readonly id: string;
  readonly item: AgentMessageItem;
}) {
  const t = useT();
  const { services, transcript } = useTranscriptView();
  const list = useListActions();
  const docKey = transcript.cacheKey(id);
  const parsed = useParsedDoc(docKey);
  useRowCommitted();
  const complete = item.status !== 'inProgress';
  const streamed = services.driver.streams(docKey);
  useEffect(() => {
    if (complete && !streamed) {
      services.markdown.parseFinished(docKey, item.text);
    }
  }, [services, docKey, item.text, complete, streamed]);
  let body;
  if (parsed !== undefined) {
    body = <MarkdownView blocks={parsed.blocks} />;
  } else if (!streamed) {
    // Until the worker answers, a finished message shows as plain text of about the right size.
    body = <p className="md-fallback">{item.text}</p>;
  } else {
    body = null;
  }
  return (
    <article
      className={`row row-agent is-${item.status}`}
      data-testid="agent-message"
      data-row-id={id}
      data-parsed={parsed === undefined ? 'none' : parsed.final ? 'final' : 'partial'}
      aria-label={t('conversation.agent')}
      aria-busy={!complete}
    >
      {body}
      {complete && parsed?.final === true ? (
        <div className="row-actions is-hover" data-testid="message-actions">
          <CopyButton label={t('transcript.copyMarkdown')} text={() => item.text} />
          <CopyButton label={t('transcript.copyText')} text={() => blocksText(parsed.blocks)} />
          <button
            type="button"
            className="row-action"
            data-testid="select-turn"
            onClick={() => {
              list.selectExchange(id);
            }}
          >
            {t('transcript.selectTurn')}
          </button>
        </div>
      ) : null}
    </article>
  );
}

/** Thinking: open and not collapsible while it is generated; folded when it is done. */
export function ThinkingRow({
  id,
  item,
  startedAt,
  endedAt,
}: {
  readonly id: string;
  readonly item: ReasoningItem;
  readonly startedAt: number | undefined;
  readonly endedAt: number | undefined;
}) {
  const t = useT();
  const live = item.status === 'inProgress';
  // Folded once done unless the user opens it; the user cannot fold it while it is generated.
  const [chosen, setExpanded] = useExpanded(id, false);
  const expanded = live || chosen;
  const seconds =
    startedAt !== undefined && endedAt !== undefined
      ? Math.max(1, Math.round((endedAt - startedAt) / 1000))
      : undefined;
  const label = live
    ? t('transcript.thinking.live')
    : seconds === undefined
      ? t('transcript.thinking.doneUnknown')
      : t('transcript.thinking.done', { seconds });
  return (
    <div
      className={`row row-thinking${expanded ? ' is-expanded' : ''}`}
      data-testid="thinking-block"
      data-row-id={id}
      data-live={live}
      data-expanded={expanded}
    >
      <button
        type="button"
        className="row-disclosure"
        aria-expanded={expanded}
        aria-disabled={live}
        data-testid="thinking-toggle"
        onClick={() => {
          // While the model thinks the block stays open: the toggle does nothing.
          if (!live) {
            setExpanded(!chosen);
          }
        }}
      >
        <span className="row-disclosure-mark" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span data-testid="thinking-label">{label}</span>
      </button>
      {expanded ? (
        <div className="row-thinking-text" data-testid="thinking-text">
          {item.text}
        </div>
      ) : null}
    </div>
  );
}
