// The conversation's live region (T43, architecture section 8.7): while a turn runs, what the
// agent is doing ("Running Read · notes.txt", "Writing the reply: 120 words so far") at most once
// per `LIVE_ANNOUNCE.intervalMs`; when the turn ends, its result once ("Reply: …" or the error).
// Polite and atomic; the transcript itself is a feed that does not announce (`TranscriptList`).
import type { Item } from '@piarc/protocol';
import { useEffect, useRef, useState } from 'react';

import { useT } from '../app/app-context.js';
import type { MessageId } from '../../shared/i18n/index.js';
import type { SessionTranscript, TranscriptRow, TurnInfo } from '../store/transcript.js';
import { LIVE_ANNOUNCE } from './constants.js';
import { ThrottledAnnouncer, type AnnouncerClock } from './live-announcer.js';
import { ERROR_TITLE } from './rows/status.js';
import { targetOf } from './rows/summary.js';
import { useShownRowIds, useTranscriptRow, useTranscriptView, useTurn } from './services.js';

type Translate = (id: MessageId, values?: Record<string, string | number>) => string;

function words(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length;
}

function excerpt(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > LIVE_ANNOUNCE.excerptChars
    ? `${line.slice(0, LIVE_ANNOUNCE.excerptChars - 1)}…`
    : line;
}

/** What the running turn is doing. */
export function progressText(
  turn: TurnInfo,
  transcript: SessionTranscript,
  reply: TranscriptRow | undefined,
  t: Translate,
): string {
  if (turn.compacting) return t('transcript.working.compacting');
  const currentId = turn.openTools.at(-1);
  const current = currentId === undefined ? undefined : transcript.row(currentId);
  if (current?.kind === 'item') {
    const item: Item = current.item;
    return t('a11y.live.tool', {
      tool: 'tool' in item ? item.tool : item.type,
      target: targetOf(item),
    });
  }
  if (
    reply?.kind === 'item' &&
    reply.item.type === 'agentMessage' &&
    reply.item.status === 'inProgress'
  ) {
    return t('a11y.live.writing', { count: words(reply.item.text) });
  }
  return t('transcript.working');
}

/** The result of turn `turnId`: its error, else its last reply. */
export function resultText(
  transcript: SessionTranscript,
  turnId: string | undefined,
  t: Translate,
): string {
  const ids = transcript.rowIds();
  for (let i = ids.length - 1; i >= 0; i--) {
    const row = transcript.row(ids[i] ?? '');
    if (row?.kind === 'error' && row.turnId === turnId) {
      return t('a11y.row.error', { title: t(ERROR_TITLE[row.errorKind]) });
    }
    if (row?.kind === 'item' && row.turnId === turnId && row.item.type === 'agentMessage') {
      return t('a11y.live.reply', { text: excerpt(row.item.text) });
    }
  }
  return t('a11y.live.finished');
}

export function LiveRegion({ clock }: { readonly clock?: AnnouncerClock }) {
  const t = useT();
  const { transcript } = useTranscriptView();
  const turn = useTurn();
  const ids = useShownRowIds();
  // The newest reply: the one being written while the turn runs.
  const replyId = ids.findLast((id) => {
    const row = transcript.row(id);
    return row?.kind === 'item' && row.item.type === 'agentMessage';
  });
  const reply = useTranscriptRow(replyId ?? '');
  const [text, setText] = useState('');
  const announcer = useRef<ThrottledAnnouncer | null>(null);
  announcer.current ??= new ThrottledAnnouncer(setText, clock);
  useEffect(() => () => announcer.current?.dispose(), []);
  const progress = turn.running ? progressText(turn, transcript, reply, t) : undefined;
  useEffect(() => {
    if (progress !== undefined) announcer.current?.progress(progress);
  }, [progress]);
  // The turn that was running; its end announces its result.
  const running = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (turn.running) {
      running.current = turn.turnId;
    } else if (running.current !== undefined) {
      const ended = running.current;
      running.current = undefined;
      announcer.current?.result(resultText(transcript, ended, t));
    }
  }, [turn.running, turn.turnId, transcript, t]);
  return (
    <div
      className="visually-hidden"
      aria-live="polite"
      aria-atomic="true"
      data-testid="live-region"
    >
      {text}
    </div>
  );
}
