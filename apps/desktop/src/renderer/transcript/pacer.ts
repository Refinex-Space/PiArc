// Streaming rhythm (architecture section 8.4): how much of the received text to show after a
// frame of `dtMs`. The display eases toward the received text so it reads as typing, trails it
// by about `revealTauMs`, and never by more than `maxBacklogChars`.
import { STREAMING, type StreamingParameters } from './constants.js';

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** The number of characters of `text` to show, given `visible` shown before this frame. */
export function revealLength(
  text: string,
  visible: number,
  dtMs: number,
  parameters: StreamingParameters = STREAMING,
): number {
  const target = text.length;
  if (visible >= target) {
    return target;
  }
  const floor = Math.max(visible, target - parameters.maxBacklogChars);
  const backlog = target - floor;
  const eased = backlog * (1 - Math.exp(-Math.max(0, dtMs) / parameters.revealTauMs));
  const minimum = (parameters.minCharsPerSecond * Math.max(0, dtMs)) / 1000;
  let next = Math.min(target, floor + Math.max(1, Math.ceil(Math.max(eased, minimum))));
  // Never split a surrogate pair: a lone high surrogate renders as a replacement character.
  if (next < target && isHighSurrogate(text.charCodeAt(next - 1))) {
    next += 1;
  }
  return next;
}
