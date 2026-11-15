// Tuning constants of the transcript (architecture section 8.4), in one place. The values were
// calibrated in T09 (docs/spikes/S01-transcript-composer.md); change them there and here together.

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
