// One subagent's child session (T31, architecture section 6.4, ADR-0048): registered with
// Core (`subagent/start`), created in this process with its own SessionManager and JSONL, its
// tools filtered, its model and effort resolved, and run on the task alone. The parent's
// history never reaches it: its first request holds the system prompt and the task.
import type { Api, Model } from '@earendil-works/pi-ai';
import {
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentDefinition,
  AgentWarning,
  EffortLevel,
  PermissionMode,
  SubagentStatus,
  SubagentTokens,
} from '@piarc/protocol';

import { isInterruptionMarker, repairInterruptedTurn } from '../harness/interruption.js';
import type { Persona } from '../harness/prompts/system.js';
import { EMPTY_REPORT } from '../harness/prompts/subagents.js';
import type { AgentToolHost } from '../harness/subagents/agent-tool.js';
import { SUBAGENT_ENTRY } from '../harness/subagents/definitions.js';
import { hidingOthers, toolGate } from '../harness/subagents/tool-filter.js';
import { CONCURRENCY_SAFE_TOOLS, ToolBatches } from '../harness/tool-batches.js';
import { capabilities } from '../providers/catalog.js';
import { describeError } from '../protocol/errors.js';
import { conservativeProfile, ToolNameMap } from '../tools/profile.js';
import { contentText, isObject } from './items.js';
import type { CoreBridge } from './core-bridge.js';
import type { ProjectionSink } from './projector.js';
import { sessionParts } from './session-parts.js';
import { createSessionRuntime } from './session-runtime.js';
import type { RegistryOptions } from './session-types.js';

/** A child session's notifications go nowhere: the parent reports the run. */
const SILENT: ProjectionSink = {
  event: () => undefined,
  delta: () => undefined,
  replaceable: () => undefined,
};

export interface ChildSpec {
  readonly options: RegistryOptions;
  readonly id: string;
  readonly parentId: string;
  readonly toolCallId: string;
  readonly cwd: string;
  readonly definition: AgentDefinition;
  readonly description: string;
  readonly model: Model<Api>;
  readonly effort: EffortLevel | undefined;
  readonly background: boolean;
  /** Runs in a temporary worktree Core creates (T35). */
  readonly isolated: boolean;
  /** Canonical names of the tools it may use. */
  readonly allowed: ReadonlySet<string>;
  /** Its own `Agent` tool, when it may start subagents itself. */
  readonly agents: AgentToolHost | undefined;
  readonly log: (line: string) => void;
}

/** What one step of the run changed, for the card. */
export interface Progress {
  readonly toolCalls: number;
  readonly tokens: SubagentTokens;
  readonly activity: string;
}

/** How the run ended. */
export interface Ending {
  readonly status: SubagentStatus;
  readonly report: string;
  readonly turns: number;
  readonly error?: string;
}

/** A subagent's temporary worktree (T35). */
export interface ChildWorktree {
  readonly path: string;
  readonly branch: string;
}

function worktreeOf(value: unknown): ChildWorktree | undefined {
  return isObject(value) && typeof value.path === 'string' && typeof value.branch === 'string'
    ? { path: value.path, branch: value.branch }
    : undefined;
}

/**
 * Registers the child with Core before its Pi session exists: answers its mode, the warnings
 * of the run and, for an isolated run, the worktree Core created and the child's cwd in it.
 */
async function register(bridge: CoreBridge, spec: ChildSpec) {
  return bridge.requestTyped(
    'subagent/start',
    {
      sessionId: spec.id,
      parentSessionId: spec.parentId,
      toolCallId: spec.toolCallId,
      agentType: spec.definition.name,
      description: spec.description,
      cwd: spec.cwd,
      model: { provider: spec.model.provider, id: spec.model.id },
      ...(spec.background ? { background: true } : {}),
      ...(spec.isolated ? { isolation: 'worktree' } : {}),
    },
    (value) =>
      isObject(value) && typeof value.permissionMode === 'string'
        ? {
            permissionMode: value.permissionMode as PermissionMode,
            warnings: Array.isArray(value.warnings) ? (value.warnings as AgentWarning[]) : [],
            cwd: typeof value.cwd === 'string' ? value.cwd : undefined,
            worktree: worktreeOf(value.worktree),
          }
        : undefined,
  );
}

function textOf(message: unknown): string | undefined {
  if (!isObject(message) || message.role !== 'assistant') return undefined;
  // The marker Harness Kit adds after an interrupt is not the subagent's report.
  if (
    isInterruptionMarker({
      ...(typeof message.rawStopReason === 'string'
        ? { rawStopReason: message.rawStopReason }
        : {}),
    })
  )
    return undefined;
  const text = contentText(message.content)?.trim();
  return text === undefined || text === '' ? undefined : text;
}

/** A tool call as one line for the card ("Grep parser"). */
function describeCall(tool: string, args: unknown): string {
  if (!isObject(args)) return tool;
  const first = ['description', 'command', 'pattern', 'path', 'url', 'prompt']
    .map((key) => args[key])
    .find((value): value is string => typeof value === 'string' && value.trim() !== '');
  return first === undefined ? tool : `${tool} ${first.split('\n')[0]?.slice(0, 120) ?? ''}`;
}

export class ChildSession {
  readonly #spec: ChildSpec;
  readonly #runtime: AgentSessionRuntime;
  readonly #canonical: (tool: string) => string;
  readonly #harness: ReturnType<typeof sessionParts>['harness'];
  readonly #memory: ReturnType<typeof sessionParts>['memory'];
  readonly file: string | undefined;
  readonly warnings: readonly AgentWarning[];
  /** Where it works: the parent's directory, or its place in the run's worktree. */
  readonly cwd: string;
  /** The run's worktree (isolation, T35). */
  readonly worktree: ChildWorktree | undefined;

  private constructor(
    spec: ChildSpec,
    runtime: AgentSessionRuntime,
    canonical: (tool: string) => string,
    parts: ReturnType<typeof sessionParts>,
    registered: { warnings: readonly AgentWarning[]; cwd: string; worktree?: ChildWorktree },
  ) {
    this.#spec = spec;
    this.#runtime = runtime;
    this.#canonical = canonical;
    this.#harness = parts.harness;
    this.#memory = parts.memory;
    this.file = runtime.session.sessionFile;
    this.warnings = registered.warnings;
    this.cwd = registered.cwd;
    this.worktree = registered.worktree;
  }

  /**
   * Registers the child with Core and creates its Pi session. A failure after the
   * registration is the caller's to report with `subagent/finish` (Core then removes an
   * untouched worktree).
   */
  static async open(spec: ChildSpec): Promise<ChildSession> {
    const { options } = spec;
    const { tools } = options;
    if (tools.kind !== 'core') throw new Error('subagents need the Core tool backend');
    const registered = await register(tools.bridge, spec);
    const cwd = registered.cwd ?? spec.cwd;
    return ChildSession.#create({ ...spec, cwd }, registered);
  }

  static async #create(
    spec: ChildSpec,
    registered: {
      permissionMode: PermissionMode;
      warnings: readonly AgentWarning[];
      worktree: ChildWorktree | undefined;
    },
  ): Promise<ChildSession> {
    const { options, definition } = spec;
    const { tools, workspace } = options;
    if (tools.kind !== 'core') throw new Error('subagents need the Core tool backend');
    const manager = SessionManager.create(spec.cwd, undefined, { id: spec.id });
    manager.appendCustomEntry(SUBAGENT_ENTRY, {
      parentSessionId: spec.parentId,
      agentType: definition.name,
      toolCallId: spec.toolCallId,
      description: spec.description,
      ...(spec.background ? { background: true } : {}),
    });
    const kind = workspace.preferences.profile(
      spec.model,
      capabilities(spec.model).toolReliability,
    );
    const conservative = kind === 'conservative';
    const profile = conservative ? conservativeProfile(tools.profile) : tools.profile;
    const names = new ToolNameMap(profile);
    const canonical = (tool: string): string => names.toCanonical(tool);
    const persona: Persona = {
      identity:
        definition.prompt.trim() === ''
          ? `You are the ${definition.name} subagent.`
          : definition.prompt,
      projectContext: definition.omitProjectContext !== true,
    };
    const opened: { session?: AgentSession } = {};
    const log = (line: string): void => {
      spec.log(`[session ${spec.id}] ${line}`);
    };
    const childOptions: RegistryOptions = { ...options, sinkFor: () => SILENT };
    const parts = sessionParts({
      options: childOptions,
      manager,
      cwd: spec.cwd,
      source: 'startup',
      profile,
      conservative,
      canonical,
      opened,
      log,
      child: { persona },
      ...(spec.agents === undefined ? {} : { agents: spec.agents }),
    });
    const batches = new ToolBatches((tool) => CONCURRENCY_SAFE_TOOLS.has(canonical(tool)));
    const { runtime } = await createSessionRuntime({
      options: childOptions,
      manager,
      cwd: spec.cwd,
      profile,
      conservative,
      canonical,
      batches,
      harness: parts.harness,
      memory: parts.memory,
      hooks: parts.hooks,
      model: spec.model,
      declined: () => undefined,
      log,
      child: {
        wrap: (tool) => hidingOthers(tool, spec.allowed, canonical),
        gate: toolGate(spec.allowed, canonical),
      },
    });
    opened.session = runtime.session;
    if (spec.effort !== undefined) runtime.session.setThinkingLevel(spec.effort);
    parts.harness.compaction.apply();
    try {
      await runtime.session.bindExtensions({
        onError: (error) => {
          log(`extension ${error.extensionPath} failed in ${error.event}: ${error.error}`);
        },
      });
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
    log(
      `subagent ${definition.name} of ${spec.parentId} opened (mode ${registered.permissionMode}, model ${spec.model.provider}/${spec.model.id})`,
    );
    return new ChildSession(spec, runtime, canonical, parts, {
      warnings: registered.warnings,
      cwd: spec.cwd,
      ...(registered.worktree === undefined ? {} : { worktree: registered.worktree }),
    });
  }

  get session(): AgentSession {
    return this.#runtime.session;
  }

  get harness(): ReturnType<typeof sessionParts>['harness'] {
    return this.#harness;
  }

  /**
   * Runs the task until the child settles; `signal` interrupts it. `maxTurns` model responses
   * end it early with what it had (partial).
   */
  async run(
    task: string,
    signal: AbortSignal,
    maxTurns: number | undefined,
    onProgress: (progress: Progress) => void,
  ): Promise<Ending> {
    const { session } = this;
    let turns = 0;
    let toolCalls = 0;
    // Set from the event handler (an object, so the checks below read its current value).
    const limit = { reached: false, turns: 0 };
    let activity = '';
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const report = () => {
      onProgress({ toolCalls, tokens: { ...tokens }, activity });
    };
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      this.#harness.observe(event);
      switch (event.type) {
        case 'tool_execution_start':
          if (event.parentToolCallId === undefined) {
            toolCalls += 1;
            activity = describeCall(this.#canonical(event.toolName), event.args);
            report();
          }
          break;
        case 'message_end': {
          const message: unknown = event.message;
          if (isObject(message) && message.role === 'assistant') {
            const usage: unknown = message.usage;
            if (isObject(usage)) {
              const n = (key: string) => (typeof usage[key] === 'number' ? usage[key] : 0);
              tokens.input += n('input');
              tokens.output += n('output');
              tokens.cacheRead += n('cacheRead');
              tokens.cacheWrite += n('cacheWrite');
            }
            const text = textOf(message);
            if (text !== undefined) activity = text.split('\n')[0]?.slice(0, 200) ?? '';
            report();
          }
          break;
        }
        case 'turn_end': {
          turns += 1;
          const message: unknown = event.message;
          const calls =
            isObject(message) &&
            Array.isArray(message.content) &&
            message.content.some((part: unknown) => isObject(part) && part.type === 'toolCall');
          if (maxTurns !== undefined && turns >= maxTurns && calls) {
            limit.reached = true;
            limit.turns = turns;
            void session.abort();
          }
          break;
        }
        case 'agent_settled':
          if (event.aborted) repairInterruptedTurn(session);
          break;
        default:
          break;
      }
      this.#harness.onEvent(event);
    });
    const stop = () => {
      void session.abort();
    };
    signal.addEventListener('abort', stop, { once: true });
    let error: string | undefined;
    try {
      signal.throwIfAborted();
      await this.#harness.compaction.prepare();
      if (await this.#memory.prepare()) await session.prompt(task);
    } catch (failure) {
      if (!signal.aborted && !limit.reached) error = describeError(failure);
    } finally {
      signal.removeEventListener('abort', stop);
      unsubscribe();
    }
    const messages: readonly unknown[] = session.messages;
    const last = messages.findLast((m) => isObject(m) && m.role === 'assistant');
    if (error === undefined && isObject(last) && last.stopReason === 'error' && !limit.reached) {
      error =
        typeof last.errorMessage === 'string' ? last.errorMessage : 'The model request failed.';
    }
    const text = messages.map(textOf).findLast((t) => t !== undefined) ?? EMPTY_REPORT;
    const status: SubagentStatus = limit.reached
      ? 'partial'
      : signal.aborted
        ? 'interrupted'
        : error !== undefined
          ? 'failed'
          : 'completed';
    return {
      status,
      report: text,
      turns: limit.reached ? limit.turns : turns,
      ...(error === undefined ? {} : { error }),
    };
  }

  /**
   * Shuts the child session down (its MCP connections close) and tells Core it ended; answers
   * the run's worktree when Core kept it (it has changes or commits).
   */
  async finish(status: SubagentStatus, tokens: SubagentTokens): Promise<ChildWorktree | undefined> {
    try {
      await this.#runtime.dispose();
    } catch (error) {
      this.#spec.log(`[session ${this.#spec.id}] closing failed: ${describeError(error)}`);
    }
    return finishInCore(this.#spec.options, this.#spec.id, status, tokens);
  }
}

/** `subagent/finish`: Core unregisters the child and settles its worktree. A failure is
 * logged; Core also drops it when the connection ends. */
export async function finishInCore(
  options: RegistryOptions,
  id: string,
  status: SubagentStatus,
  tokens: SubagentTokens,
): Promise<ChildWorktree | undefined> {
  if (options.tools.kind !== 'core') return undefined;
  try {
    const result: unknown = await options.tools.bridge.request('subagent/finish', {
      sessionId: id,
      status,
      usage: {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheReadTokens: tokens.cacheRead,
        cacheWriteTokens: tokens.cacheWrite,
        cost: 0,
      },
    });
    return isObject(result) ? worktreeOf(result.worktree) : undefined;
  } catch (error) {
    options.log(`[session ${id}] subagent/finish failed: ${describeError(error)}`);
    return undefined;
  }
}
