// The Harness Kit's host tools of one session (T26, architecture section 6.5): what the
// registry wires in. Tools need Core's matching capability: `planMode` (EnterPlanMode,
// ExitPlanMode), `todo` (TodoWrite), `ask` (AskUserQuestion); SuggestNextSteps needs none.
// The reminders module is shared by plan mode and the task list; T27 extends it.
import type {
  AgentSessionEvent,
  ExtensionFactory,
  SessionEntry,
  SessionManager,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { HarnessState, PermissionMode } from '@piarc/protocol';

import type { CoreBridge } from '../runtime/core-bridge.js';
import type { ProjectionSink } from '../runtime/projector.js';
import type { ToolProfile } from '../tools/profile.js';
import {
  createEnterPlanModeTool,
  createExitPlanModeTool,
  currentPlan,
  PlanMode,
} from './plan-mode.js';
import { createAskUserQuestionTool } from './questions.js';
import { createSuggestNextStepsTool } from './next-steps.js';
import { Reminders } from './reminders.js';
import { createTodoWriteTool, currentTodos, todosOf, todoWatch } from './todos.js';

/** What Core enabled for the host tools in the handshake. */
export interface HostToolCapabilities {
  readonly bridge: CoreBridge;
  readonly planMode: boolean;
  readonly todo: boolean;
  readonly ask: boolean;
}

/** The plan and task list at the head of a branch, or undefined when it has neither. */
export function harnessState(
  entries: readonly SessionEntry[],
  canonical: (tool: string) => string,
): HarnessState | undefined {
  const plan = currentPlan(entries);
  const todos = currentTodos(entries, canonical);
  if (plan === undefined && todos.length === 0) return undefined;
  return { ...(plan === undefined ? {} : { plan }), ...(todos.length === 0 ? {} : { todos }) };
}

export class SessionHarness {
  readonly reminders = new Reminders();
  readonly planMode: PlanMode;
  readonly #sessionId: string;
  readonly #manager: SessionManager;
  readonly #sink: ProjectionSink;
  readonly #profile: ToolProfile;
  readonly #canonical: (tool: string) => string;
  readonly #core: HostToolCapabilities | undefined;

  constructor(options: {
    readonly sessionId: string;
    readonly manager: SessionManager;
    readonly sink: ProjectionSink;
    readonly profile: ToolProfile;
    readonly canonical: (tool: string) => string;
    readonly activeTurn: () => string | undefined;
    readonly core: HostToolCapabilities | undefined;
  }) {
    this.#sessionId = options.sessionId;
    this.#manager = options.manager;
    this.#sink = options.sink;
    this.#profile = options.profile;
    this.#canonical = options.canonical;
    this.#core = options.core;
    this.planMode = new PlanMode({
      manager: options.manager,
      sink: options.sink,
      reminders: this.reminders,
      activeTurn: options.activeTurn,
    });
  }

  /** The host tools this session gets. */
  tools(): ToolDefinition[] {
    const profile = this.#profile;
    const core = this.#core;
    return [
      ...(core?.planMode === true
        ? [
            createEnterPlanModeTool(profile.EnterPlanMode, this.planMode),
            createExitPlanModeTool(profile.ExitPlanMode, this.planMode),
          ]
        : []),
      ...(core?.todo === true ? [createTodoWriteTool(profile.TodoWrite)] : []),
      ...(core?.ask === true
        ? [createAskUserQuestionTool(profile.AskUserQuestion, core.bridge, this.#sessionId)]
        : []),
      createSuggestNextStepsTool(profile.SuggestNextSteps),
    ];
  }

  /** Extensions in order: the stale-list watch queues at `turn_end`, then the reminders
   * deliver. */
  extensions(): ExtensionFactory[] {
    return [todoWatch(this.#manager, this.reminders, this.#canonical), this.reminders.extension];
  }

  /** A mode switch the user or Core made: recorded on the branch, told to the model. */
  recordMode(mode: PermissionMode): void {
    this.planMode.record(mode);
  }

  /** After the projector handled `event`: a new task list follows its `item/completed`. */
  onEvent(event: AgentSessionEvent): void {
    if (
      event.type !== 'tool_execution_end' ||
      event.parentToolCallId !== undefined ||
      event.isError ||
      this.#canonical(event.toolName) !== 'TodoWrite'
    ) {
      return;
    }
    const result: unknown = event.result;
    const todos =
      typeof result === 'object' && result !== null && 'details' in result
        ? todosOf(result.details)
        : undefined;
    if (todos === undefined) return;
    this.#sink.event('harness/todo', {
      itemId: event.toolCallId,
      todos: todos.map((todo) => ({
        ...todo,
        content: todo.content.toWellFormed(),
        ...(todo.activeForm == null ? {} : { activeForm: todo.activeForm.toWellFormed() }),
      })),
    });
  }
}
