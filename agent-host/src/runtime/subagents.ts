// Subagent runs of this Agent Host (T31, architecture section 6.4, ADR-0048, ADR-0010): the
// tree of running child sessions under each main session, where the depth and concurrency
// limits are counted (nowhere else), and the `Agent` tool host of every session.
//
// - A call over the concurrency limit (runs of one main session and all its descendants)
//   fails at once with the limit and the count; it never queues: queued children of
//   foreground runs that each wait for their own children would deadlock.
// - Foreground: the parent's `Agent` call waits for the run; progress goes to the call's
//   updates (the `subagent` item) and to `subagent/progress`; the report is the result.
// - Background: the call returns the run's id at once; when the run ends, its report reaches
//   the parent's next request as a `backgroundTask` reminder (T27's channel).
// - The parent's interrupt aborts its foreground runs (the call's signal); closing a session
//   aborts every run below it, background ones included; `subagent/stop` aborts one.
import { randomUUID } from 'node:crypto';

import type { Api, Model } from '@earendil-works/pi-ai';
import type { AgentSession, SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';
import type {
  AgentDefinition,
  AgentsList,
  AgentWarning,
  EffortLevel,
  SubagentState,
  SubagentStatus,
  SubagentTokens,
} from '@piarc/protocol';

import { resolveModel } from '../providers/aliases.js';
import { supportedEfforts } from '../providers/catalog.js';
import { describeError } from '../protocol/errors.js';
import {
  backgroundFinished,
  backgroundStarted,
  partialReport,
  worktreeKept,
} from '../harness/prompts/subagents.js';
import type { AgentCall, AgentToolHost } from '../harness/subagents/agent-tool.js';
import {
  DEFAULT_LIMITS,
  SUBAGENT_STATE_ENTRY,
  catalogOf,
  fetchCatalog,
  startable,
  type AgentCatalog,
} from '../harness/subagents/definitions.js';
import { allowedTools } from '../harness/subagents/tool-filter.js';
import type { SessionHarness } from '../harness/session-harness.js';
import { isObject } from './items.js';
import type { ProjectionSink } from './projector.js';
import { ChildSession, finishInCore } from './subagent-session.js';
import type { RegistryOptions } from './session-types.js';

/** Progress notifications of one run at most this often. */
const PROGRESS_INTERVAL_MS = 250;

/** What the runner needs of a parent session (a main session or a subagent's). */
export interface ParentSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly session: AgentSession;
  readonly harness: SessionHarness;
  /** Its notifications; a subagent's session has none. */
  readonly sink: ProjectionSink;
  /** Canonical names of the tools it may use now. */
  tools(): readonly string[];
}

interface Run {
  readonly id: string;
  readonly parentId: string;
  /** Its parent, the parent's parent… up to the main session: a run is still reached once a
   * subagent between it and the main session ended (R4 S3). */
  readonly ancestors: readonly string[];
  readonly rootId: string;
  readonly depth: number;
  readonly toolCallId: string;
  readonly background: boolean;
  readonly controller: AbortController;
  readonly allowed: ReadonlySet<string>;
  state: SubagentState;
  /** The child as a parent of its own subagents, once it is open. */
  view?: ParentSession;
}

/** A child session's notifications go nowhere: its parent reports the run. */
const SILENT: ProjectionSink = {
  event: () => undefined,
  delta: () => undefined,
  replaceable: () => undefined,
};

const ZERO: SubagentTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export class SubagentRunner {
  readonly #options: RegistryOptions;
  readonly #main: (sessionId: string) => ParentSession | undefined;
  readonly #runs = new Map<string, Run>();
  /** Calls past the limit check that are still choosing their model, by main session. */
  readonly #starting = new Map<string, number>();

  constructor(options: RegistryOptions, main: (sessionId: string) => ParentSession | undefined) {
    this.#options = options;
    this.#main = main;
  }

  /** A main session, or a running subagent's session. */
  #parent(sessionId: string): ParentSession | undefined {
    return this.#runs.get(sessionId)?.view ?? this.#main(sessionId);
  }

  /** Whether `sessionId` is a running subagent's session. */
  isChild(sessionId: string): boolean {
    return this.#runs.has(sessionId);
  }

  /** The main session at the top of `sessionId`'s tree. */
  rootOf(sessionId: string): string {
    return this.#runs.get(sessionId)?.rootId ?? sessionId;
  }

  /** Levels below its main session (0 for a main session). */
  depthOf(sessionId: string): number {
    return this.#runs.get(sessionId)?.depth ?? 0;
  }

  /** Runs under main session `rootId`, at any depth, with the ones being started. */
  running(rootId: string): number {
    const started = [...this.#runs.values()].filter((run) => run.rootId === rootId).length;
    return started + (this.#starting.get(rootId) ?? 0);
  }

  /** The tools a subagent's session may use (its parent's `tools()`). */
  allowedOf(sessionId: string): ReadonlySet<string> | undefined {
    return this.#runs.get(sessionId)?.allowed;
  }

  /**
   * The `Agent` tool host of session `sessionId` in `cwd`: Core's definitions found from `cwd`
   * with the built-in types. Undefined when the session may not start subagents (no
   * capability, or at the depth limit).
   */
  async hostFor(sessionId: string, cwd: string): Promise<AgentToolHost | undefined> {
    const { hostTools, tools } = this.#options;
    if (hostTools?.subagents !== true || tools.kind !== 'core') return undefined;
    let catalog: AgentCatalog;
    try {
      catalog = await fetchCatalog(tools.bridge, cwd);
    } catch (error) {
      this.#options.log(
        `[session ${sessionId}] agents/list failed, offering the built-in types only: ${describeError(error)}`,
      );
      catalog = catalogOf({
        agents: [],
        issues: [],
        limits: DEFAULT_LIMITS,
        deniedBuiltIn: [],
        aliases: {},
      });
    }
    if (this.depthOf(sessionId) >= catalog.limits.maxDepth) return undefined;
    return {
      types: startable(catalog),
      run: (toolCallId, call, signal, progress) =>
        this.#start(sessionId, catalog, toolCallId, call, signal, progress),
    };
  }

  /**
   * `resources/listAgents`: the types in effect from `cwd` (files and built-in), with the model
   * each resolves to under the alias table and a warning for an alias that is not set.
   */
  async list(cwd: string): Promise<AgentsList> {
    const { tools, workspace } = this.#options;
    if (tools.kind !== 'core') throw new Error('subagents need the Core tool backend');
    const catalog = await fetchCatalog(tools.bridge, cwd);
    const available = await workspace.modelRuntime.getAvailable();
    const agents = catalog.agents.map((agent): AgentDefinition => {
      const spec = agent.model ?? undefined;
      if (spec === undefined || spec === 'inherit') return agent;
      const fallback = available[0];
      if (fallback === undefined) return agent;
      const resolved = resolveModel(spec, {
        aliases: catalog.aliases,
        inherit: fallback,
        available,
      });
      if (!resolved.ok) return agent;
      if (resolved.warning !== undefined) {
        return {
          ...agent,
          warnings: [
            ...(agent.warnings ?? []),
            { kind: 'aliasFallback', value: resolved.warning.alias },
          ],
        };
      }
      return {
        ...agent,
        resolvedModel: { provider: resolved.model.provider, id: resolved.model.id },
      };
    });
    return {
      agents,
      issues: [...catalog.issues],
      limits: catalog.limits,
      aliases: { ...catalog.aliases },
    };
  }

  /** `subagent/stop`: interrupts a run; false when it is not running. */
  stop(sessionId: string): boolean {
    const run = this.#runs.get(sessionId);
    run?.controller.abort('stopped');
    return run !== undefined;
  }

  /** Interrupts every run below `sessionId` (it is closing), background ones included. */
  abortBelow(sessionId: string): void {
    for (const run of this.#runs.values()) {
      if (this.#below(run, sessionId)) run.controller.abort('closed');
    }
  }

  #below(run: Run, sessionId: string): boolean {
    return run.ancestors.includes(sessionId);
  }

  async #start(
    parentId: string,
    catalog: AgentCatalog,
    toolCallId: string,
    call: AgentCall,
    signal: AbortSignal | undefined,
    progress: (state: SubagentState, activity: string) => void,
  ): Promise<{ text: string; isError: boolean; details: { subagent?: SubagentState } }> {
    const refuse = (text: string) => ({ text, isError: true, details: {} });
    const parent = this.#parent(parentId);
    if (parent === undefined) return refuse(`Session ${parentId} is not open.`);
    const types = startable(catalog);
    const definition = types.find((type) => type.name === call.type);
    if (definition === undefined) {
      const denied = catalog.agents.some((a) => a.name === call.type && a.denied === true);
      return refuse(
        denied
          ? `The permission rules do not allow the ${call.type} subagent.`
          : `Unknown subagent type "${call.type}". Available: ${types.map((t) => t.name).join(', ')}.`,
      );
    }
    const rootId = this.rootOf(parentId);
    const depth = this.depthOf(parentId) + 1;
    const { maxDepth, maxConcurrent } = catalog.limits;
    if (depth > maxDepth) return refuse(`Subagents may nest at most ${String(maxDepth)} levels.`);
    const count = this.running(rootId);
    if (count >= maxConcurrent) {
      return refuse(
        `Subagent limit reached: ${String(count)} of ${String(maxConcurrent)} subagents are running for this session. Wait for one to finish, or do this work yourself.`,
      );
    }
    // Hold the slot before the first await: parallel calls of one response count each other.
    this.#starting.set(rootId, (this.#starting.get(rootId) ?? 0) + 1);
    let chosen;
    try {
      chosen = await this.#model(parent, definition, call, catalog);
    } finally {
      this.#starting.set(rootId, (this.#starting.get(rootId) ?? 1) - 1);
    }
    if (!chosen.ok) return refuse(chosen.message);
    const id = randomUUID();
    const background = call.background ?? definition.background === true;
    const run: Run = {
      id,
      parentId,
      ancestors: [...(this.#runs.get(parentId)?.ancestors ?? []), parentId],
      rootId,
      depth,
      toolCallId,
      background,
      controller: new AbortController(),
      allowed: allowedTools(parent.tools(), definition, depth, maxDepth),
      state: {
        sessionId: id,
        agentType: definition.name,
        description: call.description,
        ...(definition.color === undefined ? {} : { color: definition.color }),
        model: { provider: chosen.model.provider, id: chosen.model.id },
        ...(chosen.effort === undefined ? {} : { effort: chosen.effort }),
        status: 'running',
        ...(background ? { background: true } : {}),
        startedAt: Date.now(),
        toolCalls: 0,
        warnings: [...(definition.warnings ?? []), ...chosen.warnings],
      },
    };
    // Counted from here on, so parallel calls see each other.
    this.#runs.set(id, run);
    let child: ChildSession;
    try {
      child = await ChildSession.open({
        options: this.#options,
        id,
        parentId,
        toolCallId,
        cwd: parent.cwd,
        definition,
        description: call.description,
        model: chosen.model,
        effort: chosen.effort,
        background,
        isolated: call.isolation === 'worktree' || definition.isolation === 'worktree',
        allowed: run.allowed,
        agents: await this.hostFor(id, parent.cwd),
        log: this.#options.log,
      });
    } catch (error) {
      this.#runs.delete(id);
      await finishInCore(this.#options, id, 'failed', ZERO);
      return refuse(`The subagent could not start: ${describeError(error)}`);
    }
    run.state = {
      ...run.state,
      warnings: [...(run.state.warnings ?? []), ...child.warnings],
      ...(child.file === undefined ? {} : { transcriptPath: child.file }),
    };
    run.view = {
      sessionId: id,
      cwd: child.cwd,
      session: child.session,
      harness: child.harness,
      sink: SILENT,
      tools: () => [...run.allowed],
    };
    parent.sink.event('subagent/started', { itemId: toolCallId, subagent: run.state });
    const relay = signal === undefined || background ? undefined : signal;
    const stop = () => {
      run.controller.abort(relay?.reason);
    };
    relay?.addEventListener('abort', stop, { once: true });
    // The parent may have been interrupted while the child was opening: no event comes then
    // (R4 S1).
    if (relay?.aborted === true) stop();
    const done = this.#execute(run, child, call, definition, progress).finally(() => {
      relay?.removeEventListener('abort', stop);
    });
    if (!background) return done;
    void done.then((outcome) => {
      this.#deliver(run, outcome.text);
    });
    return {
      text: backgroundStarted(definition.name, id),
      isError: false,
      details: { subagent: run.state },
    };
  }

  /** Runs the child to its end and reports it to the parent. */
  async #execute(
    run: Run,
    child: ChildSession,
    call: AgentCall,
    definition: AgentDefinition,
    progress: (state: SubagentState, activity: string) => void,
  ): Promise<{ text: string; isError: boolean; details: { subagent?: SubagentState } }> {
    let tokens = ZERO;
    let last = 0;
    let timer: NodeJS.Timeout | undefined;
    const publish = (activity: string) => {
      timer = undefined;
      last = Date.now();
      this.#parent(run.parentId)?.sink.replaceable('subagent/progress', run.toolCallId, {
        itemId: run.toolCallId,
        subagent: run.state,
      });
      if (!run.background) progress(run.state, activity);
    };
    let ending;
    try {
      ending = await child.run(
        call.prompt,
        run.controller.signal,
        definition.maxTurns ?? undefined,
        (p) => {
          tokens = p.tokens;
          run.state = {
            ...run.state,
            toolCalls: p.toolCalls,
            tokens: p.tokens,
            activity: p.activity,
          };
          const wait = PROGRESS_INTERVAL_MS - (Date.now() - last);
          if (wait <= 0) publish(p.activity);
          else
            timer ??= setTimeout(() => {
              publish(run.state.activity ?? '');
            }, wait);
        },
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const { status } = ending;
    const state: SubagentState = { ...run.state };
    delete state.activity;
    run.state = {
      ...state,
      status,
      durationMs: Date.now() - run.state.startedAt,
      tokens,
      ...(ending.error === undefined ? {} : { error: ending.error }),
    };
    const kept = await child.finish(status, tokens);
    this.#runs.delete(run.id);
    const parent = this.#parent(run.parentId);
    parent?.sink.event('subagent/completed', { itemId: run.toolCallId, subagent: run.state });
    parent?.session.sessionManager.appendCustomEntry(SUBAGENT_STATE_ENTRY, {
      itemId: run.toolCallId,
      subagent: run.state,
    });
    const outcome = this.#outcome(status, ending, run.state);
    return kept === undefined
      ? outcome
      : { ...outcome, text: `${outcome.text}\n\n${worktreeKept(kept.path, kept.branch)}` };
  }

  #outcome(
    status: SubagentStatus,
    ending: { report: string; turns: number; error?: string },
    state: SubagentState,
  ): { text: string; isError: boolean; details: { subagent?: SubagentState } } {
    const details = { subagent: state };
    switch (status) {
      case 'completed':
        return { text: ending.report, isError: false, details };
      case 'partial':
        return { text: partialReport(ending.turns, ending.report), isError: false, details };
      case 'interrupted':
        return {
          text: `The subagent was interrupted before it finished. What it had so far:\n${ending.report}`,
          isError: true,
          details,
        };
      default:
        return {
          text: `The subagent failed: ${ending.error ?? 'unknown error'}`,
          isError: true,
          details,
        };
    }
  }

  /** A background run ended: its report reaches the parent's next request. */
  #deliver(run: Run, report: string): void {
    // The nearest session still open: a subagent that started the run may have ended.
    const parent = [...run.ancestors]
      .reverse()
      .map((id) => this.#parent(id))
      .find((p) => p !== undefined);
    if (parent === undefined) {
      this.#options.log(
        `[session ${run.parentId}] background subagent ${run.id} ended after its parent closed`,
      );
      return;
    }
    parent.harness.remind({
      type: 'backgroundTask',
      source: `subagent:${run.id}`,
      text: backgroundFinished(
        run.state.agentType,
        run.state.description,
        run.state.status,
        report,
        run.state.transcriptPath,
      ),
    });
  }

  /** The model and effort of a run: the call's, else the definition's, else the type's. */
  async #model(
    parent: ParentSession,
    definition: AgentDefinition,
    call: AgentCall,
    catalog: AgentCatalog,
  ) {
    // Pi types the session's model loosely (`Model<any>`).
    const inherit = parent.session.model as Model<Api> | undefined;
    if (inherit === undefined) return { ok: false as const, message: 'The session has no model.' };
    const spec = call.model ?? definition.model ?? undefined;
    const resolved = resolveModel(spec, {
      aliases: catalog.aliases,
      inherit,
      available: await this.#options.workspace.modelRuntime.getAvailable(),
    });
    if (!resolved.ok) return resolved;
    const warnings: AgentWarning[] = [];
    if (resolved.warning !== undefined) {
      warnings.push({ kind: 'aliasFallback', value: resolved.warning.alias });
    }
    const supported: readonly string[] = supportedEfforts(resolved.model);
    const asked = call.effort ?? definition.effort ?? undefined;
    let effort: EffortLevel | undefined;
    if (asked !== undefined && supported.includes(asked)) {
      effort = asked as EffortLevel;
    } else {
      if (asked !== undefined) warnings.push({ kind: 'effortUnsupported', value: asked });
      effort =
        this.#options.workspace.preferences.defaultEffort(resolved.model, supported) ??
        (supported.includes(parent.session.thinkingLevel)
          ? (parent.session.thinkingLevel as EffortLevel)
          : undefined);
    }
    return { ok: true as const, model: resolved.model, effort, warnings };
  }

  /**
   * A main session reopened after the Agent Host restarted: its background runs that never
   * reported are over. Each gets an interrupted state and a reminder for the next request.
   */
  recover(sessionId: string, manager: SessionManager, harness: SessionHarness): void {
    const ended = new Set<string>();
    const started = new Map<string, SubagentState>();
    for (const entry of manager.getBranch()) {
      const state = startedState(entry);
      if (state !== undefined) started.set(state.itemId, state.subagent);
      if (entry.type === 'custom' && entry.customType === SUBAGENT_STATE_ENTRY) {
        const itemId = isObject(entry.data) ? entry.data.itemId : undefined;
        if (typeof itemId === 'string') ended.add(itemId);
      }
    }
    for (const [itemId, state] of started) {
      if (ended.has(itemId) || this.#runs.has(state.sessionId)) continue;
      const interrupted: SubagentState = { ...state, status: 'interrupted' };
      manager.appendCustomEntry(SUBAGENT_STATE_ENTRY, { itemId, subagent: interrupted });
      harness.remind({
        type: 'backgroundTask',
        source: `subagent:${state.sessionId}`,
        text: backgroundFinished(
          state.agentType,
          state.description,
          'interrupted: the Agent Host stopped',
          '(none)',
          state.transcriptPath,
        ),
      });
      this.#options.log(
        `[session ${sessionId}] background subagent ${state.sessionId} was interrupted`,
      );
    }
  }
}

/** A background run's state from its `Agent` result (it returned while the run went on). */
function startedState(
  entry: SessionEntry,
): { itemId: string; subagent: SubagentState } | undefined {
  if (entry.type !== 'message') return undefined;
  const message: unknown = entry.message;
  if (!isObject(message) || message.role !== 'toolResult' || message.isError === true) {
    return undefined;
  }
  const details: unknown = message.details;
  const subagent: unknown = isObject(details) ? details.subagent : undefined;
  if (
    !isObject(subagent) ||
    subagent.background !== true ||
    subagent.status !== 'running' ||
    typeof message.toolCallId !== 'string'
  ) {
    return undefined;
  }
  return { itemId: message.toolCallId, subagent: subagent as unknown as SubagentState };
}
