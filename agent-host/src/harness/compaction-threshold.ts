// When automatic compaction runs (architecture section 6.15, T27, ADR-0043 rule 5): once the
// context reaches T = W − min(O, 20,000) − 13,000 tokens, where W is the smaller of the model's
// context window and the user's automatic compaction window (`autoCompactWindow`) and O the
// model's largest output. A per-model window setting (T29) replaces the model's window.
//
// Pi 1.5.2 compacts when `tokens > modelWindow − compaction.reserveTokens`, so the session's
// settings get `reserveTokens = modelWindow − T + 1`: Pi's three checks (before a prompt,
// between two steps, after a run) and its overflow recovery then trigger exactly at T.

/** The output reserve is the model's largest output, at most this. */
export const OUTPUT_RESERVE_CAP = 20_000;
/** Tokens kept free besides the output reserve. */
export const SAFETY_MARGIN = 13_000;

export interface ThresholdInput {
  /** The model's context window. */
  readonly contextWindow: number;
  /** The model's largest output. */
  readonly maxOutput: number;
  /** The user's automatic compaction window, when set. */
  readonly autoCompactWindow?: number;
  /** A per-model window setting (T29), replacing `contextWindow` when set. */
  readonly contextWindowOverride?: number;
}

/** W: the window the threshold and the usage are measured against. */
export function effectiveWindow(input: ThresholdInput): number {
  const window = input.contextWindowOverride ?? input.contextWindow;
  return input.autoCompactWindow === undefined ? window : Math.min(window, input.autoCompactWindow);
}

/** T: automatic compaction runs once the context has this many tokens. */
export function autoCompactThreshold(input: ThresholdInput): number {
  return effectiveWindow(input) - Math.min(input.maxOutput, OUTPUT_RESERVE_CAP) - SAFETY_MARGIN;
}

/** Whether a context of `tokens` tokens is due for automatic compaction. */
export function shouldAutoCompact(tokens: number, threshold: number): boolean {
  return tokens >= threshold;
}

/** Pi's `compaction.reserveTokens` that makes its `tokens > window − reserve` check the same as
 * `tokens >= threshold` (never negative: Pi rejects it). */
export function piReserveTokens(modelWindow: number, threshold: number): number {
  return Math.max(0, modelWindow - threshold + 1);
}
