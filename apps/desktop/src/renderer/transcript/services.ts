// The transcript's collaborators. The services (Markdown and highlight workers, the streaming
// driver, measured row heights, which rows are expanded) are created once per window and shared by
// every session shown in it, so a session shown again finds its parsed messages and row heights
// (architecture section 11: switching to a cached session). The view adds the session's
// transcript and what the rows' buttons do.
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';

import type { ProjectFileLinks } from '../files/navigation.js';
import type { BranchPoint } from '@piarc/protocol';
import type { SessionTranscript, TranscriptRow, TurnInfo } from '../store/transcript.js';
import { HighlightClient } from './highlight/highlight-client.js';
import { MarkdownClient, type ParsedDoc } from './markdown/markdown-client.js';
import { RowHeights } from './row-heights.js';
import { StreamingDriver } from './streaming-driver.js';
import { shownIn, useDetail } from './detail.js';

/** Counts commits per row; the prototype page and the benchmarks use it to show what re-rendered. */
export interface RenderCounter {
  note(id: string): void;
}

/** Presentation state of the rows: which ones the user expanded (section 8.3, rule 2). */
export class Expansion {
  private readonly open = new Map<string, boolean>();
  private readonly listeners = new Map<string, Set<() => void>>();

  get(id: string, fallback: boolean): boolean {
    return this.open.get(id) ?? fallback;
  }

  set(id: string, expanded: boolean): void {
    this.open.set(id, expanded);
    for (const listener of [...(this.listeners.get(id) ?? [])]) {
      listener();
    }
  }

  subscribe(id: string, listener: () => void): () => void {
    let set = this.listeners.get(id);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(id, set);
    }
    const listeners = set;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(id);
      }
    };
  }
}

export interface TranscriptServices {
  readonly markdown: MarkdownClient;
  readonly highlight: HighlightClient;
  readonly driver: StreamingDriver;
  readonly heights: RowHeights;
  readonly expansion: Expansion;
  readonly renderCounter: RenderCounter | null;
}

/** Empty windows keep the streaming driver, but allocate workers only for their first use. */
export function createTranscriptServices(renderCounter: RenderCounter | null): TranscriptServices {
  let markdownClient: MarkdownClient | undefined;
  let highlightClient: HighlightClient | undefined;
  const markdown = () => {
    markdownClient ??= new MarkdownClient(
      new Worker(new URL('../workers/markdown.worker.ts', import.meta.url), {
        type: 'module',
        name: 'piarc-markdown',
      }),
    );
    return markdownClient;
  };
  return {
    get markdown() {
      return markdown();
    },
    get highlight() {
      highlightClient ??= new HighlightClient(
        new Worker(new URL('../workers/highlight.worker.ts', import.meta.url), {
          type: 'module',
          name: 'piarc-highlight',
        }),
      );
      return highlightClient;
    },
    driver: new StreamingDriver(
      {
        stream: (...args) => {
          markdown().stream(...args);
        },
      },
      window,
    ),
    heights: new RowHeights(),
    expansion: new Expansion(),
    renderCounter,
  };
}

/** What the rows' buttons do; the session view (or the prototype page) decides. */
export interface TranscriptActions {
  readonly openFile?: (path: string, line?: number) => void;
  /** Sends the input of turn `turnId` again (error and uncertain cards). */
  readonly retry: (turnId: string) => void;
  /** Sends an input Core did not take again, with the same idempotency key. */
  readonly resend: (clientId: string) => void;
  /** Opens the rewind dialog at a user message (T28); absent where nothing can be rewound. */
  readonly rewind?: (turnId: string, text: string) => void;
  /** Opens a new session that stops before a user message (T28). */
  readonly branchFrom?: (turnId: string, text: string) => void;
  /** Continues on another branch (T28). */
  readonly switchBranch?: (entryId: string) => void;
  /** A subagent's transcript window as JSON (T31); absent where none can be read. */
  readonly subagentTranscript?: (
    child: string,
    start: number | null,
    limit: number,
  ) => Promise<string>;
  /** Stops a running subagent (T31). */
  readonly stopSubagent?: (child: string) => void;
  /** Opens the settings window's memory page, at `note` when given (T47). */
  readonly openMemory?: (note: string | undefined) => void;
}

/** One session's transcript as a view shows it. */
export interface TranscriptView {
  readonly fileLinks?: ProjectFileLinks;
  readonly services: TranscriptServices;
  readonly transcript: SessionTranscript;
  readonly actions: TranscriptActions;
}

export const TranscriptContext = createContext<TranscriptView | null>(null);

export function useTranscriptView(): TranscriptView {
  const view = useContext(TranscriptContext);
  if (view === null) {
    throw new Error('Transcript components need a TranscriptContext provider');
  }
  return view;
}

/** The services alone. */
export function useTranscriptServices(): TranscriptServices {
  return useTranscriptView().services;
}

/** The row ids the current view shows (`detail.ts`); re-renders when rows are added or removed
 * or the view changes. */
export function useShownRowIds(): readonly string[] {
  const { transcript } = useTranscriptView();
  const detail = useDetail();
  const subscribe = useCallback((l: () => void) => transcript.subscribeList(l), [transcript]);
  const read = useCallback(() => transcript.rowIds(), [transcript]);
  const ids = useSyncExternalStore(subscribe, read);
  return useMemo(
    () => (detail === 'detailed' ? ids : ids.filter((id) => shownIn(transcript.row(id), detail))),
    [ids, detail, transcript],
  );
}

/** One row; re-renders only when that row changes. */
export function useTranscriptRow(id: string): TranscriptRow | undefined {
  const { transcript } = useTranscriptView();
  const subscribe = useCallback(
    (l: () => void) => transcript.subscribeRow(id, l),
    [transcript, id],
  );
  const read = useCallback(() => transcript.row(id), [transcript, id]);
  return useSyncExternalStore(subscribe, read);
}

/** The running turn of the shown transcript (the working row). */
export function useTurn(): TurnInfo {
  const { transcript } = useTranscriptView();
  const subscribe = useCallback((l: () => void) => transcript.subscribeState(l), [transcript]);
  const read = useCallback(() => transcript.turnInfo(), [transcript]);
  return useSyncExternalStore(subscribe, read);
}

/** Several rows (a tool group's calls); re-renders when any of them changes. */
export function useTranscriptRows(ids: readonly string[]): readonly (TranscriptRow | undefined)[] {
  const { transcript } = useTranscriptView();
  const cache = useRef<{
    ids: readonly string[];
    rows: readonly (TranscriptRow | undefined)[];
  } | null>(null);
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = ids.map((id) => transcript.subscribeRow(id, listener));
      return () => {
        for (const stop of stops) {
          stop();
        }
      };
    },
    [transcript, ids],
  );
  const read = useCallback(() => {
    const rows = ids.map((id) => transcript.row(id));
    const previous = cache.current;
    if (
      previous !== null &&
      previous.ids === ids &&
      previous.rows.length === rows.length &&
      previous.rows.every((row, index) => row === rows[index])
    ) {
      return previous.rows;
    }
    cache.current = { ids, rows };
    return rows;
  }, [transcript, ids]);
  return useSyncExternalStore(subscribe, read);
}

/** Whether row `id` is expanded (`fallback` until the user chooses). */
export function useExpanded(id: string, fallback: boolean): [boolean, (open: boolean) => void] {
  const {
    services: { expansion },
    transcript,
  } = useTranscriptView();
  // The detailed view opens everything and keeps its own choices (T29).
  const detailed = useDetail() === 'detailed';
  const key = detailed ? `detailed:${transcript.cacheKey(id)}` : transcript.cacheKey(id);
  const initial = fallback || detailed;
  const subscribe = useCallback((l: () => void) => expansion.subscribe(key, l), [expansion, key]);
  const read = useCallback(() => expansion.get(key, initial), [expansion, key, initial]);
  const expanded = useSyncExternalStore(subscribe, read);
  const set = useCallback(
    (open: boolean) => {
      expansion.set(key, open);
    },
    [expansion, key],
  );
  return [expanded, set];
}

/** The parsed blocks of one item, re-rendering only when that item's blocks change. */
export function useParsedDoc(docKey: string): ParsedDoc | undefined {
  const { markdown } = useTranscriptServices();
  return useSyncExternalStore(
    (listener) => markdown.subscribe(docKey, listener),
    () => markdown.get(docKey),
  );
}

/** The branch point of turn `turnId` (T28): other branches start where it starts. */
export function useBranchPoint(turnId: string | undefined): BranchPoint | undefined {
  const { transcript } = useTranscriptView();
  const subscribe = useCallback((l: () => void) => transcript.branches.subscribe(l), [transcript]);
  const read = useCallback(() => transcript.branches.forTurn(turnId), [transcript, turnId]);
  return useSyncExternalStore(subscribe, read);
}
