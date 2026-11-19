// The task list (architecture section 6.5, T26). `TodoWrite` takes Claude Code's parameters
// (`todos` of `content`, `status` pending | in_progress | completed, `activeForm`) and replaces
// the whole list. The list is stored in the result's `details` (protocol shape, camelCase
// status), so a branch's list is its last successful `TodoWrite` result and follows the branch
// on fork and rewind, as in Pi's `todo.ts` example.
//
// - `harness/todo` reports each new list right after the call's `item/completed`.
// - A list with open tasks that `TODO_REMINDER_ROUNDS` rounds of tool calls left unchanged gets
//   a reminder (key `todo`); the count starts again after the reminder.
//
// `currentTodos` is the injection interface T27 uses to give the list back after compaction.
import {
  defineTool,
  type ExtensionFactory,
  type SessionEntry,
  type SessionManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { TodoItem, TodoStatus } from '@piarc/protocol';
import { Type } from 'typebox';

import { isObject } from '../runtime/items.js';
import { presentationOf } from '../tools/presentation.js';
import type { ToolPresentation } from '../tools/profile.js';
import { staleListNotice } from './prompts/notices.js';
import { REMINDER_ENTRY, reminderKeys, type Reminders } from './reminders.js';

export { staleListNotice };

/** Rounds of tool calls (model replies that call tools) without a list update before the
 * model is reminded of an open task list. */
export const TODO_REMINDER_ROUNDS = 8;

/** Reminder key of the stale-list notice. */
export const TODO_REMINDER = 'todo';

const STATUS: Record<string, TodoStatus> = {
  pending: 'pending',
  in_progress: 'inProgress',
  completed: 'completed',
};

const todoSchema = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({
        minLength: 1,
        description: 'The task, in the imperative ("Run the tests").',
      }),
      status: Type.Union(
        [Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')],
        { description: 'pending, in_progress (one task at a time) or completed.' },
      ),
      activeForm: Type.Optional(
        Type.String({
          minLength: 1,
          description: 'The task as it reads while in progress ("Running the tests").',
        }),
      ),
    }),
    { description: 'The whole list, in order; it replaces the previous one.' },
  ),
});

function isStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'inProgress' || value === 'completed';
}

/** The list in a `TodoWrite` result's details, or undefined when it holds none. */
export function todosOf(details: unknown): TodoItem[] | undefined {
  if (!isObject(details) || !Array.isArray(details.todos)) return undefined;
  const todos: TodoItem[] = [];
  for (const todo of details.todos) {
    if (!isObject(todo) || typeof todo.content !== 'string' || !isStatus(todo.status)) {
      return undefined;
    }
    todos.push({
      content: todo.content,
      status: todo.status,
      ...(typeof todo.activeForm === 'string' ? { activeForm: todo.activeForm } : {}),
    });
  }
  return todos;
}

function isTodoResult(entry: SessionEntry, canonical: (tool: string) => string): boolean {
  return (
    entry.type === 'message' &&
    entry.message.role === 'toolResult' &&
    !entry.message.isError &&
    canonical(entry.message.toolName) === 'TodoWrite' &&
    todosOf(entry.message.details) !== undefined
  );
}

/** The task list of the branch: its last successful `TodoWrite` result, or an empty list. */
export function currentTodos(
  entries: readonly SessionEntry[],
  canonical: (tool: string) => string,
): TodoItem[] {
  const entry = entries.findLast((e) => isTodoResult(e, canonical));
  return entry?.type === 'message' && entry.message.role === 'toolResult'
    ? (todosOf(entry.message.details) ?? [])
    : [];
}

/** Rounds of tool calls since the last list update or stale-list reminder on the branch. */
export function roundsSinceUpdate(
  entries: readonly SessionEntry[],
  canonical: (tool: string) => string,
): number {
  let rounds = 0;
  for (const entry of entries.toReversed()) {
    if (isTodoResult(entry, canonical)) break;
    if (
      entry.type === 'custom_message' &&
      entry.customType === REMINDER_ENTRY &&
      reminderKeys(entry.details).includes(TODO_REMINDER)
    ) {
      break;
    }
    if (
      entry.type === 'message' &&
      entry.message.role === 'assistant' &&
      entry.message.content.some((part) => part.type === 'toolCall')
    ) {
      rounds++;
    }
  }
  return rounds;
}

function summary(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return 'The task list is now empty.';
  const count = (status: TodoStatus): number => todos.filter((t) => t.status === status).length;
  const active = todos.find((todo) => todo.status === 'inProgress');
  return (
    `Task list saved: ${String(todos.length)} tasks, ${String(count('completed'))} completed, ` +
    `${String(count('inProgress'))} in progress, ${String(count('pending'))} pending.` +
    (active === undefined ? '' : ` Current task: ${active.activeForm ?? active.content}.`)
  );
}

export function createTodoWriteTool(presentation: ToolPresentation): ToolDefinition {
  return defineTool<typeof todoSchema, { todos: TodoItem[] }>({
    ...presentationOf(presentation),
    parameters: todoSchema,
    execute(_toolCallId, params) {
      const todos: TodoItem[] = params.todos.map((todo) => ({
        content: todo.content,
        status: STATUS[todo.status] ?? 'pending',
        ...(todo.activeForm === undefined ? {} : { activeForm: todo.activeForm }),
      }));
      return Promise.resolve({
        content: [{ type: 'text', text: summary(todos) }],
        details: { todos },
      });
    },
  });
}

/** Watches one session's list: queues the stale-list reminder after a round of tool calls. */
export function todoWatch(
  manager: SessionManager,
  reminders: Reminders,
  canonical: (tool: string) => string,
): ExtensionFactory {
  return (pi) => {
    pi.on('turn_end', (event) => {
      if (event.toolResults.length === 0 || reminders.has(TODO_REMINDER)) return;
      const branch = manager.getBranch();
      const todos = currentTodos(branch, canonical);
      if (!todos.some((todo) => todo.status !== 'completed')) return;
      const rounds = roundsSinceUpdate(branch, canonical);
      if (rounds >= TODO_REMINDER_ROUNDS) {
        reminders.enqueue(TODO_REMINDER, staleListNotice(todos, rounds));
      }
    });
  };
}
