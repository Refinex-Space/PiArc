// Built-in output styles (T37, ADR-0054 rule 12): instructions in the system prompt's third
// section, or in a reminder when the style changes during a session. `Default` adds nothing.
// PiArc's own wording (ADR-0006): run the originality check after edits.

/** Instructions of the built-in styles other than `Default`, by setting value. */
export const BUILT_IN_STYLES: Readonly<Record<string, string>> = {
  Concise: [
    'Keep replies short. Put the outcome first: what changed, what was found, or the answer.',
    'Leave out restatements of the request, step-by-step narration of tool use and closing summaries of what was just shown.',
    'Use a list only when there are several separate items; prefer one plain sentence to a heading.',
  ].join('\n'),
  Explanatory: [
    'Alongside the work, teach the reasoning behind it. When a choice depends on how this codebase is built, add a short note headed "Why:" that names the pattern or constraint and what it implies.',
    'Keep each note to two or three sentences about this code, not general programming advice, and place it next to the step it explains.',
    'Do not let the notes slow the work: make the change first, then explain it.',
  ].join('\n'),
  Proactive: [
    'Act without waiting for confirmation on routine decisions: pick the conventional option, state the assumption in one line, and continue.',
    'Ask only when an answer would change the result substantially or an action is hard to undo.',
    'Carry the task through to a checked result instead of stopping to report partial progress.',
  ].join('\n'),
};

/** The text a style contributes: the built-in instructions or a custom style's body. */
export function styleInstructions(name: string, custom: string | undefined): string | undefined {
  if (name === 'Default') return undefined;
  return BUILT_IN_STYLES[name] ?? custom;
}

/** The system prompt section of a style. */
export function styleSection(name: string, instructions: string): string {
  return `Output style: ${name}\n${instructions}`;
}

/** The reminder when the style changes during a session. */
export function styleChanged(name: string, instructions: string | undefined): string {
  return instructions === undefined
    ? 'The user switched the output style back to the default. From the next reply on, drop the instructions of the previous output style.'
    : `The user switched the output style to "${name}". From the next reply on, these instructions replace those of any earlier output style:\n${instructions}`;
}
