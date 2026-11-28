// The compaction summary request (architecture section 6.6.4, T27, ADR-0043). PiArc's own
// text (ADR-0006); `scripts/dev/check-prompt-originality.mjs` checks it with the system prompt.
// The headings are fixed so the agent that continues finds the same structure every time.

/** System text of the summary request. */
export const SUMMARY_SYSTEM = [
  'You write handover notes for a coding session.',
  'You receive the transcript of a conversation between a user and a coding agent and write a structured summary that lets the agent carry on without the transcript.',
  'Write the summary only: do not answer questions from the transcript, do not continue its work and do not call tools.',
].join('\n');

/** The summary's headings, in order. */
export const SUMMARY_HEADINGS = [
  'Task goal',
  'User requirements and constraints',
  'Key decisions',
  'Files changed',
  'Errors and fixes',
  'Open items',
  'Current progress',
  'Context to keep',
] as const;

const GUIDES: Record<(typeof SUMMARY_HEADINGS)[number], string> = {
  'Task goal': 'What the user wants done, including requests that came up along the way.',
  'User requirements and constraints':
    'Preferences, limits and instructions the user gave, close to their wording where it matters.',
  'Key decisions': 'Each choice that was made and why.',
  'Files changed': 'Every file created, edited or deleted, and what changed in it.',
  'Errors and fixes':
    'Errors that came up, with the exact message when it matters, and how each was resolved or that it is still open.',
  'Open items': 'Work that remains, in the order it should happen.',
  'Current progress':
    'Where the work stood at the end of the transcript: the last step taken and the next one.',
  'Context to keep':
    'Facts the next steps depend on: paths, commands, identifiers, values, test names.',
};

export interface SummaryRequest {
  /** The serialized transcript to summarize. */
  readonly transcript: string;
  /** The start of the request still in progress, whose later messages are kept. */
  readonly turnStart?: string;
  /** The summary of the part compacted before. */
  readonly previousSummary?: string;
  /** What the user asked the summary to focus on (`/compact <focus>`). */
  readonly focus?: string;
  /** Plain stdout of PreCompact hooks. */
  readonly hookInstructions?: string;
}

/** The user message of the summary request. */
export function summaryPrompt(request: SummaryRequest): string {
  const parts = [`<transcript>\n${request.transcript}\n</transcript>`];
  if (request.turnStart !== undefined) {
    parts.push(`<turn-start>\n${request.turnStart}\n</turn-start>`);
  }
  if (request.previousSummary !== undefined) {
    parts.push(`<previous-summary>\n${request.previousSummary}\n</previous-summary>`);
  }
  const lines = [
    'Summarize the session above for the agent that will continue it. Use exactly these Markdown headings, in this order, and write "None." under a heading with nothing to report:',
    '',
    ...SUMMARY_HEADINGS.flatMap((heading) => [`## ${heading}`, GUIDES[heading], '']),
    'Keep exact file paths, identifiers, commands and error messages. Be brief and leave out what no longer matters.',
  ];
  if (request.previousSummary !== undefined) {
    lines.push(
      'The earlier part of this session was summarized before (previous-summary). Merge it with the transcript into one summary with the same headings: keep what still holds and update what changed.',
    );
  }
  if (request.turnStart !== undefined) {
    lines.push(
      'The turn-start part is the beginning of the request still in progress. Its later messages stay in the conversation as they are, so record what it asked for and what was done so far.',
    );
  }
  if (request.focus !== undefined) {
    lines.push(`Focus requested by the user: ${request.focus}`);
  }
  if (request.hookInstructions !== undefined) {
    lines.push(`Instructions from PreCompact hooks: ${request.hookInstructions}`);
  }
  parts.push(lines.join('\n'));
  return parts.join('\n\n');
}

/** The file lists appended to a summary. */
export function fileLists(read: readonly string[], modified: readonly string[]): string {
  const block = (title: string, paths: readonly string[]): string[] =>
    paths.length === 0 ? [] : [`${title}\n${paths.map((path) => `- ${path}`).join('\n')}`];
  const blocks = [
    ...block('Files read in the summarized part:', read),
    ...block('Files modified in the summarized part:', modified),
  ];
  return blocks.length === 0 ? '' : `\n\n${blocks.join('\n\n')}`;
}
