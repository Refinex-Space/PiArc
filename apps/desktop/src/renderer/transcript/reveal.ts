// Bidirectional controls in what the user decides on (T45, THR-01): a command, a path or a
// diff line containing U+202E and friends displays in another order than it runs ("Trojan
// Source"; a file `x ‮gnp.md` reads as `x dm.png`). Approval cards and diffs show each
// control as a visible `[U+XXXX]` marker in place, so the text on screen is the text that runs.

/** The bidirectional formatting characters (Unicode UAX #9): marks, embeddings, overrides, isolates. */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/gu;

/** `text` with every bidirectional control replaced by `[U+XXXX]`. */
export function revealBidi(text: string): string {
  return text.replace(
    BIDI_CONTROLS,
    (ch) => `[U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}]`,
  );
}
