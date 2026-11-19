// Notices the Harness Kit adds to the conversation (reminders, T26). PiArc's own text
// (ADR-0006); `scripts/dev/check-prompt-originality.mjs` checks it with the system prompt.
import type { PermissionMode, TodoItem } from '@piarc/protocol';

const MODE_NAMES: Record<PermissionMode, string> = {
  default: 'Manual: file changes and commands that are not read-only ask the user first',
  acceptEdits:
    'Accept edits: file changes inside the workspace run without asking, commands still ask',
  plan: 'Plan',
  bypassPermissions: 'Bypass permissions: tool calls run without asking',
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
