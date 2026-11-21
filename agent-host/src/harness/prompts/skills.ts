// The model-visible text of skills (T37, ADR-0054): the `Skill` tool's description, the
// system prompt's skills index, and the reminders for skills that became available or changed
// during a session. PiArc's own wording (ADR-0006): run the originality check after edits.

/** The `Skill` tool's description. */
export const SKILL_DESCRIPTION =
  'Load the instructions of one of the skills listed under <skills> in the system prompt. ' +
  '`skill` is its name exactly as listed; `args` is optional text the skill works with, such ' +
  'as an issue number or a file. The result is the skill’s full instructions with the ' +
  'arguments filled in: follow them for the rest of the task. Files the instructions mention ' +
  'sit next to the skill and can be read with Read without asking. A skill the user started ' +
  'with /name is already loaded; do not load it again.';

/** The first line of the system prompt's skills section. */
export const SKILLS_INDEX_INTRO =
  'Skills hold instructions for particular kinds of work. When a request matches one, load it ' +
  'with the Skill tool before starting; the list gives each name and when it applies.';

/** One index line: the name and its description (already shortened). */
export function skillLine(name: string, description: string | undefined): string {
  return description === undefined || description === ''
    ? `- ${name}`
    : `- ${name}: ${description}`;
}

/** A reminder listing skills that became available, changed or went away. */
export function skillsChanged(added: readonly string[], removed: readonly string[]): string {
  const lines: string[] = [];
  if (added.length > 0) {
    lines.push('These skills can now be loaded with the Skill tool:', ...added);
  }
  if (removed.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`These skills are no longer available: ${removed.join(', ')}. Do not load them.`);
  }
  return lines.join('\n');
}

/** The tool result when the same skill with the same text was already loaded. */
export function skillAlreadyLoaded(name: string): string {
  return `The skill "${name}" is already loaded in this conversation with the same instructions; keep following them.`;
}

/** The tool result header of a loaded skill. */
export function skillLoaded(
  name: string,
  dir: string,
  body: string,
  notes: readonly string[],
): string {
  return [
    `Skill "${name}" (files in ${dir}):`,
    '',
    body,
    ...(notes.length === 0 ? [] : ['', ...notes]),
  ].join('\n');
}

/** A note when an untrusted project's skill grants nothing. */
export const SKILL_UNTRUSTED_NOTE =
  'Note: this project is not trusted, so the skill’s pre-approved tools and hooks do not apply; tools ask as usual.';

/** A note when the skill's pre-approved tools apply for this turn. */
export function skillAllowedNote(rules: readonly string[]): string {
  return `Until this turn ends, these need no approval: ${rules.join(', ')}.`;
}
