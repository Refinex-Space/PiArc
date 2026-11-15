// The transcript prototype page (renderer, `#/transcript-lab`) and what it exposes to L4 tests
// and the S1 benchmark as `window.__piarcTranscriptLab`. Test-only: no product feature uses it.

/** Hash that opens the prototype page. */
export const TRANSCRIPT_LAB_HASH = '#/transcript-lab';

/** A business action the composer triggered. */
export type ComposerActionRecord =
  | {
      readonly kind: 'send' | 'steer' | 'queue';
      readonly text: string;
      readonly mentions: readonly string[];
    }
  | { readonly kind: 'stop' | 'command' | 'mentionOpened' }
  | { readonly kind: 'mentionChosen'; readonly path: string };

/** Frames recorded in the page between `startFrames` and `stopFrames`. */
export interface FrameRecording {
  /** Intervals between consecutive animation frames (ms). */
  readonly intervals: readonly number[];
  /** Durations of `longtask` entries (ms). */
  readonly longTasks: readonly number[];
  /** Durations of `long-animation-frame` entries (ms). */
  readonly longAnimationFrames: readonly number[];
  readonly durationMs: number;
}

export interface ScrollSnapshot {
  readonly following: boolean;
  readonly showButton: boolean;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly distanceFromBottom: number;
}

/** The transcript's scroll-follow thresholds (renderer transcript/constants.ts). */
export interface ScrollThresholds {
  readonly releasePx: number;
  readonly resumePx: number;
  readonly buttonPx: number;
  readonly userInputWindowMs: number;
}

export interface TranscriptLabApi {
  /** Removes every row. */
  clear(): void;
  /**
   * Loads `count` completed items and resolves once every row in the viewport shows parsed
   * Markdown and a frame was painted; `readyToVisibleMs` is the time from the data being in the
   * store to that frame.
   */
  loadHistory(
    count: number,
    seed?: number,
  ): Promise<{ readyToVisibleMs: number; visibleRows: number }>;
  /** Streams a turn of `seconds` at `tokensPerSecond` (or of `messages`), resolving at its end. */
  streamTurn(options: {
    tokensPerSecond: number;
    seconds?: number;
    messages?: readonly string[];
  }): Promise<{ itemIds: readonly string[] }>;
  /** Adds one finished agent message and resolves with its item id once it is parsed. */
  addMessage(markdown: string): Promise<string>;
  /** Simulates the agent running or idle (turn/started, turn/completed). */
  setRunning(running: boolean): void;
  /** Resolves when the message's Markdown is final and every code block settled. */
  settled(itemId: string): Promise<void>;
  startFrames(): void;
  stopFrames(): FrameRecording;
  /** Scrolls the transcript programmatically at `pxPerSecond` for `durationMs`. */
  autoScroll(options: {
    pxPerSecond: number;
    durationMs: number;
    direction: 'up' | 'down';
  }): Promise<{ distancePx: number }>;
  renderCounts(): Readonly<Record<string, number>>;
  resetRenderCounts(): void;
  scroll(): ScrollSnapshot;
  scrollThresholds(): ScrollThresholds;
  actions(): readonly ComposerActionRecord[];
  clearActions(): void;
  /** Ids of the rows currently in the DOM, in order. */
  mountedRowIds(): readonly string[];
}

declare global {
  /** Present on the prototype page only (set by src/renderer/lab/TranscriptLab.tsx). */
  var __piarcTranscriptLab: TranscriptLabApi | undefined;
}
