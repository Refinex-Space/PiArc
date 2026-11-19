// Rows of the Harness Kit's host tools (T26, architecture section 8.2): the task card
// (TodoWrite), the plan card (ExitPlanMode), the answered questions (AskUserQuestion) and the
// next-step suggestions (SuggestNextSteps). They read the call's arguments and result as the
// transcript holds them, live and in history alike; the rail's task card and the plan panel read
// the session's harness state instead.
import { useContext, useState } from 'react';
import type { Item, TodoItem } from '@piarc/protocol';

import { useT } from '../../app/app-context.js';
import { useUi, UiContext } from '../../shell/ui.js';
import { showPanel } from '../../shell/registry.js';
import { reason } from '../../shell/errors.js';
import { startSession } from '../../shell/start-session.js';
import { SessionInput } from '../../shell/session-input.js';
import { StoreContext } from '../../store/hooks.js';
import { todosOf } from '../../store/harness.js';

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
export function TaskList({ todos }: { readonly todos: readonly TodoItem[] }) {
  const t = useT();
  const done = todos.filter((todo) => todo.status === 'completed').length;
  return (
    <div className="task-list">
      <div className="task-count muted" data-testid="task-count">
        {t('tasks.count', { done, total: todos.length })}
      </div>
      <ol>
        {todos.map((todo, i) => (
          <li
            key={String(i)}
            className={`task task-${todo.status}`}
            data-status={todo.status}
            data-testid="task"
          >
            <span className="task-mark" role="img" aria-label={t(`tasks.status.${todo.status}`)}>
              {todo.status === 'completed' ? '✓' : todo.status === 'inProgress' ? '◐' : '○'}
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

function TaskCard({ item }: { readonly item: ToolItem }) {
  const t = useT();
  const todos = taskListOf(item.arguments);
  if (todos === undefined) return null;
  return (
    <section
      className="row harness-card task-card"
      data-testid="task-card"
      data-status={item.status}
    >
      <header>
        <strong>{t('tasks.title')}</strong>
      </header>
      <TaskList todos={todos} />
    </section>
  );
}

/** The first lines of a plan. */
export function planPreview(plan: string, lines = 8): string {
  const all = plan.split('\n');
  return all.length > lines ? all.slice(0, lines).join('\n') + '\n…' : plan;
}

function PlanCard({ item }: { readonly item: ToolItem }) {
  const t = useT();
  const plan = typeof item.arguments.plan === 'string' ? item.arguments.plan : '';
  const status =
    item.status === 'completed'
      ? 'approved'
      : item.status === 'declined' || item.status === 'failed'
        ? 'declined'
        : item.status === 'interrupted'
          ? 'interrupted'
          : 'pending';
  return (
    <section className="row harness-card plan-row" data-testid="plan-row" data-status={status}>
      <header>
        <strong>{t('plan.title')}</strong>{' '}
        <span className="muted" data-testid="plan-status">
          {t(`plan.status.${status}`)}
        </span>
      </header>
      <pre className="plan-preview">{planPreview(plan)}</pre>
      <button
        type="button"
        className="row-action"
        onClick={() => {
          showPanel('plan');
        }}
      >
        {t('plan.openPanel')}
      </button>
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
      <dl>
        {answers.map((a, i) => (
          <div key={String(i)} data-outcome={a.outcome}>
            <dt>{a.question}</dt>
            <dd>
              {a.answer || '—'} <span className="muted">{t(`question.outcome.${a.outcome}`)}</span>
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

function NextStepActions({ prompt }: { readonly prompt: string }) {
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
          className="button button-small"
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
      {error && <p role="alert">{error}</p>}
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
      <header>
        <strong>{t('next.title')}</strong>
      </header>
      <ul>
        {suggestions.map((s, i) => (
          <li key={String(i)} data-testid="next-step">
            <div className="next-step-title">{s.title}</div>
            <div className="next-step-prompt muted">{s.prompt}</div>
            {shell && <NextStepActions prompt={s.prompt} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The row of a host tool call, or null for the calls that stay in tool groups. */
export function HostToolRow({ item }: { readonly item: ToolItem }) {
  switch (item.tool) {
    case 'TodoWrite':
      return <TaskCard item={item} />;
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
