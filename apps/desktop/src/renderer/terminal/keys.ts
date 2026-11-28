// Turns DOM keyboard events into the key messages Core encodes with the terminal's modes
// (ADR-0017 rule 4: the renderer sends the event as it is; libghostty-vt decides the bytes).
import type { TerminalKeyMessage } from '../../shared/ipc.js';

/** Modifier bits of `TerminalKeyMessage.mods`. */
export const KEY_MODS = { shift: 1, ctrl: 2, alt: 4, meta: 8 } as const;

/** The fields of a `KeyboardEvent` this module reads. */
export interface KeyFields {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly repeat: boolean;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
}

/**
 * The text a key produced: `event.key` when it is a single grapheme (a letter, a digit, a
 * symbol, or what Option produced on macOS), '' for named keys such as `Enter`, `ArrowUp` or
 * `Dead`.
 */
export function keyText(key: string): string {
  const iterator = graphemeSegmenter.segment(key)[Symbol.iterator]();
  const first = iterator.next();
  return !first.done && iterator.next().done === true ? key : '';
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * The message for a `keydown` or `keyup` event, or `undefined` when the terminal should not
 * get it: Command shortcuts on macOS stay with the app (copy, paste, window commands).
 */
export function keyMessage(event: KeyFields): TerminalKeyMessage | undefined {
  if (event.metaKey) {
    return undefined;
  }
  const mods =
    (event.shiftKey ? KEY_MODS.shift : 0) |
    (event.ctrlKey ? KEY_MODS.ctrl : 0) |
    (event.altKey ? KEY_MODS.alt : 0);
  return {
    action: event.type === 'keyup' ? 'release' : event.repeat ? 'repeat' : 'press',
    code: event.code,
    text: event.type === 'keyup' ? '' : keyText(event.key),
    mods,
    composing: event.isComposing,
  };
}
