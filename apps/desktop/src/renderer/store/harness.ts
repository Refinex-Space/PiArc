// A session's plan and task list (T26, architecture section 6.5): the branch's state as the
// history window reports it (`harness`), then each `harness/todo` and `harness/plan`
// notification. The rail's task card, the plan panel and the panel availability read it.
import { isPermissionMode, type PlanRecord, type TodoItem, type TodoStatus } from '@piarc/protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'inProgress' || value === 'completed';
}

/** A task list in the protocol shape, or undefined when `value` is not one. */
export function todosOf(value: unknown): TodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const todos: TodoItem[] = [];
  for (const todo of value) {
    if (!isRecord(todo) || typeof todo.content !== 'string' || !isStatus(todo.status)) {
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

/** An approved plan, or undefined when `value` is not one. */
export function planOf(value: unknown): PlanRecord | undefined {
  if (
    !isRecord(value) ||
    typeof value.plan !== 'string' ||
    typeof value.toolCallId !== 'string' ||
    typeof value.entryId !== 'string' ||
    !isPermissionMode(value.mode)
  ) {
    return undefined;
  }
  return {
    plan: value.plan,
    toolCallId: value.toolCallId,
    entryId: value.entryId,
    mode: value.mode,
  };
}

export interface HarnessSnapshot {
  readonly todos: readonly TodoItem[];
  readonly plan: PlanRecord | undefined;
}

const EMPTY: HarnessSnapshot = { todos: [], plan: undefined };

export class SessionHarness {
  private snapshot: HarnessSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();

  state(): HarnessSnapshot {
    return this.snapshot;
  }

  /** The state of a freshly loaded history window (`harness`, absent when it has neither). */
  load(value: unknown): void {
    const harness = isRecord(value) ? value : {};
    this.set({ todos: todosOf(harness.todos) ?? [], plan: planOf(harness.plan) });
  }

  /** Applies a session notification; false when it is not one of the harness's. */
  apply(method: string, params: Record<string, unknown>): boolean {
    if (method === 'harness/todo') {
      const todos = todosOf(params.todos);
      if (todos !== undefined) this.set({ ...this.snapshot, todos });
      return true;
    }
    if (method === 'harness/plan') {
      const plan = planOf(params);
      if (plan !== undefined) this.set({ ...this.snapshot, plan });
      return true;
    }
    return false;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(next: HarnessSnapshot): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}
