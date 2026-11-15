// Synthetic session events for the transcript prototype (T09). Everything is expressed with the
// protocol's notification types, so T19 can feed real Core events into the same store.
//
// - `approximateTokens` cuts text into pieces about the size of model tokens;
// - `planTurn` turns messages into a timed schedule at a given token rate, merged into one
//   delta per `CORE_MERGE_INTERVAL_MS` the way Core merges deltas (architecture section 8.4);
// - `StreamReplayer` plays a schedule in real time;
// - `generateHistory` builds a long completed history (agent messages and tool calls).
import type {
  Item,
  ItemAgentMessageDeltaNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
} from '@piarc/protocol';

import type { TranscriptNotification } from '../../transcript/item-store.js';
import { CORPUS, longCodeBlock, mixedReply } from './corpus.js';

export type { TranscriptNotification };

/** Core merges text deltas over about one frame (architecture section 8.4). */
export const CORE_MERGE_INTERVAL_MS = 16;

/**
 * Pieces of about one model token each: an English word part of up to six letters with its
 * leading space, a group of up to three digits, one CJK character, up to two other symbols, or
 * a run of whitespace. English prose comes out at roughly four characters per piece.
 */
export function approximateTokens(text: string): string[] {
  const cjk = '\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af\\uff00-\\uffef';
  const pattern = new RegExp(
    `[ \\t]*[A-Za-z]{1,6}|[ \\t]*\\d{1,3}|[${cjk}]|[ \\t]*[^\\sA-Za-z\\d${cjk}]{1,2}|\\s+`,
    'gu',
  );
  return text.match(pattern) ?? [];
}

/** Allocates `seq` and `ts` for one session's notifications. */
export class FixtureSession {
  private seq = 0;

  constructor(
    readonly sessionId: string,
    private readonly now: () => number = Date.now,
  ) {}

  header(): { seq: number; sessionId: string; ts: number } {
    this.seq += 1;
    return { seq: this.seq, sessionId: this.sessionId, ts: this.now() };
  }
}

/** One scheduled delivery: the notifications Core would send in one batch. */
export interface ScheduledBatch {
  /** Milliseconds after the start of the turn. */
  readonly atMs: number;
  readonly notifications: readonly TranscriptNotification[];
}

export interface TurnPlan {
  readonly turnId: string;
  /** The agent messages of the turn, in order; each gets its own item. */
  readonly messages: readonly string[];
  readonly tokensPerSecond: number;
}

function itemNotification(
  method: 'item/started' | 'item/completed',
  session: FixtureSession,
  turnId: string,
  item: Item,
): ItemStartedNotification | ItemCompletedNotification {
  const params = { ...session.header(), turnId, item };
  return method === 'item/started'
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', method, params };
}

/**
 * The batches of one turn: `turn/started`, then for each message `item/started`, one
 * `item/agentMessage/delta` per merge interval carrying the tokens produced in it at
 * `tokensPerSecond`, and `item/completed`; finally `turn/completed`.
 */
export function planTurn(session: FixtureSession, plan: TurnPlan): ScheduledBatch[] {
  if (!(plan.tokensPerSecond > 0)) {
    throw new RangeError('tokensPerSecond must be positive');
  }
  const { turnId } = plan;
  const msPerToken = 1000 / plan.tokensPerSecond;
  const batches: ScheduledBatch[] = [
    {
      atMs: 0,
      notifications: [
        { jsonrpc: '2.0', method: 'turn/started', params: { ...session.header(), turnId } },
      ],
    },
  ];
  let clock = 0;
  plan.messages.forEach((text, index) => {
    const itemId = `${turnId}-msg-${String(index + 1)}`;
    batches.push({
      atMs: clock,
      notifications: [
        itemNotification('item/started', session, turnId, {
          type: 'agentMessage',
          itemId,
          status: 'inProgress',
          text: '',
        }),
      ],
    });
    let pending = '';
    let tickEnd = clock + CORE_MERGE_INTERVAL_MS;
    const flush = (atMs: number): void => {
      if (pending === '') {
        return;
      }
      const delta: ItemAgentMessageDeltaNotification = {
        jsonrpc: '2.0',
        method: 'item/agentMessage/delta',
        params: { ...session.header(), turnId, itemId, delta: pending },
      };
      batches.push({ atMs, notifications: [delta] });
      pending = '';
    };
    for (const token of approximateTokens(text)) {
      clock += msPerToken;
      while (clock > tickEnd) {
        flush(tickEnd);
        tickEnd += CORE_MERGE_INTERVAL_MS;
      }
      pending += token;
    }
    flush(tickEnd);
    clock = tickEnd;
    batches.push({
      atMs: clock,
      notifications: [
        itemNotification('item/completed', session, turnId, {
          type: 'agentMessage',
          itemId,
          status: 'completed',
          text,
        }),
      ],
    });
  });
  batches.push({
    atMs: clock,
    notifications: [
      {
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { ...session.header(), turnId, status: 'completed' },
      },
    ],
  });
  return batches;
}

/** Messages totalling at least `minTokens` tokens, cycling through realistic replies. */
export function messagesForTokens(minTokens: number): string[] {
  const pool = [mixedReply(), longCodeBlock(160), mixedReply()];
  const messages: string[] = [];
  let tokens = 0;
  for (let index = 0; tokens < minTokens; index += 1) {
    const message = pool[index % pool.length] ?? '';
    messages.push(message);
    tokens += approximateTokens(message).length;
  }
  return messages;
}

/** Receives one batch of notifications. */
export type NotificationSink = (notifications: readonly TranscriptNotification[]) => void;

/** Plays scheduled batches in real time; batches that fall due together are merged. */
export class StreamReplayer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private finished: (() => void) | undefined;

  constructor(private readonly sink: NotificationSink) {}

  /** Resolves when every batch was delivered, or when `stop()` is called. */
  play(batches: readonly ScheduledBatch[]): Promise<void> {
    this.stop();
    return new Promise<void>((resolve) => {
      this.finished = resolve;
      const start = performance.now();
      let next = 0;
      const tick = (): void => {
        const elapsed = performance.now() - start;
        const due: TranscriptNotification[] = [];
        while (next < batches.length && (batches[next]?.atMs ?? Infinity) <= elapsed) {
          due.push(...(batches[next]?.notifications ?? []));
          next += 1;
        }
        if (due.length > 0) {
          this.sink(due);
        }
        const upcoming = batches[next];
        if (upcoming === undefined) {
          this.timer = undefined;
          this.finish();
          return;
        }
        this.timer = setTimeout(tick, Math.max(0, upcoming.atMs - (performance.now() - start)));
      };
      tick();
    });
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.finish();
  }

  private finish(): void {
    const finished = this.finished;
    this.finished = undefined;
    finished?.();
  }
}

/** mulberry32: a small deterministic PRNG, so a seed always gives the same history. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Documents the history leaves out: the long block, the unclosed markup and the payloads. */
const NOT_IN_HISTORY = new Set(['long-code', 'unclosed', 'xss']);

/** Short reply fragments the history mixes. */
function historyFragments(): string[] {
  const sources = CORPUS.filter((document) => !NOT_IN_HISTORY.has(document.id));
  return sources.flatMap((document) =>
    document.markdown
      .split(/\n{2,}(?=[^\s`])/u)
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
}

const TOOL_NAMES = ['read', 'grep', 'bash', 'edit'] as const;

export interface HistoryOptions {
  readonly count: number;
  readonly seed: number;
  readonly session: FixtureSession;
}

/**
 * `count` completed items as `item/completed` notifications: about four agent messages of one
 * to four fragments for every tool call. The same seed always yields the same history.
 */
export function generateHistory(options: HistoryOptions): ItemCompletedNotification[] {
  const random = seededRandom(options.seed);
  const fragments = historyFragments();
  const pick = <T>(values: readonly T[]): T => {
    const value = values[Math.floor(random() * values.length)];
    if (value === undefined) {
      throw new Error('empty choice');
    }
    return value;
  };
  const notifications: ItemCompletedNotification[] = [];
  for (let index = 0; index < options.count; index += 1) {
    const turnId = `history-turn-${String(Math.floor(index / 5) + 1)}`;
    const itemId = `history-${String(index + 1)}`;
    let item: Item;
    if (random() < 0.2) {
      const tool = pick(TOOL_NAMES);
      item = {
        type: 'dynamicToolCall',
        itemId,
        status: 'completed',
        tool,
        arguments: { path: `src/module-${String(index % 97)}.ts` },
        output: `${tool} finished: ${String(Math.floor(random() * 400))} lines`,
      };
    } else {
      const parts: string[] = [];
      const fragmentCount = 1 + Math.floor(random() * 4);
      for (let part = 0; part < fragmentCount; part += 1) {
        parts.push(pick(fragments));
      }
      item = {
        type: 'agentMessage',
        itemId,
        status: 'completed',
        text: `Reply ${String(index + 1)}.\n\n${parts.join('\n\n')}\n`,
      };
    }
    notifications.push({
      jsonrpc: '2.0',
      method: 'item/completed',
      params: { ...options.session.header(), turnId, item },
    });
  }
  return notifications;
}
