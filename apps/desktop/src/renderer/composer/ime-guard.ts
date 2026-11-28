// Input method guard (architecture section 8.5). Every keyboard handler of the composer, and any
// other text input that reacts to keys, calls it first: while an input method composes text
// (Chinese, Japanese, Korean), Enter confirms a candidate and Esc cancels it, so neither may
// send, stop, open the command list or start a mention.
//
// Chromium marks key events of a composition with `isComposing` and reports `keyCode` 229
// ("Process") for keys the input method consumed; ProseMirror's `view.composing` covers the
// span from `compositionstart` to `compositionend`. Any of the three means "composing". Same
// rule as the interaction notes of open-claude-ui (MIT, github.com/Caho1/open-claude-ui,
// code-examples/ChatComposer.tsx at be395eb); its extra WebKit-only Enter delay is not needed in
// Chromium, where the confirming Enter still arrives with `isComposing` set.

/** The key code Chromium reports for keys handled by an input method. */
export const IME_PROCESS_KEY_CODE = 229;

/** The fields of a keyboard event the guard reads. */
export interface ImeKeyFields {
  readonly isComposing: boolean;
  readonly keyCode: number;
}

/** True when the key belongs to an input method composition and must not trigger anything. */
export function isImeComposing(event: ImeKeyFields, composing = false): boolean {
  return composing || event.isComposing || event.keyCode === IME_PROCESS_KEY_CODE;
}
