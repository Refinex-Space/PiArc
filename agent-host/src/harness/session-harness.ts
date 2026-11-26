// The Harness Kit of one session: what the registry wires in.
//
// - Host tools (T26, architecture section 6.5): Core's capabilities `planMode` (EnterPlanMode,
//   ExitPlanMode), `todo` (TodoWrite), `ask` (AskUserQuestion); SuggestNextSteps needs none.
// - The system reminder channel (T27, reminders.ts) that plan mode, the task list, memory,
//   hooks, files changed outside the session and background tasks all go through.
// - Context engineering (T27, capability `context`): compaction (settings, summary, restore,
//   circuit breaker; compaction.ts) and context usage (context-usage.ts).
import type { Api, Model } from '@earendil-works/pi-ai';
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
  ReminderType,
  SessionRemindParams,
  ServerContextEdit,
} from '@piarc/protocol';

import { AhpError } from '../protocol/errors.js';
import type { CoreBridge } from '../runtime/core-bridge.js';
import type { ProjectionSink } from '../runtime/projector.js';
import type { CoreIo } from '../tools/core-io.js';
import type { ToolProfile } from '../tools/profile.js';
import { SessionCompaction } from './compaction.js';
import { ContextUsageTracker } from './context-usage.js';
import { FILE_STATE_TOOLS, fileChanges } from './file-changes.js';
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
import { REMINDER_ENTRY, Reminders, reminderRecords, type ReminderMessage } from './reminders.js';
import type { SessionMemory } from './session-memory.js';
import { createTodoWriteTool, currentTodos, todosOf, todoWatch } from './todos.js';
import type { AuxiliaryModel } from './auxiliary.js';
import { createAgentTool, type AgentToolHost } from './subagents/agent-tool.js';
import { createKillShellTool, createMonitorTool } from './task-tools.js';
import { createBrowserTool } from './browser.js';
import { createWebFetchTool } from './web-fetch.js';
import { createWebSearchTool } from './web-search.js';
import type { SessionSkills } from './skills/session-skills.js';
import { createSkillTool } from './skills/skill-tool.js';
import { createMemoryTool } from './auto-memory.js';

/** What Core enabled for the host tools in the handshake. */
export interface HostToolCapabilities {
  readonly bridge: CoreBridge;
  readonly planMode: boolean;
  readonly todo: boolean;
  readonly ask: boolean;
  /** `context` (T27): reminders as items, file changes, compaction settings, usage. */
  readonly context?: boolean;
  /** `checkpoints` (T28): branch points, rewinds, summaries in the history. */
  readonly checkpoints?: boolean;
  /** `webFetch` (T29): Core fetches pages for WebFetch (`web/fetch`). */
  readonly webFetch?: boolean;
  /** `webSearch` (T38): Core answers `web/searchBackend` and `web/search`. */
  readonly webSearch?: boolean;
  /** `browser` (ADR-0089): a desktop app runs `Browser` scripts (`browser/run`). */
  readonly browser?: boolean;
  /** `subagents` (T31): the `Agent` tool and child sessions Core registers. */
  readonly subagents?: boolean;
  /** `backgroundTasks` (T32): background commands, `KillShell` and `Monitor`. */
  readonly backgroundTasks?: boolean;
  /** `skills` (T37): skills, the `Skill` tool, output styles and slash commands. */
  readonly skills?: boolean;
  /** `plugins` (T40): the extension packages' Pi extensions (`plugins/extensions`). */
  readonly plugins?: boolean;
  /** `autoMemory` (T47): `memory/status` and `memory/apply` for the `Memory` tool. */
  readonly autoMemory?: boolean;
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
  /** The context window of a model per the user's setting (T29). */
  readonly serverContextEdit?: (model: Model<Api>) => ServerContextEdit | null | undefined;
  readonly contextWindow?: (model: Model<Api>) => number;
  /** The auxiliary model channel (T29): WebFetch's extraction. */
  readonly auxiliary?: AuxiliaryModel;
  /** The session opened with the conservative Tool Profile (T29). */
  readonly conservative?: boolean;
  /** Runs the session's `Agent` calls (T31); absent: the session has no `Agent` tool. */
  readonly agents?: AgentToolHost;
  /** Whether a model searches natively (T38, the catalog and the user's setting). */
  readonly nativeWebSearch?: (model: Model<Api>) => boolean;
}

/** The effort levels Claude Code's hooks name. */
const HOOK_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export class SessionHarness {
  readonly reminders = new Reminders();
  readonly planMode: PlanMode;
  readonly usage: ContextUsageTracker;
  /** The session's skills and output style (T37, capability `skills`); set before `tools()`. */
  skills: SessionSkills | undefined;
  /** Whether the session offers WebSearch (T38); decided by `prepareWebSearch` before
   * `tools()`. */
  webSearchOffered = false;
  /** Whether the session offers the `Memory` tool (T47); decided by `prepareMemory` before
   * `tools()`. */
  memoryOffered = false;
  readonly #o: SessionHarnessOptions;
  #compaction: SessionCompaction | undefined;
  #memory: SessionMemory | undefined;
  /** The branch has a successful Read, Write or Edit: Core has files to compare. */
  #touchedFiles: boolean;

  constructor(options: SessionHarnessOptions) {
    this.#o = options;
    this.planMode = new PlanMode({
      manager: options.manager,
      sink: options.sink,
      reminders: this.reminders,
      activeTurn: options.activeTurn,
    });
    this.#touchedFiles = options.manager
      .getBranch()
      .some(
        (entry) =>
          entry.type === 'message' &&
          entry.message.role === 'toolResult' &&
          !entry.message.isError &&
          FILE_STATE_TOOLS.has(options.canonical(entry.message.toolName)),
      );
    const context = options.core?.context === true ? options.core.bridge : undefined;
    if (context !== undefined && options.io !== undefined) {
      this.reminders.addCollector(
        fileChanges(
          context,
          options.sessionId,
          this.reminders,
          () => this.#touchedFiles,
          options.log,
        ),
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
      messages: () => options.session()?.sessionManager.buildSessionProjection().messages ?? [],
      system: () => this.#memory?.systemText,
      tools: () => options.session()?.agent.state.tools ?? [],
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
      ...(o.serverContextEdit === undefined ? {} : { serverContextEdit: o.serverContextEdit }),
      ...(o.contextWindow === undefined ? {} : { contextWindow: o.contextWindow }),
    });
  }

  /** Compaction settings, summary and restore; available after `connect`. */
  get compaction(): SessionCompaction {
    if (this.#compaction === undefined) throw new Error('SessionHarness.connect was not called');
    return this.#compaction;
  }

  /** The session's auxiliary model channel (T29), when it has one. */
  get auxiliary(): AuxiliaryModel | undefined {
    return this.#o.auxiliary;
  }

  /** The session's effort as hooks see it (T38): `low` to `max`, none for `off`. */
  effort(): string | undefined {
    const level: unknown = this.#o.session()?.thinkingLevel;
    return typeof level === 'string' && HOOK_EFFORTS.has(level) ? level : undefined;
  }

  /**
   * Decides whether the session offers WebSearch (T38): Core enables it and the session's model
   * `model` searches natively, or Core has a third-party backend now. Call before `tools()`.
   */
  async prepareWebSearch(model: Model<Api> | undefined): Promise<boolean> {
    const core = this.#o.core;
    const io = this.#o.io;
    if (core?.webSearch !== true || io === undefined || this.#o.auxiliary === undefined) {
      this.webSearchOffered = false;
      return false;
    }
    if (model !== undefined && this.#o.nativeWebSearch?.(model) === true) {
      this.webSearchOffered = true;
      return true;
    }
    try {
      this.webSearchOffered = (await io.searchBackend()).backend != null;
    } catch (error) {
      this.#o.log(`web/searchBackend failed; no WebSearch: ${String(error)}`);
      this.webSearchOffered = false;
    }
    return this.webSearchOffered;
  }

  /**
   * Decides whether the session offers the `Memory` tool (T47): Core enables auto memory, the
   * project is trusted and the session is a main session (Core's `memory/status`). The tool set
   * stays for the session; a change takes effect when it is opened again. Call before `tools()`.
   */
  async prepareMemory(): Promise<boolean> {
    const io = this.#o.io;
    if (this.#o.core?.autoMemory !== true || io === undefined) {
      this.memoryOffered = false;
      return false;
    }
    try {
      this.memoryOffered = (await io.memoryStatus()).tool;
    } catch (error) {
      this.#o.log(`memory/status failed; no Memory tool: ${String(error)}`);
      this.memoryOffered = false;
    }
    return this.memoryOffered;
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
      ...(core?.webFetch === true && this.#o.io !== undefined && this.#o.auxiliary !== undefined
        ? [createWebFetchTool(profile.WebFetch, this.#o.io, this.#o.auxiliary)]
        : []),
      ...(core?.browser === true && this.#o.io !== undefined
        ? [createBrowserTool(profile.Browser, this.#o.io)]
        : []),
      ...(this.webSearchOffered && this.#o.io !== undefined && this.#o.auxiliary !== undefined
        ? [
            createWebSearchTool(profile.WebSearch, {
              io: this.#o.io,
              auxiliary: this.#o.auxiliary,
              session: this.#o.session,
              native: (model) => this.#o.nativeWebSearch?.(model) ?? false,
            }),
          ]
        : []),
      ...(core?.backgroundTasks === true && this.#o.io !== undefined
        ? [
            createKillShellTool(profile.KillShell, this.#o.io),
            createMonitorTool(profile.Monitor, this.#o.io),
          ]
        : []),
      ...(this.#o.agents === undefined ? [] : [createAgentTool(profile.Agent, this.#o.agents)]),
      // Registered when the session opens with skills the model may load: the tool set stays
      // the same for the whole session (prompt cache).
      ...(this.skills?.modelSkills === true ? [createSkillTool(profile.Skill, this.skills)] : []),
      // Auto memory (T47): decided when the session opens, like the skills.
      ...(this.memoryOffered && this.#o.io !== undefined
        ? [
            createMemoryTool(profile.Memory, {
              io: this.#o.io,
              changed: (index) => this.#memory?.acknowledge(index),
            }),
          ]
        : []),
    ];
  }

  /** Extensions in order: the stale-list watch queues at `turn_end`, usage and compaction
   * observe, then the reminders deliver. */
  extensions(): ExtensionFactory[] {
    return [
      // Index and style changes are queued before the reminders deliver (T37).
      ...(this.skills === undefined ? [] : [this.skills.extension]),
      todoWatch(
        this.#o.manager,
        this.reminders,
        this.#o.canonical,
        () => this.#o.conservative === true,
      ),
      this.usage.extension,
      this.compaction.extension,
      this.reminders.extension,
    ];
  }

  /** A mode switch the user or Core made: recorded on the branch, told to the model. */
  recordMode(mode: PermissionMode): void {
    this.planMode.record(mode);
  }

  /**
   * `session/remind`: a background task's reminder for the model's next request. With a `key`
   * (Core's task manager, T32) the text is complete as given, a queued reminder with the same
   * key is replaced, and one with the same type and source already on the branch is not
   * queued again (`'delivered'`): Core resends what it has not seen delivered.
   */
  remind(
    params: Pick<SessionRemindParams, 'type' | 'source' | 'text'> & { readonly key?: string },
  ): 'queued' | 'delivered' {
    if (params.type !== 'backgroundTask' && params.type !== 'monitorOutput') {
      throw new AhpError(
        'invalidParams',
        'session/remind accepts backgroundTask and monitorOutput reminders only',
        { details: { member: 'type' } },
      );
    }
    if (params.key === undefined) {
      this.reminders.enqueue(this.reminders.uniqueKey('task'), {
        type: params.type,
        source: params.source,
        text: backgroundTaskNotice(params.source, params.text),
      });
      return 'queued';
    }
    if (this.#delivered(params.type, params.source)) return 'delivered';
    this.reminders.enqueue(params.key, {
      type: params.type,
      source: params.source,
      text: params.text,
    });
    return 'queued';
  }

  /** Whether the branch holds a delivered reminder of `type` from `source`. */
  #delivered(type: ReminderType, source: string): boolean {
    return this.#o.manager
      .getBranch()
      .some(
        (entry) =>
          entry.type === 'custom_message' &&
          entry.customType === REMINDER_ENTRY &&
          reminderRecords(entry.details).some((r) => r.type === type && r.source === source),
      );
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
      event.type === 'tool_execution_end' &&
      !event.isError &&
      FILE_STATE_TOOLS.has(this.#o.canonical(event.toolName))
    ) {
      this.#touchedFiles = true;
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
