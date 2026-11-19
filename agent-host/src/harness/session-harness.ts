// The Harness Kit of one session: what the registry wires in.
//
// - Host tools (T26, architecture section 6.5): Core's capabilities `planMode` (EnterPlanMode,
//   ExitPlanMode), `todo` (TodoWrite), `ask` (AskUserQuestion); SuggestNextSteps needs none.
// - The system reminder channel (T27, reminders.ts) that plan mode, the task list, memory,
//   hooks, files changed outside the session and background tasks all go through.
// - Context engineering (T27, capability `context`): compaction (settings, summary, restore,
//   circuit breaker; compaction.ts) and context usage (context-usage.ts).
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionFactory,
  SessionEntry,
  SessionManager,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type {
  ContextUsage,
  HarnessState,
  PermissionMode,
  SessionRemindParams,
} from '@piarc/protocol';

import { AhpError } from '../protocol/errors.js';
import type { CoreBridge } from '../runtime/core-bridge.js';
import type { ProjectionSink } from '../runtime/projector.js';
import type { CoreIo } from '../tools/core-io.js';
import type { ToolProfile } from '../tools/profile.js';
import { SessionCompaction } from './compaction.js';
import { ContextUsageTracker } from './context-usage.js';
import { fileChanges } from './file-changes.js';
import type { SessionHooks } from './hooks.js';
import {
  createEnterPlanModeTool,
  createExitPlanModeTool,
  currentPlan,
  PlanMode,
} from './plan-mode.js';
import { backgroundTaskNotice } from './prompts/notices.js';
import { createAskUserQuestionTool } from './questions.js';
import { createSuggestNextStepsTool } from './next-steps.js';
import { Reminders, type ReminderMessage } from './reminders.js';
import type { SessionMemory } from './session-memory.js';
import { createTodoWriteTool, currentTodos, todosOf, todoWatch } from './todos.js';

/** What Core enabled for the host tools in the handshake. */
export interface HostToolCapabilities {
  readonly bridge: CoreBridge;
  readonly planMode: boolean;
  readonly todo: boolean;
  readonly ask: boolean;
  /** `context` (T27): reminders as items, file changes, compaction settings, usage. */
  readonly context?: boolean;
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

const SILENT: ProjectionSink = {
  event: () => undefined,
  delta: () => undefined,
  replaceable: () => undefined,
};

export interface SessionHarnessOptions {
  readonly sessionId: string;
  readonly manager: SessionManager;
  readonly sink: ProjectionSink;
  readonly profile: ToolProfile;
  readonly canonical: (tool: string) => string;
  readonly activeTurn: () => string | undefined;
  readonly core: HostToolCapabilities | undefined;
  readonly cwd: string;
  /** The session, once it exists. */
  readonly session: () => AgentSession | undefined;
  /** The session's delegated I/O, absent with Pi's own tools. */
  readonly io: CoreIo | undefined;
  /** A reminder message was appended without Pi's message events (its transcript item). */
  readonly appended: (message: ReminderMessage) => void;
  readonly log: (line: string) => void;
}

export class SessionHarness {
  readonly reminders = new Reminders();
  readonly planMode: PlanMode;
  readonly usage: ContextUsageTracker;
  readonly #o: SessionHarnessOptions;
  #compaction: SessionCompaction | undefined;
  #memory: SessionMemory | undefined;

  constructor(options: SessionHarnessOptions) {
    this.#o = options;
    this.planMode = new PlanMode({
      manager: options.manager,
      sink: options.sink,
      reminders: this.reminders,
      activeTurn: options.activeTurn,
    });
    const context = options.core?.context === true ? options.core.bridge : undefined;
    if (context !== undefined && options.io !== undefined) {
      this.reminders.addCollector(
        fileChanges(context, options.sessionId, this.reminders, options.log),
      );
    }
    this.usage = new ContextUsageTracker({
      // `session/usage` is a method of the `context` capability.
      sink: context === undefined ? SILENT : options.sink,
      limits: () => this.compaction.limits(),
      mcpTools: () =>
        new Set(
          (options.session()?.getAllTools() ?? [])
            .filter((tool) => tool.namespace !== undefined)
            .map((tool) => tool.name),
        ),
      current: () => {
        const session = options.session();
        return {
          messages: session?.sessionManager.buildSessionProjection().messages ?? [],
          loadout: {
            ...(this.#memory?.systemText === undefined ? {} : { system: this.#memory.systemText }),
            ...(session === undefined ? {} : { tools: session.agent.state.tools }),
          },
        };
      },
    });
  }

  /** Connects memory and hooks, which the registry makes with the reminder channel. */
  connect(memory: SessionMemory, hooks: SessionHooks | undefined): void {
    this.#memory = memory;
    const o = this.#o;
    this.#compaction = new SessionCompaction({
      sessionId: o.sessionId,
      manager: o.manager,
      cwd: o.cwd,
      session: o.session,
      reminders: this.reminders,
      memory,
      canonical: o.canonical,
      usage: () => this.usage,
      bridge: o.core?.context === true ? o.core.bridge : undefined,
      io: o.io,
      hooks,
      appended: o.appended,
      log: o.log,
    });
  }

  /** Compaction settings, summary and restore; available after `connect`. */
  get compaction(): SessionCompaction {
    if (this.#compaction === undefined) throw new Error('SessionHarness.connect was not called');
    return this.#compaction;
  }

  /** The host tools this session gets. */
  tools(): ToolDefinition[] {
    const profile = this.#o.profile;
    const core = this.#o.core;
    return [
      ...(core?.planMode === true
        ? [
            createEnterPlanModeTool(profile.EnterPlanMode, this.planMode),
            createExitPlanModeTool(profile.ExitPlanMode, this.planMode),
          ]
        : []),
      ...(core?.todo === true ? [createTodoWriteTool(profile.TodoWrite)] : []),
      ...(core?.ask === true
        ? [createAskUserQuestionTool(profile.AskUserQuestion, core.bridge, this.#o.sessionId)]
        : []),
      createSuggestNextStepsTool(profile.SuggestNextSteps),
    ];
  }

  /** Extensions in order: the stale-list watch queues at `turn_end`, usage and compaction
   * observe, then the reminders deliver. */
  extensions(): ExtensionFactory[] {
    return [
      todoWatch(this.#o.manager, this.reminders, this.#o.canonical),
      this.usage.extension,
      this.compaction.extension,
      this.reminders.extension,
    ];
  }

  /** A mode switch the user or Core made: recorded on the branch, told to the model. */
  recordMode(mode: PermissionMode): void {
    this.planMode.record(mode);
  }

  /** `session/remind`: a background task's reminder for the model's next request. */
  remind(params: Pick<SessionRemindParams, 'type' | 'source' | 'text'>): void {
    if (params.type !== 'backgroundTask') {
      throw new AhpError('invalidParams', 'session/remind accepts backgroundTask reminders only', {
        details: { member: 'type' },
      });
    }
    this.reminders.enqueue(this.reminders.uniqueKey('task'), {
      type: 'backgroundTask',
      source: params.source,
      text: backgroundTaskNotice(params.source, params.text),
    });
  }

  /** `session/getContextUsage`. */
  contextUsage(): ContextUsage {
    return this.usage.current();
  }

  /** Before the projector handles `event`: a compaction's end is counted first, so its item
   * carries the outcome. */
  observe(event: AgentSessionEvent): void {
    if (event.type === 'compaction_end') this.compaction.ended(event);
  }

  /** After the projector handled `event`: a new task list follows its `item/completed`; a
   * response's reported input completes the usage. */
  onEvent(event: AgentSessionEvent): void {
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      this.usage.responded(event.message);
      return;
    }
    if (
      event.type !== 'tool_execution_end' ||
      event.parentToolCallId !== undefined ||
      event.isError ||
      this.#o.canonical(event.toolName) !== 'TodoWrite'
    ) {
      return;
    }
    const result: unknown = event.result;
    const todos =
      typeof result === 'object' && result !== null && 'details' in result
        ? todosOf(result.details)
        : undefined;
    if (todos === undefined) return;
    this.#o.sink.event('harness/todo', {
      itemId: event.toolCallId,
      todos: todos.map((todo) => ({
        ...todo,
        content: todo.content.toWellFormed(),
        ...(todo.activeForm == null ? {} : { activeForm: todo.activeForm.toWellFormed() }),
      })),
    });
  }
}
