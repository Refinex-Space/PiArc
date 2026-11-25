// Rows of the Harness Kit's host tools (T26, architecture section 8.2): the task card
// (TodoWrite), the plan card (ExitPlanMode), the answered questions (AskUserQuestion) and the
// next-step suggestions (SuggestNextSteps). They read the call's arguments and result as the
// transcript holds them, live and in history alike; the rail's task card and the plan panel read
// the session's harness state instead.
import { useContext, useEffect, useRef, useState } from 'react';
import type { Item, TodoItem } from '@piarc/protocol';

import { useT } from '../../app/app-context.js';
import { DoneGlyph, PendingGlyph, SpinnerGlyph } from '../../shell/icons.js';
import { useUi, UiContext } from '../../shell/ui.js';
import { showPanel } from '../../shell/registry.js';
import { reason } from '../../shell/errors.js';
import { startSession } from '../../shell/start-session.js';
import { SessionInput } from '../../shell/session-input.js';
import { StoreContext } from '../../store/hooks.js';
import { todosOf } from '../../store/harness.js';
import { MarkdownView } from '../markdown/MarkdownView.js';
import { useExpanded, useParsedDoc, useTaskPlace, useTranscriptView } from '../services.js';
import { Segments, StepRow } from './parts.js';

type ToolItem = Extract<Item, { type: 'dynamicToolCall' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The list a TodoWrite call wrote, from its arguments (Claude Code's status spelling). */
export function taskListOf(args: Record<string, unknown>): TodoItem[] | undefined {
  if (!Array.isArray(args.todos)) return undefined;
  return todosOf(
    args.todos.map((todo: unknown) =>
      isRecord(todo) && todo.status === 'in_progress' ? { ...todo, status: 'inProgress' } : todo,
    ),
  );
}

/** A task list with its progress: the task in progress stands out, done ones are struck. */
export function TaskList({
  todos,
  counted = true,
}: {
  readonly todos: readonly TodoItem[];
  /** Shows "n/m done" above the list (not when the line above already says it). */
  readonly counted?: boolean;
}) {
  const t = useT();
  const done = todos.filter((todo) => todo.status === 'completed').length;
  return (
    <div className="task-list">
      {counted && (
        <div className="task-count muted" data-testid="task-count">
          {t('tasks.count', { done, total: todos.length })}
        </div>
      )}
      <ol>
        {todos.map((todo, i) => (
          <li
            key={String(i)}
            className={`task task-${todo.status}`}
            data-status={todo.status}
            data-testid="task"
          >
            <span className="task-mark" role="img" aria-label={t(`tasks.status.${todo.status}`)}>
              {todo.status === 'completed' ? (
                <DoneGlyph />
              ) : todo.status === 'inProgress' ? (
                <SpinnerGlyph />
              ) : (
                <PendingGlyph />
              )}
            </span>
            <span className="task-text">
              {todo.status === 'inProgress' ? (todo.activeForm ?? todo.content) : todo.content}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** What one TodoWrite call changed, against the call before it. */
export interface TaskChange {
  readonly kind: 'listed' | 'completed' | 'started' | 'added' | 'updated';
  /** The first task it names. */
  readonly task?: string | undefined;
  /** How many more tasks changed the same way. */
  readonly more: number;
}

/** The change the line of an earlier TodoWrite call names: finished work first. */
export function taskChange(
  before: readonly TodoItem[] | undefined,
  after: readonly TodoItem[],
): TaskChange {
  if (before === undefined) return { kind: 'listed', more: 0 };
  const was = new Map(before.map((todo) => [todo.content, todo.status]));
  const pick = (kind: TaskChange['kind'], tasks: readonly TodoItem[]): TaskChange | undefined =>
    tasks[0] === undefined ? undefined : { kind, task: tasks[0].content, more: tasks.length - 1 };
  return (
    pick(
      'completed',
      after.filter((todo) => todo.status === 'completed' && was.get(todo.content) !== 'completed'),
    ) ??
    pick(
      'started',
      after.filter(
        (todo) => todo.status === 'inProgress' && was.get(todo.content) !== 'inProgress',
      ),
    ) ??
    pick(
      'added',
      after.filter((todo) => !was.has(todo.content)),
    ) ?? { kind: 'updated', more: 0 }
  );
}

function TaskCard({ id, item }: { readonly id: string; readonly item: ToolItem }) {
  const t = useT();
  const todos = taskListOf(item.arguments);
  const place = useTaskPlace(id);
  if (todos === undefined) return null;
  // A later call replaced this list: one line names what changed, the list opens below it.
  if (!place.latest) return <TaskUpdate id={id} todos={todos} previous={place.previous} />;
  return (
    <section
      className="row harness-card task-card"
      data-testid="task-card"
      data-status={item.status}
    >
      <div className="harness-box">
        <header className="harness-title">
          <strong>{t('tasks.title')}</strong>
        </header>
        <TaskList todos={todos} />
      </div>
    </section>
  );
}

function TaskUpdate({
  id,
  todos,
  previous,
}: {
  readonly id: string;
  readonly todos: readonly TodoItem[];
  readonly previous: string | undefined;
}) {
  const t = useT();
  const { transcript } = useTranscriptView();
  const [expanded, setExpanded] = useExpanded(`tasks:${id}`, false);
  // The call before is finished: reading it once per render is enough.
  const before = previous === undefined ? undefined : transcript.row(previous);
  const change = taskChange(
    before?.kind === 'item' && before.item.type === 'dynamicToolCall'
      ? taskListOf(before.item.arguments)
      : undefined,
    todos,
  );
  const done = todos.filter((todo) => todo.status === 'completed').length;
  return (
    <section className="row row-task-update" data-testid="task-update" data-change={change.kind}>
      <StepRow
        verb={t(`tasks.change.${change.kind}`)}
        meta={change.task}
        metaTitle={change.task}
        state="done"
        trail={
          <Segments>
            {[
              change.more > 0 ? t('tasks.change.more', { count: change.more }) : null,
              t('tasks.count', { done, total: todos.length }),
            ]}
          </Segments>
        }
        expanded={expanded}
        onToggle={() => {
          setExpanded(!expanded);
        }}
      >
        <TaskList todos={todos} counted={false} />
      </StepRow>
    </section>
  );
}

/**
 * A plan as Markdown. On the card waiting for review it scrolls (and takes focus then, so the
 * keyboard can scroll it); in the transcript it shows the start, faded, and the plan panel
 * holds the rest.
 */
export function PlanMarkdown({
  id,
  plan,
  scroll,
}: {
  /** The call or request the plan belongs to: one parse per plan. */
  readonly id: string;
  readonly plan: string;
  readonly scroll: boolean;
}) {
  const t = useT();
  const { services, transcript } = useTranscriptView();
  const docKey = transcript.cacheKey(`plan:${id}`);
  const parsed = useParsedDoc(docKey);
  useEffect(() => {
    services.markdown.parseFinished(docKey, plan);
  }, [services, docKey, plan]);
  const box = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = box.current;
    const Observer = element?.ownerDocument.defaultView?.ResizeObserver;
    if (element === null || Observer === undefined) return;
    // The box stops growing at its cap: watch the content too.
    const observer = new Observer(() => {
      setOverflows(element.scrollHeight > element.clientHeight + 1);
    });
    observer.observe(element);
    if (element.firstElementChild !== null) observer.observe(element.firstElementChild);
    return () => {
      observer.disconnect();
    };
  }, [parsed]);
  const focusable = scroll && overflows;
  return (
    <div
      ref={box}
      className="plan-preview"
      data-testid="plan-preview"
      data-scroll={scroll}
      data-overflows={overflows}
      {...(focusable ? { tabIndex: 0, role: 'region', 'aria-label': t('plan.title') } : {})}
    >
      {parsed === undefined ? (
        <p className="md-fallback">{plan}</p>
      ) : (
        <MarkdownView blocks={parsed.blocks} />
      )}
    </div>
  );
}

/** Where a submitted plan stands, from its `ExitPlanMode` call. */
export function planStatus(item: ToolItem): 'approved' | 'declined' | 'interrupted' | 'pending' {
  return item.status === 'completed'
    ? 'approved'
    : item.status === 'declined' || item.status === 'failed'
      ? 'declined'
      : item.status === 'interrupted'
        ? 'interrupted'
        : 'pending';
}

function PlanCard({ item }: { readonly item: ToolItem }) {
  const t = useT();
  const plan = typeof item.arguments.plan === 'string' ? item.arguments.plan : '';
  const status = planStatus(item);
  return (
    <section className="row harness-card plan-row" data-testid="plan-row" data-status={status}>
      <div className="harness-box">
        <header className="harness-title">
          <strong>{t('plan.title')}</strong>
          <span className="harness-status" data-testid="plan-status">
            {t(`plan.status.${status}`)}
          </span>
          <button
            type="button"
            className="approval-link harness-link"
            onClick={() => {
              showPanel('plan');
            }}
          >
            {t('plan.openPanel')}
          </button>
        </header>
        <PlanMarkdown id={item.itemId} plan={plan} scroll={false} />
      </div>
    </section>
  );
}

interface AnswerLine {
  readonly question: string;
  readonly outcome: 'answered' | 'default' | 'unanswered' | 'declined';
  readonly answer: string;
}

/** The answers in an AskUserQuestion result (the JSON after its first line). */
export function answersOf(output: string | null | undefined): AnswerLine[] {
  const json = output?.slice(output.indexOf('\n') + 1);
  if (!json) return [];
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  if (!isRecord(value) || !Array.isArray(value.answers)) return [];
  return value.answers.flatMap((a: unknown) => {
    if (
      !isRecord(a) ||
      typeof a.question !== 'string' ||
      (a.outcome !== 'answered' &&
        a.outcome !== 'default' &&
        a.outcome !== 'unanswered' &&
        a.outcome !== 'declined')
    ) {
      return [];
    }
    const picked = Array.isArray(a.selected)
      ? a.selected.filter((s): s is string => typeof s === 'string')
      : [];
    const answer = [...picked, ...(typeof a.other === 'string' ? [a.other] : [])].join(', ');
    return [{ question: a.question, outcome: a.outcome, answer }];
  });
}

function QuestionSummary({ item }: { readonly item: ToolItem }) {
  const t = useT();
  const answers = answersOf(item.output);
  if (answers.length === 0) return null;
  return (
    <section className="row harness-card question-row" data-testid="question-row">
      <dl className="harness-box answers">
        {answers.map((a, i) => (
          <div key={String(i)} data-outcome={a.outcome}>
            <dt>{a.question}</dt>
            <dd>
              {a.answer || '—'}{' '}
              <span className="harness-status">{t(`question.outcome.${a.outcome}`)}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

interface Suggestion {
  readonly title: string;
  readonly prompt: string;
}

export function suggestionsOf(args: Record<string, unknown>): Suggestion[] {
  if (!Array.isArray(args.suggestions)) return [];
  return args.suggestions.flatMap((s: unknown) =>
    isRecord(s) && typeof s.title === 'string' && typeof s.prompt === 'string'
      ? [{ title: s.title, prompt: s.prompt }]
      : [],
  );
}

/** Runs a suggestion in the shown session, or starts a session in its workspace with it. */
function useNextStepActions(): {
  readonly runHere: (prompt: string) => Promise<void>;
  readonly startNew: (prompt: string) => Promise<void>;
} {
  const ui = useUi();
  const store = useContext(StoreContext);
  const sessionId = ui.view.kind === 'session' ? ui.view.id : undefined;
  return {
    runHere: async (prompt) => {
      if (store === null || sessionId === undefined) return;
      const input = new SessionInput(window.piarc, store, sessionId);
      const draft = { text: prompt, mentions: [], pending: [], stored: [] };
      if (store.transcript(sessionId).isRunning()) await input.add('followUp', draft);
      else await input.send(draft);
    },
    startNew: async (prompt) => {
      const workspace = sessionId === undefined ? undefined : store?.session(sessionId)?.workspace;
      if (store === null || workspace === undefined) return;
      if (!(await ui.ensureTrust(workspace, 'decide'))) return;
      await startSession({
        api: window.piarc,
        store,
        workspace,
        text: prompt,
        clientId: crypto.randomUUID(),
        watch: (id) => ui.connection.watchSession(id),
        onStep: (step) => {
          if (step.kind === 'created') ui.show({ kind: 'session', id: step.sessionId });
        },
      });
    },
  };
}

function NextStepActions({
  prompt,
  primary,
}: {
  readonly prompt: string;
  /** The first suggestion leads: its "Run here" is the primary action. */
  readonly primary: boolean;
}) {
  const t = useT();
  const actions = useNextStepActions();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = (action: (prompt: string) => Promise<void>) => {
    setBusy(true);
    setError('');
    action(prompt)
      .catch((cause: unknown) => {
        setError(t('next.failed', { reason: reason(cause) }));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <>
      <div className="next-step-actions">
        <button
          type="button"
          className={`button button-small${primary ? ' button-primary' : ''}`}
          disabled={busy}
          data-testid="next-run-here"
          onClick={() => {
            run(actions.runHere);
          }}
        >
          {t('next.runHere')}
        </button>
        <button
          type="button"
          className="button button-small"
          disabled={busy}
          data-testid="next-new-session"
          onClick={() => {
            run(actions.startNew);
          }}
        >
          {t('next.newSession')}
        </button>
      </div>
      {error && (
        <p className="approval-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function NextStepsRow({ item }: { readonly item: ToolItem }) {
  const t = useT();
  // The prototype page has no window shell: it shows the suggestions without their actions.
  const shell = useContext(UiContext) !== null;
  const suggestions = suggestionsOf(item.arguments);
  if (suggestions.length === 0) return null;
  return (
    <section className="row harness-card next-steps" data-testid="next-steps">
      <div className="harness-box">
        <header className="harness-title">
          <strong>{t('next.title')}</strong>
        </header>
        <ul>
          {suggestions.map((s, i) => (
            <li key={String(i)} data-testid="next-step">
              <div className="next-step-title">{s.title}</div>
              <div className="next-step-prompt muted">{s.prompt}</div>
              {shell && <NextStepActions prompt={s.prompt} primary={i === 0} />}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** The row of a host tool call, or null for the calls that stay in tool groups. */
export function HostToolRow({ id, item }: { readonly id: string; readonly item: ToolItem }) {
  switch (item.tool) {
    case 'TodoWrite':
      return <TaskCard id={id} item={item} />;
    case 'ExitPlanMode':
      return <PlanCard item={item} />;
    case 'AskUserQuestion':
      return <QuestionSummary item={item} />;
    case 'SuggestNextSteps':
      return <NextStepsRow item={item} />;
    default:
      return null;
  }
}
