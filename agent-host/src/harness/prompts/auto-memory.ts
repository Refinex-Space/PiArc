// The model-visible text of auto memory (T47, design addendum
// `docs/architecture/addenda/T47-auto-memory-and-managed-settings.md` sections 2 and 3): the
// `Memory` tool's description and guidance, and the lines that frame the injected index and
// the organization's managed instructions. PiArc's own wording; after a change run
// `node scripts/dev/check-prompt-originality.mjs`.

/** The `Memory` tool's description. */
export const MEMORY_DESCRIPTION =
  'Keep notes for later sessions in this repository. `action: "save"` creates or replaces one ' +
  'note: give `name` (lowercase letters, digits, - or _), `type` (user, feedback, project or ' +
  'reference), a one-line `description` for the index and the Markdown `content`. ' +
  '`action: "read"` returns the index of all notes, or one note in full when you give its ' +
  '`name`. `action: "delete"` removes the note `name`. Each save replaces the whole note.';

/** The `Memory` tool's line and guidelines in the tool guidance section. */
export const MEMORY_GUIDANCE = {
  snippet: 'Memory: keep, read and remove notes that carry over to later sessions here',
  guidelines: [
    'Save what will still matter in a later session and cannot be found in the code or its history: how the user wants you to work, corrections and confirmations they gave, project decisions and constraints, where outside information lives.',
    'Keep one subject per note and rewrite an existing note rather than adding a near copy; never save credentials, personal data or details that only concern the current task.',
    'Notes describe an earlier state: read one before acting on it, and update or delete it when it turns out wrong.',
  ],
};

/** The line before the auto memory index in the project context and its reminders. */
export const MEMORY_PREAMBLE =
  'Auto memory: notes saved with the Memory tool in earlier sessions of this repository. Each ' +
  'line gives a note’s name, type, the day it was saved and what it is about; read a note in ' +
  'full with the Memory tool before relying on it. The notes record the past and may be out ' +
  'of date: when one disagrees with what the user asks now or with the files, follow the user ' +
  'and the files.';

/** How a managed `CLAUDE.md` is labeled: the organization placed it on this machine. */
export function managedSource(path: string): string {
  return `Source: ${path} (instructions your organization manages for this computer)`;
}

/** A note restored after a compaction. */
export function restoredMemory(text: string): string {
  return `A note from auto memory you read or saved before the compaction:\n${text}`;
}
