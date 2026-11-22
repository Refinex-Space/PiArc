// Notices the Harness Kit adds to the conversation (reminders, T26). PiArc's own text
// (ADR-0006); `scripts/dev/check-prompt-originality.mjs` checks it with the system prompt.
import type { PermissionMode, TodoItem } from '@piarc/protocol';

const MODE_NAMES: Record<PermissionMode, string> = {
  default: 'Manual: file changes and commands that are not read-only ask the user first',
  acceptEdits:
    'Accept edits: file changes inside the workspace run without asking, commands still ask',
  plan: 'Plan',
  bypassPermissions: 'Bypass permissions: tool calls run without asking',
  auto: 'Auto review: workspace edits run without asking, and a reviewer model decides most other calls in place of the user',
};

/** Plan mode turned on. */
export const PLAN_ON =
  'Plan mode is on. Investigate and design, but change nothing: the permission check refuses ' +
  'file writes and commands that are not read-only. When the plan is ready, submit it with ' +
  "ExitPlanMode and wait for the user's decision.";

/** Plan mode turned off; `mode` is the mode now. */
export function planOff(mode: PermissionMode): string {
  return `Plan mode is off. The permission mode is now ${MODE_NAMES[mode]}.`;
}

function label(todo: TodoItem): string {
  return todo.status === 'inProgress' ? 'in progress' : todo.status;
}

/** The task list has open tasks and went `rounds` rounds of tool calls without an update. */
export function staleListNotice(todos: readonly TodoItem[], rounds: number): string {
  const open = todos.filter((todo) => todo.status !== 'completed');
  return [
    `The task list has not changed for ${String(rounds)} rounds of tool calls and still has open tasks:`,
    ...open.map((todo) => `- [${label(todo)}] ${todo.content}`),
    'If the work has moved on, bring the list up to date with TodoWrite: mark finished tasks ' +
      'completed and add tasks that came up. If it is still accurate, continue; this note is ' +
      'not for the user.',
  ].join('\n');
}

/** The conservative profile (T29): work has gone on for a while without a task list. */
export function startListNotice(rounds: number): string {
  return (
    `${String(rounds)} rounds of tool calls have passed and there is no task list yet. If the ` +
    'work has more than one step, write the steps with TodoWrite now, one in_progress, and ' +
    'update it as each one is finished. This note is not for the user.'
  );
}

/** Context a hook added (T27); a Stop hook's reasons ask the model to go on. */
export function hookContextNotice(event: string, text: string): string {
  return event === 'Stop' || event === 'SubagentStop'
    ? `A ${event} hook asked to continue:\n${text}`
    : `Context from a ${event} hook:\n${text}`;
}

/** A hook ended the previous run before the next model request (T38: PostToolBatch). */
export function hookStoppedRun(event: string, reason: string): string {
  return `A ${event} hook ended the previous run before your next step:\n${reason}`;
}

/** A file the session read or wrote changed outside it (T27). */
export function fileChangedNotice(path: string, change: 'modified' | 'deleted'): string {
  return change === 'deleted'
    ? `${path} was deleted outside this session after you last read or wrote it.`
    : `${path} was changed outside this session after you last read or wrote it. ` +
        'Read it again before you rely on its content or edit it.';
}

/** A background task reported back (T27 entry point, T32 source). */
export function backgroundTaskNotice(source: string, text: string): string {
  return `Background task ${source}:\n${text}`;
}

/** The first section of what a compaction gives back. */
export const RESTORE_INTRO =
  'The conversation above was compacted into a summary. The state below was read again ' +
  'after the summary was written; it is current.';

/** The approved plan, given back after a compaction. */
export function restoredPlan(plan: string, mode: PermissionMode): string {
  return `The plan the user approved (the permission mode then became ${MODE_NAMES[mode]}):\n${plan}`;
}

/** The task list, given back after a compaction. */
export function restoredTodos(todos: readonly TodoItem[]): string {
  return ['The task list as it stands:', ...todos.map((t) => `- [${label(t)}] ${t.content}`)].join(
    '\n',
  );
}

/** A skill's instructions, given back after a compaction. */
export function restoredSkill(name: string, body: string): string {
  return `Instructions of the skill "${name}", invoked earlier in this session:\n${body}`;
}

/** A recently used file, given back after a compaction. */
export function restoredFile(path: string, content: string): string {
  return `Current content of ${path}, a file used recently in this session:\n${content}`;
}

/** Recently used files left out to keep within the limits. */
export function omittedFiles(paths: readonly string[]): string {
  return [
    'Also used recently, left out to save context (read them again if you need them):',
    ...paths.map((path) => `- ${path}`),
  ].join('\n');
}

/** What a text cut to its limit says about the rest. */
export function cutNote(tokens: number): string {
  return `[about ${String(tokens)} more tokens left out]`;
}
