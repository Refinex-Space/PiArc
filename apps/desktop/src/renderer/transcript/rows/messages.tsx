// The message rows (architecture section 8.2): the user's input with its mention and attachment
// chips, the agent's reply (Markdown from the worker, raw HTML as text), and the thinking block
// (open and not collapsible while it is generated, then folded to "thought for N seconds").
// The user's bubble folds a long message; both rows keep their actions as icon buttons that
// show on hover or keyboard focus (ADR-0078).
import type { Item } from '@piarc/protocol';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useT } from '../../app/app-context.js';
import { IconButton } from '../../app/IconButton.js';
import { chipOf, type ShownInput, type TranscriptRow } from '../../store/transcript.js';
import { blocksText } from '../copy.js';
import { MarkdownView } from '../markdown/MarkdownView.js';
import { BranchSwitcher } from '../../changes/BranchSwitcher.js';
import {
  BranchGlyph,
  CaretDownGlyph,
  CaretUpGlyph,
  PlainTextGlyph,
  RewindGlyph,
  SelectTurnGlyph,
} from '../../shell/icons.js';
import {
  useBranchPoint,
  useEndsTurn,
  useExpanded,
  useParsedDoc,
  useTranscriptView,
  useTurn,
} from '../services.js';
import { AttachmentChips, MentionText, MessageTime } from './common.js';
import { useListActions, useRowCommitted } from './list-actions.js';
import { CopyIconButton, StepRow } from './parts.js';

type AgentMessageItem = Extract<Item, { type: 'agentMessage' }>;
type ReasoningItem = Extract<Item, { type: 'reasoning' }>;
type UserMessageItem = Extract<Item, { type: 'userMessage' }>;

/**
 * A user message longer than this many lines folds (to the lines `transcript.css` shows): counted
 * in lines, so the same paste folds alike in every language and density.
 */
const FOLD_ABOVE_LINES = 12;

/** A user message from Core; the first of a turn can be rewound to and branched from (T28). */
export function UserMessageRow({
  id,
  item,
  turnId,
  at,
}: {
  readonly id: string;
  readonly item: UserMessageItem;
  readonly turnId: string | undefined;
  /** When it was sent (ms since the epoch), when known. */
  readonly at?: number | undefined;
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
      at={at}
      input={{
        text: item.text,
        mentions: item.mentions ?? [],
        attachments: (item.attachments ?? []).flatMap(chipOf),
      }}
      extra={
        <>
          {start && rewind !== undefined ? (
            <IconButton
              label={t('transcript.rewind')}
              size="xs"
              data-testid="rewind-here"
              disabled={running}
              onClick={() => {
                rewind(turnId, item.text);
              }}
            >
              <RewindGlyph />
            </IconButton>
          ) : null}
          {start && branchFrom !== undefined ? (
            <IconButton
              label={t('transcript.branchFrom')}
              size="xs"
              data-testid="branch-from-here"
              onClick={() => {
                branchFrom(turnId, item.text);
              }}
            >
              <BranchGlyph />
            </IconButton>
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
            className="row-link"
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
  at,
  input,
  state,
  children,
  extra,
  branches,
}: {
  readonly id: string;
  /** When it was sent, shown first in its actions. */
  readonly at?: number | undefined;
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
  // A long message folds to a fixed height with a fade; the reader opens it in place.
  const body = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useExpanded(`more:${id}`, false);
  useEffect(() => {
    const element = body.current;
    if (element === null) return;
    const measure = () => {
      const view = element.ownerDocument.defaultView ?? window;
      const line = Number.parseFloat(view.getComputedStyle(element).lineHeight) || 20;
      setTall(element.scrollHeight > FOLD_ABOVE_LINES * line + 1);
    };
    const Observer = (element.ownerDocument.defaultView ?? window).ResizeObserver;
    // Read after layout, with every other row's reads, instead of forcing a layout per row.
    if (typeof Observer !== 'function') {
      measure();
      return;
    }
    const observer = new Observer(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [input.text]);
  const folded = tall && !open;
  return (
    <div
      className={`row row-user${state === undefined ? '' : ` is-${state}`}`}
      data-testid="user-row"
      data-row-id={id}
      data-state={state}
    >
      <AttachmentChips attachments={input.attachments} />
      <div className="row-user-bubble" data-testid="user-message" data-state={state}>
        <div ref={body} className="row-user-text" data-folded={folded}>
          <MentionText text={input.text} mentions={input.mentions} onOpen={openFile} />
        </div>
        {tall ? (
          <button
            type="button"
            className="row-user-more"
            aria-expanded={open}
            data-testid="user-message-more"
            onClick={() => {
              setOpen(!open);
            }}
          >
            {t(open ? 'transcript.user.showLess' : 'transcript.user.showMore')}
            {open ? <CaretUpGlyph size={12} /> : <CaretDownGlyph size={12} />}
          </button>
        ) : null}
      </div>
      {children}
      <div
        className="row-actions reveal-actions"
        data-testid="user-actions"
        data-tooltip-side="below"
      >
        {at === undefined ? null : <MessageTime at={at} />}
        <CopyIconButton label={t('transcript.copyText')} text={() => input.text} />
        <IconButton
          label={t('transcript.selectTurn')}
          size="xs"
          data-testid="select-turn"
          onClick={() => {
            list.selectExchange(id);
          }}
        >
          <SelectTurnGlyph />
        </IconButton>
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
  at,
}: {
  readonly id: string;
  readonly item: AgentMessageItem;
  /** When it was written (ms since the epoch), when known; shown last in the turn's actions. */
  readonly at?: number | undefined;
}) {
  const t = useT();
  const { services, transcript } = useTranscriptView();
  const list = useListActions();
  const docKey = transcript.cacheKey(id);
  const parsed = useParsedDoc(docKey);
  // Only the turn's last reply carries the actions, like the turn's footer.
  const endsTurn = useEndsTurn(id);
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
      {complete && parsed?.final === true && endsTurn ? (
        <div
          className="row-actions reveal-actions"
          data-testid="message-actions"
          data-tooltip-side="below"
        >
          <CopyIconButton label={t('transcript.copyMarkdown')} text={() => item.text} />
          <CopyIconButton
            label={t('transcript.copyText')}
            text={() => blocksText(parsed.blocks)}
            glyph={<PlainTextGlyph />}
          />
          <IconButton
            label={t('transcript.selectTurn')}
            size="xs"
            data-testid="select-turn"
            onClick={() => {
              list.selectExchange(id);
            }}
          >
            <SelectTurnGlyph />
          </IconButton>
          {at === undefined ? null : <MessageTime at={at} />}
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
  // Folded unless the user opens it, also while it is generated: its label says it is thinking.
  const [expanded, setExpanded] = useExpanded(id, false);
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
      className="row row-thinking"
      data-testid="thinking-block"
      data-row-id={id}
      data-live={live}
      data-expanded={expanded}
    >
      <StepRow
        verb={<span data-testid="thinking-label">{label}</span>}
        state={live ? 'busy' : 'done'}
        expanded={expanded}
        lineTestId="thinking-toggle"
        onToggle={() => {
          setExpanded(!expanded);
        }}
      >
        <div className="row-thinking-text" data-testid="thinking-text">
          {item.text}
        </div>
      </StepRow>
    </div>
  );
}
