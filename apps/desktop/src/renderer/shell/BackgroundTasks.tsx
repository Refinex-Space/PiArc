// Background tasks in the window (T32, architecture section 8.2): the rail card lists the
// selected session's tasks (kind, status, how long, the last lines, a stop button); the dock
// panel lists the tasks of the workspace's sessions and shows a task's output, read from Core
// in parts (`readTaskOutput`) so the window never holds a whole log. Stopping goes through
// `stopTask`, the same Core entry as KillShell.
import type { BackgroundTask, TaskStatus } from '@piarc/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { MessageId } from '../../shared/i18n/index.js';
import { useT } from '../app/app-context.js';
import { useSession, useSessions, useTasks } from '../store/hooks.js';
import { formatDuration, taskDuration, tasksOfSession } from '../store/tasks.js';
import { showTerminal } from '../terminal/panel-state.js';
import { showPanel } from './registry.js';

/** Bytes one read asks for (Core's chunk size). */
const CHUNK = 64 * 1024;

/** The output a viewer keeps, at most; older text is dropped from the start. */
const KEPT_CHARS = 512 * 1024;

/** Last lines the card shows of a running task. */
const CARD_LINES = 3;

const STATUS_MESSAGE: Record<TaskStatus, MessageId> = {
  running: 'bgTasks.status.running',
  completed: 'bgTasks.status.completed',
  failed: 'bgTasks.status.failed',
  killed: 'bgTasks.status.killed',
  interrupted: 'bgTasks.status.interrupted',
};

const KIND_MESSAGE: Record<BackgroundTask['kind'], MessageId> = {
  command: 'bgTasks.kind.command',
  subagent: 'bgTasks.kind.subagent',
  monitor: 'bgTasks.kind.monitor',
  terminal: 'bgTasks.kind.terminal',
};

/** The time now, every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [active]);
  return now;
}

function StopButton({ task }: { readonly task: BackgroundTask }) {
  const t = useT();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  if (task.status !== 'running') return null;
  const stop = () => {
    setStopping(true);
    setError(undefined);
    window.piarc
      .stopTask(task.taskId)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        setStopping(false);
      });
  };
  return (
    <>
      <button
        type="button"
        className="button bg-task-stop"
        disabled={stopping}
        onClick={stop}
        data-testid="bg-task-stop"
      >
        {t(stopping ? 'bgTasks.stopping' : 'bgTasks.stop')}
      </button>
      {error === undefined ? null : (
        <p className="bg-task-error" role="alert">
          {t('bgTasks.stopFailed', { reason: error })}
        </p>
      )}
    </>
  );
}

/** A running terminal task opens in the terminal panel (T34). */
function OpenTerminalButton({ task }: { readonly task: BackgroundTask }) {
  const t = useT();
  if (task.kind !== 'terminal' || task.status !== 'running' || task.terminal?.terminalId == null) {
    return null;
  }
  return (
    <button
      type="button"
      className="button"
      data-testid="bg-task-open-terminal"
      onClick={() => {
        showTerminal(task.ownerSessionId, task.taskId);
        showPanel('terminal');
      }}
    >
      {t('bgTasks.openTerminal')}
    </button>
  );
}

function TaskSummary({ task, now }: { readonly task: BackgroundTask; readonly now: number }) {
  const t = useT();
  const code =
    task.exitCode === undefined || task.status === 'running'
      ? undefined
      : t('bgTasks.exitCode', { code: String(task.exitCode) });
  return (
    <div className="bg-task-summary">
      <span className="bg-task-kind">{t(KIND_MESSAGE[task.kind])}</span>
      <span className="bg-task-title" title={task.command ?? task.title}>
        {task.title}
      </span>
      <span className="bg-task-status" data-status={task.status}>
        {t(STATUS_MESSAGE[task.status])}
        {code === undefined ? '' : ` · ${code}`}
      </span>
      <span className="bg-task-duration">{formatDuration(taskDuration(task, now))}</span>
    </div>
  );
}

/** The rail card: the selected session's background tasks. */
export function TasksCard({ sessionId }: { readonly sessionId: string }) {
  const t = useT();
  const all = useTasks();
  const tasks = useMemo(() => tasksOfSession(all, sessionId), [all, sessionId]);
  const now = useNow(tasks.some((task) => task.status === 'running'));
  return (
    <div className="bg-tasks-card" data-testid="bg-tasks-card">
      {tasks.length === 0 ? (
        <p className="muted">{t('bgTasks.empty')}</p>
      ) : (
        <ul className="bg-task-list">
          {tasks.map((task) => (
            <li key={task.taskId} className="bg-task" data-testid="bg-task" data-task={task.taskId}>
              <TaskSummary task={task} now={now} />
              {task.status === 'running' && (task.tail ?? []).length > 0 ? (
                <pre className="bg-task-tail">
                  {(task.tail ?? []).slice(-CARD_LINES).join('\n')}
                </pre>
              ) : null}
              <StopButton task={task} />
              <OpenTerminalButton task={task} />
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="button"
        onClick={() => {
          showPanel('background-tasks');
        }}
      >
        {t('bgTasks.openPanel')}
      </button>
    </div>
  );
}

interface Loaded {
  /** Byte offset of the first byte read. */
  readonly start: number;
  /** Where the next read starts. */
  readonly end: number;
  readonly text: string;
}

/** What a viewer uses of a `TaskOutputChunk`. */
interface Chunk {
  readonly text: string;
  readonly nextOffset: number;
}

function chunkOf(json: string): Chunk {
  const value: unknown = JSON.parse(json);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('text' in value) ||
    !('nextOffset' in value) ||
    typeof value.text !== 'string' ||
    typeof value.nextOffset !== 'number'
  ) {
    throw new Error('malformed output chunk');
  }
  return { text: value.text, nextOffset: value.nextOffset };
}

/** A task's output: its end first, more as it grows, earlier parts on request. */
function TaskOutput({ task }: { readonly task: BackgroundTask }) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<string>();
  const reading = useRef(false);
  const bytes = task.outputBytes;
  useEffect(() => {
    if (task.outputPath == null || reading.current) return;
    const read = (offset: number, apply: (chunk: Chunk) => void) => {
      reading.current = true;
      window.piarc
        .readTaskOutput(task.taskId, offset, CHUNK)
        .then((json) => {
          apply(chunkOf(json));
          setError(undefined);
        })
        .catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          reading.current = false;
        });
    };
    if (loaded === undefined) {
      const start = Math.max(0, bytes - CHUNK);
      read(start, (chunk) => {
        setLoaded({ start, end: chunk.nextOffset, text: chunk.text });
      });
    } else if (bytes > loaded.end) {
      read(loaded.end, (chunk) => {
        setLoaded((old) =>
          old === undefined
            ? old
            : { ...old, end: chunk.nextOffset, text: (old.text + chunk.text).slice(-KEPT_CHARS) },
        );
      });
    }
  }, [task.taskId, task.outputPath, bytes, loaded]);
  if (task.outputPath == null) {
    return <p className="muted small">{t('bgTasks.noOutputFile')}</p>;
  }
  const earlier = () => {
    if (loaded === undefined || loaded.start === 0) return;
    const start = Math.max(0, loaded.start - CHUNK);
    window.piarc
      .readTaskOutput(task.taskId, start, loaded.start - start)
      .then((json) => {
        const chunk = chunkOf(json);
        setLoaded((old) =>
          old === undefined
            ? old
            : { ...old, start, text: (chunk.text + old.text).slice(0, KEPT_CHARS) },
        );
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };
  return (
    <div className="bg-task-output" data-testid="bg-task-output">
      {loaded !== undefined && loaded.start > 0 ? (
        <button type="button" className="button" onClick={earlier}>
          {t('bgTasks.loadMore')}
        </button>
      ) : null}
      {error === undefined ? null : (
        <p className="bg-task-error" role="alert">
          {t('bgTasks.readFailed', { reason: error })}
        </p>
      )}
      {loaded === undefined || loaded.text.length === 0 ? (
        <p className="muted small">{t('bgTasks.noOutput')}</p>
      ) : (
        <pre className="bg-task-log">{loaded.text}</pre>
      )}
      <p className="muted small">
        {t('bgTasks.outputSize', { bytes: String(bytes) })}
        {` · ${task.outputPath ?? ''}`}
      </p>
    </div>
  );
}

/** The dock panel: the background tasks of the selected session's workspace, by session. */
export function TasksPanel({ sessionId }: { readonly sessionId: string | undefined }) {
  const t = useT();
  const all = useTasks();
  const sessions = useSessions();
  const workspace = useSession(sessionId)?.workspace;
  const [open, setOpen] = useState<string>();
  const groups = useMemo(() => {
    const ofWorkspace = all.filter((task) => task.workspace === workspace);
    const order: string[] = [];
    const bySession = new Map<string, BackgroundTask[]>();
    for (const task of ofWorkspace) {
      const list = bySession.get(task.ownerSessionId);
      if (list === undefined) {
        order.push(task.ownerSessionId);
        bySession.set(task.ownerSessionId, [task]);
      } else {
        list.push(task);
      }
    }
    // The selected session first.
    order.sort((a, b) => Number(b === sessionId) - Number(a === sessionId));
    return order.map((id) => ({ id, tasks: bySession.get(id) ?? [] }));
  }, [all, workspace, sessionId]);
  const now = useNow(all.some((task) => task.status === 'running'));
  if (groups.length === 0) {
    return (
      <div className="bg-tasks-panel" data-testid="bg-tasks-panel">
        <p className="muted">{t('bgTasks.workspaceEmpty')}</p>
      </div>
    );
  }
  return (
    <div className="bg-tasks-panel" data-testid="bg-tasks-panel">
      {groups.map((group) => {
        const title = sessions.find((s) => s.id === group.id)?.title ?? group.id;
        return (
          <section key={group.id} className="bg-task-group">
            <h3 className="bg-task-group-title">{t('bgTasks.otherSession', { title })}</h3>
            <ul className="bg-task-list">
              {group.tasks.map((task) => (
                <li
                  key={task.taskId}
                  className="bg-task"
                  data-testid="bg-panel-task"
                  data-task={task.taskId}
                >
                  <TaskSummary task={task} now={now} />
                  <div className="bg-task-actions">
                    <button
                      type="button"
                      className="button"
                      aria-expanded={open === task.taskId}
                      onClick={() => {
                        setOpen(open === task.taskId ? undefined : task.taskId);
                      }}
                    >
                      {t(open === task.taskId ? 'bgTasks.hideOutput' : 'bgTasks.showOutput')}
                    </button>
                    <StopButton task={task} />
                    <OpenTerminalButton task={task} />
                  </div>
                  {open === task.taskId ? <TaskOutput task={task} /> : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
