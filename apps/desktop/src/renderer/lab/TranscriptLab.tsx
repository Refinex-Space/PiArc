// The transcript prototype page (`#/transcript-lab`, T09): the transcript and the composer driven
// by synthetic protocol events instead of Core. L4 tests and the S1 benchmark drive it through
// `window.__piarcTranscriptLab`; the toolbar does the same by hand.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type {
  ComposerActionRecord,
  FrameRecording,
  TranscriptLabApi,
} from '../../shared/transcript-lab.js';
import { Composer, type ComposerHandlers, type MentionSource } from '../composer/Composer.js';
import { matchCandidates } from '../composer/mention-plugin.js';
import { SessionTranscript } from '../store/transcript.js';
import { SCROLL_FOLLOW } from '../transcript/constants.js';
import type { ScrollFollow } from '../transcript/scroll-follow.js';
import { distanceFromBottom } from '../transcript/scroll-follow.js';
import {
  TranscriptContext,
  createTranscriptServices,
  type TranscriptServices,
  type TranscriptView,
} from '../transcript/services.js';
import { Transcript } from '../transcript/Transcript.js';
import { MENTION_CANDIDATES } from './fixtures/mention-candidates.js';
import {
  FixtureSession,
  StreamReplayer,
  approximateTokens,
  generateHistory,
  messagesForTokens,
  planTurn,
  type TranscriptNotification,
} from './fixtures/synthesizer.js';
import { xssMessage } from '../../shared/xss-payloads.js';

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/** Resolves after the next frame was painted (a task queued from its animation frame). */
async function paintedFrame(): Promise<void> {
  await nextFrame();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const started = performance.now();
  while (!condition()) {
    if (performance.now() - started > timeoutMs) {
      throw new Error(`Timed out after ${String(timeoutMs)} ms waiting for ${what}`);
    }
    await nextFrame();
  }
}

/** Messages that stream for exactly `seconds` at `tokensPerSecond`. */
function messagesForDuration(tokensPerSecond: number, seconds: number): string[] {
  let remaining = Math.round(tokensPerSecond * seconds);
  const messages: string[] = [];
  for (const message of messagesForTokens(remaining)) {
    const tokens = approximateTokens(message);
    messages.push(tokens.slice(0, remaining).join(''));
    remaining -= Math.min(remaining, tokens.length);
    if (remaining === 0) {
      break;
    }
  }
  return messages;
}

class FrameRecorder {
  private intervals: number[] = [];
  private longTasks: number[] = [];
  private longFrames: number[] = [];
  private observers: PerformanceObserver[] = [];
  private frame: number | null = null;
  private last: number | null = null;
  private started = 0;

  start(): void {
    this.stop();
    this.intervals = [];
    this.longTasks = [];
    this.longFrames = [];
    this.started = performance.now();
    for (const [type, sink] of [
      ['longtask', this.longTasks],
      ['long-animation-frame', this.longFrames],
    ] as const) {
      if (PerformanceObserver.supportedEntryTypes.includes(type)) {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            sink.push(entry.duration);
          }
        });
        observer.observe({ type, buffered: false });
        this.observers.push(observer);
      }
    }
    const tick = (now: number): void => {
      if (this.last !== null) {
        this.intervals.push(now - this.last);
      }
      this.last = now;
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop(): FrameRecording {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
    }
    this.frame = null;
    this.last = null;
    for (const observer of this.observers) {
      for (const entry of observer.takeRecords()) {
        (entry.entryType === 'longtask' ? this.longTasks : this.longFrames).push(entry.duration);
      }
      observer.disconnect();
    }
    this.observers = [];
    return {
      intervals: this.intervals,
      longTasks: this.longTasks,
      longAnimationFrames: this.longFrames,
      durationMs: performance.now() - this.started,
    };
  }
}

/** Every code block of a row is either highlighted or plain text, not waiting. */
function codeSettled(itemId: string): boolean {
  const row = document.querySelector(
    `[data-testid="agent-message"][data-row-id="${CSS.escape(itemId)}"]`,
  );
  if (row === null) {
    return true;
  }
  return row.querySelector('[data-testid="code-block"][data-highlight="pending"]') === null;
}

function createLabApi(
  services: TranscriptServices,
  store: { current: SessionTranscript; replace: () => void },
  counts: Map<string, number>,
  actions: ComposerActionRecord[],
  scrollRef: { follow: ScrollFollow | null; scroller: HTMLElement | null },
): TranscriptLabApi {
  const { markdown } = services;
  const session = new FixtureSession('lab-session');
  const replayer = new StreamReplayer((notifications) => {
    store.current.apply(notifications);
  });
  const recorder = new FrameRecorder();
  let turns = 0;
  let messages = 0;
  let runningTurn: string | null = null;

  const apply = (notifications: readonly TranscriptNotification[]): void => {
    store.current.apply(notifications);
  };
  const scroller = (): HTMLElement => {
    if (scrollRef.scroller === null) {
      throw new Error('The transcript has no scroll element yet');
    }
    return scrollRef.scroller;
  };
  const visibleRowsParsed = (): { ready: boolean; rows: number } => {
    const viewport = scroller().getBoundingClientRect();
    const rows = [...scroller().querySelectorAll<HTMLElement>('.transcript-row')].filter((row) => {
      const box = row.getBoundingClientRect();
      return box.bottom > viewport.top && box.top < viewport.bottom;
    });
    const ready =
      rows.length > 0 &&
      rows.every((row) => {
        const message = row.querySelector('[data-testid="agent-message"]');
        return message === null || message.getAttribute('data-parsed') === 'final';
      });
    return { ready, rows: rows.length };
  };

  return {
    setApprovals(requests) {
      store.current.setApprovals(requests);
    },
    clear() {
      replayer.stop();
      services.driver.reset();
      store.replace();
      counts.clear();
    },
    async loadHistory(count, seed = 1) {
      const history = generateHistory({ count, seed, session });
      const started = performance.now();
      apply(history);
      await waitFor(() => visibleRowsParsed().ready, 10_000, 'the visible rows to render');
      await paintedFrame();
      return {
        readyToVisibleMs: performance.now() - started,
        visibleRows: visibleRowsParsed().rows,
      };
    },
    async streamTurn({ tokensPerSecond, seconds, messages: given }) {
      turns += 1;
      const turnId = `lab-turn-${String(turns)}`;
      const texts = given ?? messagesForDuration(tokensPerSecond, seconds ?? 10);
      await replayer.play(planTurn(session, { turnId, messages: texts, tokensPerSecond }));
      const itemIds = texts.map((_, index) => `${turnId}-msg-${String(index + 1)}`);
      await waitFor(
        () => itemIds.every((id) => markdown.get(store.current.cacheKey(id))?.final === true),
        10_000,
        'the streamed messages to finish',
      );
      return { itemIds };
    },
    async addMessage(text) {
      messages += 1;
      const itemId = `lab-message-${String(messages)}`;
      apply([
        {
          jsonrpc: '2.0',
          method: 'item/completed',
          params: {
            ...session.header(),
            turnId: 'lab-messages',
            item: { type: 'agentMessage', itemId, status: 'completed', text },
          },
        },
      ]);
      await waitFor(
        () => markdown.get(store.current.cacheKey(itemId))?.final === true,
        10_000,
        `${itemId} to parse`,
      );
      return itemId;
    },
    setRunning(running) {
      if (running && runningTurn === null) {
        turns += 1;
        runningTurn = `lab-turn-${String(turns)}`;
        apply([
          {
            jsonrpc: '2.0',
            method: 'turn/started',
            params: { ...session.header(), turnId: runningTurn },
          },
        ]);
      } else if (!running && runningTurn !== null) {
        apply([
          {
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: { ...session.header(), turnId: runningTurn, status: 'completed' },
          },
        ]);
        runningTurn = null;
      }
    },
    async settled(itemId) {
      await waitFor(
        () => markdown.get(store.current.cacheKey(itemId))?.final === true && codeSettled(itemId),
        15_000,
        `${itemId} to settle`,
      );
    },
    startFrames() {
      recorder.start();
    },
    stopFrames() {
      return recorder.stop();
    },
    async autoScroll({ pxPerSecond, durationMs, direction }) {
      // Relative steps, like wheel input: rows measured above the viewport may shift the
      // position, and an absolute target would fight those corrections.
      const element = scroller();
      const sign = direction === 'up' ? -1 : 1;
      let distancePx = 0;
      const began = await nextFrame();
      let last = began;
      while (last - began < durationMs) {
        const now = await nextFrame();
        const step = (pxPerSecond * (now - last)) / 1000;
        element.scrollBy({ top: sign * step, behavior: 'instant' });
        distancePx += step;
        last = now;
      }
      return { distancePx };
    },
    renderCounts() {
      return Object.fromEntries(counts);
    },
    resetRenderCounts() {
      counts.clear();
    },
    scroll() {
      const element = scroller();
      const metrics = {
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
      return {
        following: scrollRef.follow?.state.following ?? true,
        showButton: scrollRef.follow?.state.showButton ?? false,
        ...metrics,
        distanceFromBottom: distanceFromBottom(metrics),
      };
    },
    scrollThresholds() {
      return { ...SCROLL_FOLLOW };
    },
    actions() {
      return [...actions];
    },
    clearActions() {
      actions.length = 0;
    },
    mountedRowIds() {
      return [...scroller().querySelectorAll<HTMLElement>('.transcript-row')]
        .map((row) => row.dataset.rowId ?? '')
        .filter((id) => id !== '');
    },
  };
}

/** The fixed candidates of the prototype page, filtered like Core's search would. */
const LAB_MENTIONS: MentionSource = {
  search: (query) => Promise.resolve(matchCandidates(MENTION_CANDIDATES, query)),
  cancel: () => undefined,
};

const LAB_COMMANDS = [
  { name: 'clear', description: '', source: 'builtin', action: 'newSession' },
  { name: 'compact', description: '', source: 'builtin', action: 'compact' },
  { name: 'help', description: '', source: 'builtin', action: 'help' },
];

export function TranscriptLab() {
  const counts = useRef(new Map<string, number>()).current;
  const actions = useRef<ComposerActionRecord[]>([]).current;
  const scrollRef = useRef<{ follow: ScrollFollow | null; scroller: HTMLElement | null }>({
    follow: null,
    scroller: null,
  }).current;
  const [services] = useState(() =>
    createTranscriptServices({
      note: (id) => {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      },
    }),
  );
  const [transcript, setTranscript] = useState(() => new SessionTranscript());
  const store = useRef({
    current: transcript,
    replace: (): void => undefined,
  }).current;
  store.current = transcript;
  store.replace = () => {
    const next = new SessionTranscript();
    store.current = next;
    setTranscript(next);
  };
  useEffect(() => services.driver.follow(transcript), [services, transcript]);
  const api = useMemo(() => {
    const created = createLabApi(services, store, counts, actions, scrollRef);
    globalThis.__piarcTranscriptLab = created;
    return created;
  }, [services, store, counts, actions, scrollRef]);
  const running = useSyncExternalStore(
    useCallback((listener: () => void) => transcript.subscribeState(listener), [transcript]),
    useCallback(() => transcript.isRunning(), [transcript]),
  );
  const onFollow = useCallback(
    (follow: ScrollFollow, scroller: HTMLElement | null) => {
      scrollRef.follow = follow;
      scrollRef.scroller = scroller;
    },
    [scrollRef],
  );
  const clientIds = useRef(0);
  const handlers = useMemo<ComposerHandlers>(
    () => ({
      submit(intent, payload) {
        actions.push({
          kind: intent,
          text: payload.text,
          mentions: payload.mentions.map((mention) => mention.path),
        });
        clientIds.current += 1;
        store.current.addOptimistic(String(clientIds.current), {
          text: payload.text,
          mentions: payload.spans,
          attachments: [],
        });
      },
      stop() {
        actions.push({ kind: 'stop' });
      },
      command() {
        actions.push({ kind: 'command' });
      },
      mentionOpened() {
        actions.push({ kind: 'mentionOpened' });
      },
      mentionChosen(mention) {
        actions.push({ kind: 'mentionChosen', path: mention.path });
      },
    }),
    [actions, store],
  );
  const view = useMemo<TranscriptView>(
    () => ({
      services,
      transcript,
      actions: { retry: () => undefined, resend: () => undefined },
    }),
    [services, transcript],
  );
  const run = (task: Promise<unknown>): void => {
    task.catch((error: unknown) => {
      console.error('[transcript lab]', error);
    });
  };
  return (
    <TranscriptContext.Provider value={view}>
      <div className="lab" data-testid="transcript-lab">
        <header className="lab-toolbar">
          <span className="lab-title">Transcript prototype</span>
          <button
            type="button"
            onClick={() => {
              run(api.streamTurn({ tokensPerSecond: 100, seconds: 20 }));
            }}
          >
            Stream 20 s
          </button>
          <button
            type="button"
            onClick={() => {
              run(api.loadHistory(1_000));
            }}
          >
            Load 1,000
          </button>
          <button
            type="button"
            onClick={() => {
              run(api.loadHistory(10_000));
            }}
          >
            Load 10,000
          </button>
          <button
            type="button"
            onClick={() => {
              run(api.addMessage(xssMessage()));
            }}
          >
            XSS payloads
          </button>
          <button
            type="button"
            onClick={() => {
              api.setRunning(!running);
            }}
          >
            {running ? 'Set idle' : 'Set running'}
          </button>
          <button
            type="button"
            onClick={() => {
              api.clear();
            }}
          >
            Clear
          </button>
        </header>
        <Transcript onFollow={onFollow} />
        <Composer
          running={running}
          handlers={handlers}
          mentions={LAB_MENTIONS}
          commands={LAB_COMMANDS}
          limits={undefined}
        />
      </div>
    </TranscriptContext.Provider>
  );
}
