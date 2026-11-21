// Tuning constants of the transcript (architecture section 8.4), in one place. The values were
// calibrated in T09 (docs/spikes/S01-transcript-composer.md) and confirmed with Core's real event
// stream in T19 (apps/desktop/src/renderer/transcript/CLAUDE.md); change them there and here
// together.

/** Scroll following: when the viewport sticks to the bottom and when it lets go. */
export const SCROLL_FOLLOW = {
  /** An upward user scroll that leaves the viewport more than this far from the bottom stops following (px). */
  releasePx: 2,
  /** A downward user scroll that ends within this distance of the bottom resumes following (px). */
  resumePx: 40,
  /** The "back to bottom" button shows beyond this distance from the bottom (px). */
  buttonPx: 200,
  /**
   * Scroll events within this time after wheel, touch, key or scrollbar input are the user's;
   * content growth does not pull the viewport down during it either (ms).
   */
  userInputWindowMs: 150,
  /** Earlier history is loaded once the viewport's top is this close to the list's top (px). */
  loadEarlierPx: 400,
} as const;

export type ScrollFollowThresholds = typeof SCROLL_FOLLOW;

/** Streaming rhythm: how received text is revealed frame by frame. */
export const STREAMING = {
  /**
   * Time constant of the reveal: each frame shows the fraction `1 - e^(-dt/tau)` of the text
   * received but not yet shown, so the display trails the stream by about `tau` (ms).
   */
  revealTauMs: 50,
  /** Slowest reveal while text is waiting, so the tail of a message does not crawl (chars/s). */
  minCharsPerSecond: 120,
  /** The display never trails the received text by more than this (chars). */
  maxBacklogChars: 400,
} as const;

export type StreamingParameters = typeof STREAMING;

/** Virtual list. */
export const VIRTUAL_LIST = {
  /** Rows rendered beyond each edge of the viewport, in viewport heights. */
  overscanViewports: 1,
  /** Assumed line height of message text before a row is measured (px). */
  estimatedLineHeightPx: 22,
  /** Assumed average character width of message text before a row is measured (px). */
  estimatedCharWidthPx: 7.5,
} as const;

/** History windows (Core's `transcript_window`). */
export const HISTORY = {
  /** Items loaded when a session is opened, and per earlier page (Core's maximum is 1,000). */
  pageItems: 1000,
} as const;

/** How long a row found by search stays marked (T35). */
export const LOCATED_MS = 2000;

/**
 * The conversation's live region (architecture section 8.7, T43): what the agent is doing is
 * announced at most once per interval while a turn runs, never token by token; the turn's result
 * once when it ends.
 */
export const LIVE_ANNOUNCE = {
  /** Shortest time between two progress announcements (ms). */
  intervalMs: 5000,
  /** The longest excerpt of the reply the result announcement reads (chars). */
  excerptChars: 160,
} as const;
