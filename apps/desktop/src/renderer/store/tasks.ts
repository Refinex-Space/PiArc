// Background tasks (T32, architecture section 6.11): the `core/tasks` snapshot of Core's task
// manager, gated by its `revision` like the other entity snapshots. The rail card shows the
// selected session's tasks, the dock panel the tasks of the workspace's sessions.
import type { BackgroundTask, TaskKind, TaskStatus } from '@piarc/protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const KINDS: readonly TaskKind[] = ['command', 'subagent', 'monitor'];
const STATUSES: readonly TaskStatus[] = ['running', 'completed', 'failed', 'killed', 'interrupted'];

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const integer = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;

/** A task of the snapshot, or undefined when `value` is not one. */
export function taskOf(value: unknown): BackgroundTask | undefined {
  if (!isRecord(value)) return undefined;
  const kind = KINDS.find((k) => k === value.kind);
  const status = STATUSES.find((s) => s === value.status);
  const taskId = text(value.taskId);
  const sessionId = text(value.sessionId);
  const ownerSessionId = text(value.ownerSessionId);
  const workspace = text(value.workspace);
  const title = text(value.title);
  const cwd = text(value.cwd);
  const startedAt = count(value.startedAt);
  const outputBytes = count(value.outputBytes);
  if (
    kind === undefined ||
    status === undefined ||
    taskId === undefined ||
    sessionId === undefined ||
    ownerSessionId === undefined ||
    workspace === undefined ||
    title === undefined ||
    cwd === undefined ||
    startedAt === undefined ||
    outputBytes === undefined
  ) {
    return undefined;
  }
  const tail = Array.isArray(value.tail)
    ? value.tail.filter((line): line is string => typeof line === 'string')
    : [];
  const optional = {
    command: text(value.command),
    agentType: text(value.agentType),
    subagentSessionId: text(value.subagentSessionId),
    toolCallId: text(value.toolCallId),
    endedAt: count(value.endedAt),
    exitCode: integer(value.exitCode),
    signal: integer(value.signal),
    meaning: text(value.meaning),
    timeoutMs: count(value.timeoutMs),
    outputPath: text(value.outputPath),
  };
  const task: BackgroundTask = {
    taskId,
    sessionId,
    ownerSessionId,
    workspace,
    kind,
    title,
    cwd,
    status,
    startedAt,
    outputBytes,
    tail,
  };
  for (const [key, entry] of Object.entries(optional)) {
    if (entry !== undefined) Object.assign(task, { [key]: entry });
  }
  if (value.outcome === 'success' || value.outcome === 'failure') {
    task.outcome = value.outcome;
  }
  return task;
}

/** A `core/tasks` event, or undefined when it is malformed. */
export function tasksSnapshotOf(
  value: unknown,
): { readonly revision: number; readonly tasks: readonly BackgroundTask[] } | undefined {
  if (!isRecord(value) || !Array.isArray(value.tasks)) return undefined;
  const revision = count(value.revision);
  if (revision === undefined) return undefined;
  const tasks = value.tasks.map(taskOf).filter((t): t is BackgroundTask => t !== undefined);
  return { revision, tasks };
}

/** The tasks Core knows, newest first, with listeners. */
export class TaskList {
  #revision = -1;
  #tasks: readonly BackgroundTask[] = [];
  readonly #listeners = new Set<() => void>();

  /** Applies a `core/tasks` event; false when it was stale or malformed. */
  apply(value: unknown): boolean {
    const snapshot = tasksSnapshotOf(value);
    if (snapshot === undefined || snapshot.revision <= this.#revision) return false;
    this.#revision = snapshot.revision;
    this.#tasks = snapshot.tasks;
    for (const listener of [...this.#listeners]) listener();
    return true;
  }

  get all(): readonly BackgroundTask[] {
    return this.#tasks;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

/** The tasks of main session `sessionId` (its own and its subagents'). */
export function tasksOfSession(
  tasks: readonly BackgroundTask[],
  sessionId: string | undefined,
): readonly BackgroundTask[] {
  return sessionId === undefined ? [] : tasks.filter((t) => t.ownerSessionId === sessionId);
}

/** Milliseconds a task ran: until it ended, or until `now` while it runs. */
export function taskDuration(task: BackgroundTask, now: number): number {
  return Math.max(0, (task.endedAt ?? now) - task.startedAt);
}

/** `ms` as `12s`, `3m 05s` or `1h 02m`. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60).padStart(2, '0')}m`;
}
