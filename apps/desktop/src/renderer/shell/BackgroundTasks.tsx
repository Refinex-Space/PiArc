// Background tasks in the window (T32, architecture section 8.2): the rail card lists the
// selected session's tasks (kind, status, how long, the last lines, a stop button); the dock
// panel lists the tasks of the workspace's sessions and shows a task's output, read from Core
// in parts (`readTaskOutput`) so the window never holds a whole log. Stopping goes through
// `stopTask`, the same Core entry as KillShell.
import type { BackgroundTask, TaskStatus } from '@piarc/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { MessageId } from '../../shared/i18n/index.js';
import { useT } from '../app/app-context.js';
import { useSession, useSessions, useTasks } from '../store/hooks.js';
import { durationParts, taskDuration, tasksOfSession } from '../store/tasks.js';
import { showTerminal } from '../terminal/panel-state.js';
import { ChevronDownIcon, SideChatIcon, TasksIcon, TerminalIcon } from './icons.js';
import { revealBidi } from '../transcript/reveal.js';
import { SCROLL_FOLLOW } from '../transcript/constants.js';
import { PanelEmpty } from './PanelEmpty.js';
import { IconButton } from '../app/IconButton.js';
import { StopIcon } from './icons.js';
import { Button } from '../app/Button.js';
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
      <IconButton
        label={t(stopping ? 'bgTasks.stopping' : 'bgTasks.stop')}
        className="bg-task-stop"
        disabled={stopping}
        onClick={stop}
        data-testid="bg-task-stop"
      >
        <StopIcon />
      </IconButton>
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
    <Button
      size="small"
      variant="ghost"
      data-testid="bg-task-open-terminal"
      onClick={() => {
        showTerminal(task.ownerSessionId, task.taskId);
        showPanel('terminal');
      }}
    >
      {t('bgTasks.openTerminal')}
    </Button>
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
      <span className="bg-task-icon" aria-hidden="true">
        {task.kind === 'subagent' ? (
          <SideChatIcon />
        ) : task.kind === 'monitor' ? (
          <TasksIcon />
        ) : (
          <TerminalIcon />
        )}
      </span>
      <span className="bg-task-kind">{t(KIND_MESSAGE[task.kind])}</span>
      <span className="bg-task-title" title={revealBidi(task.command ?? task.title)}>
        {revealBidi(task.title)}
      </span>
      <span className="bg-task-status" data-status={task.status}>
        {t(STATUS_MESSAGE[task.status])}
        {code === undefined ? '' : ` · ${code}`}
      </span>
      <span className="bg-task-duration">
        {t('bgTasks.duration', durationParts(taskDuration(task, now)))}
      </span>
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
              {task.status === 'running' && (
                <div className="bg-card-actions">
                  <OpenTerminalButton task={task} />
                  <StopButton task={task} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Button
        size="small"
        variant="ghost"
        className="bg-card-all"
        onClick={() => {
          showPanel('background-tasks');
        }}
      >
        {t('bgTasks.openPanel')}
      </Button>
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
  const log = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    if (log.current && following.current) log.current.scrollTop = log.current.scrollHeight;
  }, [loaded]);
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
    following.current = false;
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
      {loaded === undefined ? (
        error === undefined ? (
          <p className="muted small" role="status">
            {t('agents.loading')}
          </p>
        ) : null
      ) : loaded.text.length === 0 ? (
        <p className="muted small">{t('bgTasks.noOutput')}</p>
      ) : (
        <pre
          className="bg-task-log"
          ref={log}
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current =
              element.scrollHeight - element.clientHeight - element.scrollTop <=
              SCROLL_FOLLOW.resumePx;
          }}
        >
          {loaded.text}
        </pre>
      )}
      <p className="bg-task-output-meta muted small">
        {t('bgTasks.outputSize', { bytes: String(bytes) })}
        <span title={revealBidi(task.outputPath)}>{revealBidi(task.outputPath)}</span>
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
  const now = useNow(groups.some((group) => group.tasks.some((task) => task.status === 'running')));
  if (groups.length === 0) {
    return (
      <div className="bg-tasks-panel" data-testid="bg-tasks-panel">
        <PanelEmpty icon={<TasksIcon />} title={t('bgTasks.workspaceEmpty')} />
      </div>
    );
  }
  return (
    <div className="bg-tasks-panel" data-testid="bg-tasks-panel">
      {groups.map((group) => {
        const title = sessions.find((s) => s.id === group.id)?.title ?? group.id;
        return (
          <section key={group.id} className="bg-task-group">
            <h2 className="bg-task-group-title">{t('bgTasks.otherSession', { title })}</h2>
            <SessionTaskList tasks={group.tasks} now={now} />
          </section>
        );
      })}
    </div>
  );
}

/** Keep finished output reachable while the active jobs remain the first rows in a group. */
function SessionTaskList({ tasks, now }: { tasks: readonly BackgroundTask[]; now: number }) {
  const t = useT();
  const [open, setOpen] = useState<string>();
  const [showFinished, setShowFinished] = useState<boolean>();
  const running = tasks.filter((task) => task.status === 'running');
  const finished = tasks.filter((task) => task.status !== 'running');
  const expanded =
    showFinished ?? (running.length === 0 || finished.some((task) => task.taskId === open));
  const list = (items: readonly BackgroundTask[]) => (
    <ul className="bg-task-list">
      {items.map((task) => (
        <li
          key={task.taskId}
          className="bg-task"
          data-testid="bg-panel-task"
          data-task={task.taskId}
        >
          <TaskSummary task={task} now={now} />
          <div className="bg-task-actions">
            <Button
              size="small"
              variant="ghost"
              className="bg-task-disclosure"
              aria-expanded={open === task.taskId}
              onClick={() => {
                setOpen(open === task.taskId ? undefined : task.taskId);
              }}
            >
              <ChevronDownIcon />
              {t(open === task.taskId ? 'bgTasks.hideOutput' : 'bgTasks.showOutput')}
            </Button>
            <StopButton task={task} />
            <OpenTerminalButton task={task} />
          </div>
          {open === task.taskId ? <TaskOutput task={task} /> : null}
        </li>
      ))}
    </ul>
  );
  return (
    <>
      {running.length > 0 && list(running)}
      {finished.length > 0 && (
        <div className="bg-task-history">
          <button
            type="button"
            className="bg-task-history-toggle"
            aria-expanded={expanded}
            onClick={() => {
              setShowFinished(!expanded);
            }}
          >
            <ChevronDownIcon />
            {t('bgTasks.finishedGroup', { count: finished.length })}
          </button>
          {expanded && list(finished)}
        </div>
      )}
    </>
  );
}
