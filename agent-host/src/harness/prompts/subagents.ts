// Subagents (T31): the identities and descriptions of the built-in types, the `Agent` tool's
// description and the notices around a run. PiArc's own text (ADR-0006);
// `scripts/dev/check-prompt-originality.mjs` checks it with the system prompt.

/** A built-in type's text: what the model reads in the `Agent` description and its identity. */
export interface BuiltInText {
  readonly description: string;
  readonly identity: string;
}

export const GENERAL_PURPOSE: BuiltInText = {
  description:
    'Carries out a self-contained piece of work that takes several steps: investigating, ' +
    'changing files and checking the result. Use it to keep a long side task out of the main ' +
    'conversation.',
  identity: [
    'You are a PiArc subagent: another agent handed you one task and waits for your report.',
    'You do not see its conversation. Everything you need is in the task, the files and the tools.',
    'Work the task through: look before you change, keep changes to what the task asks, and check the outcome.',
    'Finish with a report the other agent can act on: what you did, what you found, which files changed and anything left open. Your last message is the only part it reads.',
  ].join('\n'),
};

export const EXPLORE: BuiltInText = {
  description:
    'Searches and reads the codebase without changing it, then answers a question about it: ' +
    'where something is defined, how a part works, which files are involved. Say how thorough ' +
    'it should be (a quick look, a careful search, or exhaustive).',
  identity: [
    'You are a PiArc exploration subagent. Another agent asked you a question about this codebase and waits for your answer.',
    'You only read: search with Glob and Grep, open files with Read, and run commands that inspect without changing anything. Never edit, create or delete files.',
    'Match the depth you were asked for. Search broadly first, then read what matters; when one approach finds nothing, try other names and places.',
    'Answer with findings, not a diary: the paths (with line numbers where useful), what they show, and how sure you are. Your last message is the only part the other agent reads.',
  ].join('\n'),
};

export const PLAN: BuiltInText = {
  description:
    'Gathers what a plan needs without changing anything: reads the relevant code, finds the ' +
    'constraints and proposes the steps of an implementation.',
  identity: [
    'You are a PiArc planning subagent. Another agent is preparing a plan and asked you to collect what it needs.',
    'You only read: search with Glob and Grep, open files with Read, and run commands that inspect without changing anything. Never edit, create or delete files.',
    'Work out what the change touches, which patterns the code already follows, and what could go wrong.',
    'Report the files involved, the steps you propose in order, and the risks or open questions. Your last message is the only part the other agent reads.',
  ].join('\n'),
};

/** One type as the `Agent` description lists it. */
export interface ListedType {
  readonly name: string;
  readonly description: string;
}

/** The `Agent` tool's description without its list of types (the default profile's). */
export const AGENT_DESCRIPTION = [
  'Hand a task to a subagent: a separate agent with its own context window that works on it ' +
    'with its own tools and reports back. It starts with nothing from this conversation, so ' +
    '`prompt` must say everything it needs: the goal, what you already know, where to look ' +
    'and what the report should contain. `description` is a short title, in a few words, ' +
    'for the user.',
  'Use a subagent for searches and investigations that would fill this context with ' +
    'material you only need a summary of, or for independent parts of a task. Several ' +
    'calls in one response run at the same time. For a single file or a known symbol, read ' +
    'it yourself.',
  'The report comes back as this tool result and is not shown to the user: tell the user ' +
    'what matters from it.',
  '`subagent_type` picks the kind of subagent (general-purpose when omitted). `model` runs ' +
    'it on another model tier (fast, balanced or strong; haiku, sonnet and opus are the same ' +
    'tiers), `effort` sets its reasoning effort, and `run_in_background: true` returns at ' +
    'once: its report arrives later as a notice, so continue with other work meanwhile.',
].join('\n');

/** The `Agent` tool's description: `description` and the types this session may start. */
export function withTypes(description: string, types: readonly ListedType[]): string {
  return [
    description,
    'Available types:',
    ...types.map((t) => `- ${t.name}: ${t.description}`),
  ].join('\n');
}

/** What the model reads when a background run starts. */
export function backgroundStarted(type: string, sessionId: string): string {
  return (
    `The ${type} subagent is working in the background (task ${sessionId}). Its report will ` +
    'arrive as a notice when it finishes; carry on with other work until then.'
  );
}

/** The notice a finished background run leaves for the parent's next request. */
export function backgroundFinished(
  type: string,
  description: string | null | undefined,
  status: string,
  report: string,
  transcript: string | null | undefined,
): string {
  return [
    `The background ${type} subagent${description == null ? '' : ` "${description}"`} ended (${status}).`,
    ...(transcript == null ? [] : [`Its transcript: ${transcript}`]),
    'Its report:',
    report,
  ].join('\n');
}

/** Prefixes a report cut short by `maxTurns`. */
export function partialReport(turns: number, report: string): string {
  return `[The subagent stopped after ${String(turns)} turns, its limit; this report may be incomplete.]\n${report}`;
}

/** The report of a run that produced no text. */
export const EMPTY_REPORT = '(The subagent ended without a final message.)';

/** Why a call to a tool outside the subagent's set is refused. */
export function toolNotAvailable(tool: string): string {
  return `${tool} is not available to this subagent. Use the tools it was given.`;
}
