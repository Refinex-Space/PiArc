// The sessions hosted by this process: sessionId → Pi AgentSessionRuntime (architecture
// section 5.3). Every session has its own cwd, its own file-backed SessionManager under
// `<agentDir>/sessions/` and its own resource loader; they share the workspace's ModelRuntime.
//
// Turns: one accepted input (`session/prompt`, or `session/steer` / `session/followUp` on an
// idle session) is one turn. While it runs, steering messages go to Pi's queue and follow-ups
// wait in the session's input queue (queue.ts); when the turn completes, each follow-up starts
// the next turn, in queue order. An interrupted turn returns the queue to Core and is closed in
// the transcript by the Harness Kit (harness/interruption.ts).
//
// Process-wide state is the hazard of running sessions side by side (ADR-0010). This file
// never touches `process.cwd()` or `process.env`; Pi resolves relative tool paths against each
// session's cwd. The few Pi defaults that read the process-global agent directory
// (`getAgentDir()`) are pinned to PiArc's directory once, in main.ts.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createMcpExtension,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
} from '@earendil-works/pi-coding-agent';
import type {
  HistoryWindow,
  InputAccepted,
  RewindMode,
  SessionRewound,
  ModelRef,
  ModelsListResult,
  SessionModelSelection,
  PermissionMode,
  PromptAccepted,
  QueueState,
  SessionOpened,
  SessionStopped,
} from '@piarc/protocol';

import { memoryReader } from '../harness/memory-io.js';
import { IDENTITY } from '../harness/prompts/system.js';
import { SessionMemory } from '../harness/session-memory.js';
import { SessionHooks } from '../harness/hooks.js';
import { expiredApprovals, policyGate, preflightInput } from '../harness/policy.js';
import { SessionHarness } from '../harness/session-harness.js';
import {
  interruptedContext,
  missingToolCalls,
  repairInterruptedTurn,
} from '../harness/interruption.js';
import { takeOverProjectTrust, type TrustTakeover } from '../harness/project-trust.js';
import { CONCURRENCY_SAFE_TOOLS, ToolBatches } from '../harness/tool-batches.js';
import { createToolResultBudget, TOOL_RESULT_LIMITS } from '../harness/tool-results.js';
import { AhpError, describeError } from '../protocol/errors.js';
import { DEFAULT_PROFILE, ToolNameMap, toolOptions } from '../tools/index.js';
import {
  branchPoints,
  forkedManager,
  rewindToTurn,
  startsAtFork,
  summarizeFromTurn,
  switchTo,
} from './branches.js';
import { checkHistoryLimit, historyOf } from './history.js';
import {
  composedText,
  INPUT_ENTRY,
  inputRecord,
  type PreparedInput,
  type UserInput,
} from './input.js';
import { modeRecord } from './permission-mode.js';
import { contentText } from './items.js';
import { Projector } from './projector.js';
import { listModels, previewSwitch, selectEffort, selectModel } from './session-models.js';
import { InputQueue } from './queue.js';
import {
  checkImageInput,
  checkSessionId,
  prepareAttachments,
  scheduled,
  shellsFor,
  stopped,
  withHookContext,
} from './session-helpers.js';
import {
  PI_NATIVE_TOOLS,
  type HostedSession,
  type Job,
  type RegistryOptions,
} from './session-types.js';
import type { Workspace } from './workspace.js';

export type {
  RecordedControl,
  RegistryOptions,
  SessionSinkFactory,
  ToolBackend,
} from './session-types.js';

export class SessionRegistry {
  readonly #options: RegistryOptions;
  readonly #sessions = new Map<string, HostedSession>();
  /** Opens in progress by session id: a second resume of the same id waits for the first. */
  readonly #opening = new Map<string, Promise<SessionOpened>>();

  constructor(options: RegistryOptions) {
    if (path.resolve(getAgentDir()) !== path.resolve(options.workspace.agentDir)) {
      // Pi's MCP extension and default session paths read the process-global agent directory.
      throw new Error(
        `PI_CODING_AGENT_DIR must point at ${options.workspace.agentDir}, got ${getAgentDir()}`,
      );
    }
    this.#options = options;
  }

  get size(): number {
    return this.#sessions.size;
  }

  get workspace(): Workspace {
    return this.#options.workspace;
  }

  async models(sessionId?: string): Promise<ModelsListResult> {
    const session = sessionId === undefined ? undefined : this.#get(sessionId).runtime.session;
    return listModels(this.workspace, session);
  }

  previewModelSwitch(sessionId: string, ref: ModelRef) {
    return previewSwitch(this.workspace, this.#get(sessionId).runtime.session, ref);
  }

  async setModel(
    sessionId: string,
    ref: ModelRef,
    requested?: string,
  ): Promise<SessionModelSelection> {
    const hosted = this.#get(sessionId);
    this.#checkIdle(sessionId, hosted);
    hosted.changingModel = true;
    try {
      const selection = await selectModel(this.workspace, hosted.runtime.session, ref, requested);
      // The compaction threshold follows the model's window and output.
      hosted.harness.compaction.apply();
      return selection;
    } finally {
      hosted.changingModel = false;
    }
  }

  setEffort(sessionId: string, requested: string): SessionModelSelection {
    const hosted = this.#get(sessionId);
    this.#checkIdle(sessionId, hosted);
    return selectEffort(this.workspace, hosted.runtime.session, requested);
  }

  /** Creates a session in `cwd`, under `sessionId` when Core chose one. */
  async create(
    cwd: string,
    model: ModelRef | undefined,
    sessionId: string | undefined,
  ): Promise<SessionOpened> {
    if (sessionId === undefined) {
      return this.#open(cwd, SessionManager.create(cwd), model);
    }
    checkSessionId(sessionId);
    if (this.#sessions.has(sessionId)) {
      // A retried create (its first answer was lost): the session is already open.
      return this.#opened(sessionId);
    }
    return this.#once(sessionId, () =>
      this.#open(cwd, SessionManager.create(cwd, undefined, { id: sessionId }), model),
    );
  }

  /** Reopens a session by id; one that never stored a message starts empty under that id. */
  async resume(sessionId: string, cwd: string): Promise<SessionOpened> {
    checkSessionId(sessionId);
    if (this.#sessions.has(sessionId)) {
      return this.#opened(sessionId);
    }
    return this.#once(sessionId, () => {
      const file = SessionManager.findById(cwd, sessionId);
      const manager =
        file === undefined
          ? SessionManager.create(cwd, undefined, { id: sessionId })
          : SessionManager.open(file);
      return this.#open(cwd, manager, undefined, 'resume');
    });
  }

  /**
   * Opens a new session whose conversation is `sessionId`'s current branch up to `entryId`, or
   * up to where turn `beforeTurn` started (T28's "branch from here"; an empty session for the
   * first turn).
   */
  async fork(
    sessionId: string,
    cwd: string,
    entryId: string | undefined,
    beforeTurn?: string,
  ): Promise<SessionOpened> {
    checkSessionId(sessionId);
    const file =
      this.#sessions.get(sessionId)?.runtime.session.sessionFile ??
      SessionManager.findById(cwd, sessionId);
    return this.#open(
      cwd,
      forkedManager(sessionId, cwd, file, entryId, beforeTurn),
      undefined,
      'fork',
    );
  }

  /**
   * Accepts a prompt; the turn runs after the response is queued. Attachments are read first
   * (input.ts), so an unreadable attachment fails the request rather than the turn.
   */
  async prompt(
    sessionId: string,
    requestId: string,
    input: UserInput,
    hookContext?: string,
  ): Promise<PromptAccepted> {
    const hosted = this.#get(sessionId);
    const known = hosted.prompts.get(requestId);
    if (known !== undefined) {
      return { turnId: known };
    }
    return this.#onceFor(hosted, requestId, async () => {
      const prepared = withHookContext(await this.#prepare(sessionId, input), hookContext);
      const again = hosted.prompts.get(requestId);
      if (again !== undefined) {
        return { turnId: again };
      }
      this.#checkIdle(sessionId, hosted);
      const turnId = this.#startTurn(sessionId, hosted, { kind: 'prompt', prepared });
      hosted.prompts.set(requestId, turnId);
      return { turnId };
    });
  }

  /** Compacts the conversation as a turn of its own (`/compact [focus]`); the session must be
   * idle. */
  compact(sessionId: string, requestId: string, instructions?: string): PromptAccepted {
    const hosted = this.#get(sessionId);
    const known = hosted.prompts.get(requestId);
    if (known !== undefined) {
      return { turnId: known };
    }
    this.#checkIdle(sessionId, hosted);
    const turnId = this.#startTurn(sessionId, hosted, { kind: 'compact', instructions });
    hosted.prompts.set(requestId, turnId);
    return { turnId };
  }

  /**
   * Moves the conversation to before turn `turnId` (T28): as a new branch, or with the turn and
   * everything after it summarized. The session reopens on the new branch.
   */
  async rewind(sessionId: string, turnId: string, mode: RewindMode): Promise<SessionRewound> {
    const hosted = this.#get(sessionId);
    this.#checkIdle(sessionId, hosted);
    const manager = hosted.runtime.session.sessionManager;
    let text: string | undefined;
    if (mode === 'summarize') {
      await summarizeFromTurn(manager, turnId, (entries) =>
        hosted.harness.compaction.summarizeBranch(entries, new AbortController().signal),
      );
    } else {
      text = rewindToTurn(manager, turnId);
    }
    const opened = await this.#reopen(sessionId, hosted);
    return { ...opened, ...(text === undefined ? {} : { text }) };
  }

  /** Continues the conversation on the branch whose last entry is `entryId` (T28). */
  async switchBranch(sessionId: string, entryId: string): Promise<SessionRewound> {
    const hosted = this.#get(sessionId);
    this.#checkIdle(sessionId, hosted);
    switchTo(hosted.runtime.session.sessionManager, entryId);
    return this.#reopen(sessionId, hosted);
  }

  /** The running turn of `sessionId` (its writes' checkpoint). */
  activeTurn(sessionId: string): string | undefined {
    return this.#sessions.get(sessionId)?.projector.activeTurnId;
  }

  /**
   * A steering message (`kind` steer) or a follow-up: queued while a turn runs, otherwise it
   * starts a turn like a prompt.
   */
  async input(
    sessionId: string,
    requestId: string,
    input: UserInput,
    kind: 'steer' | 'followUp',
    hookContext?: string,
  ): Promise<InputAccepted> {
    const hosted = this.#get(sessionId);
    const known = hosted.inputs.get(requestId);
    if (known !== undefined) {
      return known;
    }
    return this.#onceFor(hosted, requestId, async () => {
      const prepared = withHookContext(await this.#prepare(sessionId, input), hookContext);
      const again = hosted.inputs.get(requestId);
      if (again !== undefined) {
        return again;
      }
      if (hosted.changingModel) throw new AhpError('sessionBusy', 'The model is changing');
      this.#checkImageInput(sessionId, input);
      const text = composedText(prepared);
      let answer: InputAccepted;
      if (hosted.projector.activeTurnId === undefined) {
        answer = {
          disposition: 'started',
          turnId: this.#startTurn(sessionId, hosted, { kind: 'prompt', prepared }),
        };
      } else if (kind === 'steer') {
        this.#options.onPiEvent?.(sessionId, { control: 'steer', text });
        answer = { disposition: 'queued', itemId: await hosted.queue.steer(prepared) };
        hosted.hooks?.addContext(prepared.hookContext);
      } else {
        this.#options.onPiEvent?.(sessionId, { control: 'followUp', text });
        answer = { disposition: 'queued', itemId: hosted.queue.followUp(prepared) };
      }
      hosted.inputs.set(requestId, answer);
      return answer;
    });
  }

  async editQueue(sessionId: string, itemId: string, text: string): Promise<QueueState> {
    return { items: [...(await this.#get(sessionId).queue.edit(itemId, text))] };
  }

  async deleteQueued(sessionId: string, itemId: string): Promise<QueueState> {
    return { items: [...(await this.#get(sessionId).queue.delete(itemId))] };
  }

  async reorderQueue(sessionId: string, itemIds: readonly string[]): Promise<QueueState> {
    return { items: [...(await this.#get(sessionId).queue.reorder(itemIds))] };
  }

  /** Interrupts the running turn, waits until the session is idle and returns the queue. */
  async abort(sessionId: string): Promise<SessionStopped> {
    const hosted = this.#get(sessionId);
    const turnId = hosted.projector.activeTurnId;
    this.#options.onPiEvent?.(sessionId, { control: 'markAborting' });
    hosted.projector.markAborting();
    hosted.memory.cancel();
    const returned = hosted.queue.takeAll();
    await hosted.runtime.session.abort();
    if (turnId !== undefined) {
      hosted.projector.finishTurn(turnId, 'interrupted');
    }
    return stopped(sessionId, turnId, returned);
  }

  /** Aborts, shuts the session down (extensions get `session_shutdown`) and forgets it. */
  async close(sessionId: string): Promise<SessionStopped> {
    const hosted = this.#get(sessionId);
    const turnId = hosted.projector.activeTurnId;
    hosted.closed = true;
    hosted.projector.markAborting();
    hosted.memory.cancel();
    const returned = hosted.queue.takeAll();
    this.#sessions.delete(sessionId);
    try {
      await hosted.runtime.dispose();
    } finally {
      if (turnId !== undefined) {
        hosted.projector.finishTurn(turnId, 'interrupted');
      }
      hosted.unsubscribe();
      this.#options.onClosed?.(sessionId);
    }
    return stopped(sessionId, turnId, returned);
  }

  /** Closes every session; failures are logged, not thrown. */
  async closeAll(): Promise<number> {
    const ids = [...this.#sessions.keys()];
    await Promise.all(
      ids.map(async (id) => {
        try {
          await this.close(id);
        } catch (error) {
          this.#options.log(`[session ${id}] close failed: ${describeError(error)}`);
        }
      }),
    );
    return ids.length;
  }

  /** The persisted conversation of a session (open or not) as items. */
  history(sessionId: string, cwd: string, start: number | undefined, limit: number): HistoryWindow {
    checkSessionId(sessionId);
    checkHistoryLimit(limit);
    const hosted = this.#sessions.get(sessionId);
    let manager = hosted?.runtime.session.sessionManager;
    let toCanonical = hosted?.toCanonical ?? ((tool: string): string => tool);
    const { tools, hostTools } = this.#options;
    if (hosted === undefined) {
      const file = SessionManager.findById(cwd, sessionId);
      manager = file === undefined ? undefined : SessionManager.open(file);
      if (tools.kind === 'core') {
        const names = new ToolNameMap(tools.profile);
        toCanonical = (tool) => names.toCanonical(tool);
      }
    }
    return historyOf(manager, toCanonical, hostTools, start, limit);
  }

  #once(sessionId: string, open: () => Promise<SessionOpened>): Promise<SessionOpened> {
    const pending = this.#opening.get(sessionId);
    if (pending !== undefined) {
      return pending;
    }
    const opening = open().finally(() => this.#opening.delete(sessionId));
    this.#opening.set(sessionId, opening);
    return opening;
  }

  /** Runs `answer` once per idempotency key while it is in progress. */
  async #onceFor<T>(
    hosted: HostedSession,
    requestId: string,
    answer: () => Promise<T>,
  ): Promise<T> {
    const pending = hosted.preparing.get(requestId);
    if (pending !== undefined) {
      return pending as Promise<T>;
    }
    const running = answer().finally(() => hosted.preparing.delete(requestId));
    hosted.preparing.set(requestId, running);
    return running;
  }

  /** Reads an input's attachments through Core (images by blob, PDFs by `fs/pdf`). */
  async #prepare(sessionId: string, input: UserInput): Promise<PreparedInput> {
    this.#checkImageInput(sessionId, input);
    const { tools } = this.#options;
    return prepareAttachments(
      tools.kind === 'core' ? tools.ioFor(sessionId) : undefined,
      sessionId,
      input,
    );
  }

  #checkImageInput(sessionId: string, input: UserInput): void {
    checkImageInput(this.workspace, this.#get(sessionId).runtime.session.model, input);
  }

  #checkIdle(sessionId: string, hosted: HostedSession): void {
    if (hosted.changingModel) throw new AhpError('sessionBusy', 'The model is changing');
    const running = hosted.projector.activeTurnId;
    if (running !== undefined) {
      throw new AhpError('sessionBusy', `session ${sessionId} is running turn ${running}`, {
        retryable: true,
        details: { sessionId, turnId: running },
      });
    }
  }

  #opened(sessionId: string): SessionOpened {
    const { session } = this.#get(sessionId).runtime;
    const last = session.sessionManager
      .getBranch()
      .findLast((entry) => modeRecord(entry) !== undefined);
    const mode = last === undefined ? undefined : modeRecord(last)?.mode;
    return {
      sessionId,
      restoredMessages: session.messages.length,
      ...(mode === undefined ? {} : { permissionMode: mode }),
    };
  }

  /**
   * Closes and reopens `sessionId` from its file after its branch changed (T28, ADR-0044
   * rule 6): the plan, the mode, memory and the files read are those of the new branch. Hooks see
   * neither an end nor a start; the replay buffer and `seq` continue.
   */
  async #reopen(sessionId: string, hosted: HostedSession): Promise<SessionOpened> {
    const { session } = hosted.runtime;
    const file = session.sessionFile;
    if (file === undefined) {
      throw new AhpError('internalError', `session ${sessionId} has no file to reopen`);
    }
    const cwd = session.sessionManager.getCwd();
    hosted.closed = true;
    hosted.hooks?.mute();
    hosted.memory.cancel();
    this.#sessions.delete(sessionId);
    try {
      await hosted.runtime.dispose();
    } finally {
      hosted.unsubscribe();
    }
    return this.#once(sessionId, () =>
      this.#open(cwd, SessionManager.open(file), undefined, 'branch'),
    );
  }

  /** Record before notifying Core or publishing the row. */
  setPermissionMode(sessionId: string, mode: PermissionMode): void {
    this.#get(sessionId).harness.recordMode(mode);
  }

  /** The session's Harness Kit (`session/remind`, `session/getContextUsage`). */
  harness(sessionId: string): SessionHarness {
    return this.#get(sessionId).harness;
  }

  #startTurn(sessionId: string, hosted: HostedSession, job: Job): string {
    const turnId = `turn-${randomUUID()}`;
    this.#options.onPiEvent?.(sessionId, { control: 'beginTurn', turnId });
    hosted.projector.beginTurn(turnId);
    // Start on the next macrotask: the handler's response is queued first, so Core learns the
    // turn id before any of the turn's notifications.
    setImmediate(() => {
      void this.#run(sessionId, hosted, turnId, job);
    });
    return turnId;
  }

  async #open(
    cwd: string,
    manager: SessionManager,
    model: ModelRef | undefined,
    source: 'startup' | 'resume' | 'fork' | 'branch' = 'startup',
  ): Promise<SessionOpened> {
    const recovering = source === 'resume';
    const { workspace } = this.#options;
    let trust: TrustTakeover | undefined;
    const selected =
      model === undefined ? undefined : workspace.modelRuntime.getModel(model.provider, model.id);
    if (model !== undefined && selected === undefined) {
      throw new AhpError('invalidParams', `unknown model ${model.provider}/${model.id}`, {
        details: model,
      });
    }
    const { tools } = this.#options;
    const names = tools.kind === 'core' ? new ToolNameMap(tools.profile) : undefined;
    const toCanonical = (tool: string): string => names?.toCanonical(tool) ?? tool;
    const batches = new ToolBatches((tool) => CONCURRENCY_SAFE_TOOLS.has(toCanonical(tool)));
    // The session object exists once the runtime is created; hooks read it lazily.
    const opened: { session?: AgentSession; projector?: Projector } = {};
    const sessionLog = (line: string): void => {
      this.#options.log(`[session ${manager.getSessionId()}] ${line}`);
    };
    const harness = new SessionHarness({
      sessionId: manager.getSessionId(),
      manager,
      sink: this.#options.sinkFor(manager.getSessionId()),
      profile: tools.kind === 'core' ? tools.profile : DEFAULT_PROFILE,
      canonical: toCanonical,
      activeTurn: () => opened.projector?.activeTurnId,
      core: tools.kind === 'core' ? this.#options.hostTools : undefined,
      cwd,
      session: () => opened.session,
      io: tools.kind === 'core' ? tools.ioFor(manager.getSessionId()) : undefined,
      appended: (message) => opened.projector?.reminder(message),
      log: sessionLog,
    });
    const memory = new SessionMemory(
      manager,
      cwd,
      tools.kind === 'core' ? tools.profile : undefined,
      this.#options.memoryBridge
        ? memoryReader(this.#options.memoryBridge, manager.getSessionId())
        : undefined,
      toCanonical,
      harness.reminders,
    );
    const hooksBridge = tools.kind === 'core' ? this.#options.hooksBridge : undefined;
    const hooks =
      hooksBridge === undefined
        ? undefined
        : new SessionHooks({
            bridge: hooksBridge,
            sessionId: manager.getSessionId(),
            cwd,
            source,
            canonical: toCanonical,
            transcript: () => opened.session?.sessionFile ?? manager.getSessionFile(),
            reminders: harness.reminders,
            hookInput: (tool, input) => {
              const resolved = preflightInput(tool, input, cwd);
              delete resolved.readPathCandidates;
              return resolved;
            },
            log: sessionLog,
          });
    harness.connect(memory, hooks);
    const factory: CreateAgentSessionRuntimeFactory = async (target) => {
      // In-memory overrides (no silent provider retries, the compaction threshold) are
      // applied by `harness.compaction` once the session exists and before every run.
      const settingsManager = SettingsManager.create(target.cwd, target.agentDir, {
        projectTrusted: false,
      });
      const io =
        tools.kind === 'core' ? tools.ioFor(target.sessionManager.getSessionId()) : undefined;
      // Which command tools the session gets depends on the shells Core found (T17).
      const sessionTools =
        tools.kind === 'core' && io !== undefined
          ? scheduled(
              toolOptions(
                io,
                tools.profile,
                await shellsFor(io, this.#options.log),
                settingsManager.getImageAutoResize(),
                this.#options.memoryBridge ? memory.searched : undefined,
                harness.tools(),
              ),
              batches,
            )
          : { tools: PI_NATIVE_TOOLS };
      // Long tool results go to the session's temporary directory (Harness Kit).
      const budget =
        io === undefined
          ? []
          : [
              createToolResultBudget({
                io,
                isExempt: (tool) => toCanonical(tool) === 'Read',
                limits: this.#options.toolResultLimits ?? TOOL_RESULT_LIMITS,
              }),
            ];
      // Project-level Pi resources (`.pi/settings.json`, `.pi/mcp.json`, extensions) load
      // only for directories Core trusts: nothing project-level is read until the takeover
      // hook has Core's answer.
      trust = takeOverProjectTrust(target.cwd, this.#options.isTrusted);
      const services = await createAgentSessionServices({
        cwd: target.cwd,
        agentDir: target.agentDir,
        modelRuntime: workspace.modelRuntime,
        settingsManager,
        resourceLoaderReloadOptions: trust.reloadOptions,
        resourceLoaderOptions: {
          // PiArc assembles project context itself (T22).
          noContextFiles: true,
          systemPromptOverride: () => IDENTITY,
          appendSystemPromptOverride: () => [],
          extensionFactories: [
            ...(tools.kind === 'core'
              ? [
                  policyGate(
                    tools.bridge,
                    target.sessionManager.getSessionId(),
                    toCanonical,
                    (id) => {
                      projector.markDeclined(id);
                    },
                    (line) => {
                      this.#options.log(
                        `[session ${target.sessionManager.getSessionId()}] ${line}`,
                      );
                    },
                    hooks?.notes,
                    (mode) => {
                      harness.recordMode(mode);
                    },
                  ),
                ]
              : []),
            createMcpExtension(),
            ...budget,
            // After the budget: hooks see (and may replace) what the model would read.
            ...(hooks === undefined ? [] : [hooks.extension]),
            interruptedContext,
            memory.extension,
            ...(tools.kind === 'core' ? harness.extensions() : []),
          ],
          // Extension tools (MCP, project extensions) run under the same batches.
          extensionsOverride: (result) => batches.wrapExtensions(result),
        },
      });
      const result = await createAgentSessionFromServices({
        services,
        sessionManager: target.sessionManager,
        ...sessionTools,
        ...(target.sessionStartEvent === undefined
          ? {}
          : { sessionStartEvent: target.sessionStartEvent }),
        ...(selected === undefined ? {} : { model: selected }),
      });
      return { ...result, services, diagnostics: services.diagnostics };
    };
    const runtime = await createAgentSessionRuntime(factory, {
      cwd,
      agentDir: workspace.agentDir,
      sessionManager: manager,
    });
    const { session } = runtime;
    opened.session = session;
    harness.compaction.apply();
    const sessionId = session.sessionId;
    const log = (line: string): void => {
      this.#options.log(`[session ${sessionId}] ${line}`);
    };
    for (const diagnostic of runtime.diagnostics) {
      log(`${diagnostic.type}: ${diagnostic.message}`);
    }
    if (runtime.modelFallbackMessage !== undefined) {
      log(runtime.modelFallbackMessage);
    }
    const sink = this.#options.sinkFor(sessionId);
    const projector = new Projector(sink, toCanonical, {
      reminders: this.#options.hostTools?.context === true,
      compactionNote: () => harness.compaction.takeNote(),
    });
    opened.projector = projector;
    const delivering: PreparedInput[] = [];
    const queue = new InputQueue(
      sessionId,
      session,
      (items) => {
        sink.event('session/queueChanged', { items: [...items] });
      },
      (prepared) => {
        delivering.push(prepared);
      },
    );
    const hosted: HostedSession = {
      runtime,
      projector,
      memory,
      queue,
      batches,
      toCanonical,
      hooks,
      harness,
      unsubscribe: () => undefined,
      prompts: new Map(),
      inputs: new Map(),
      preparing: new Map(),
      delivering,
      changingModel: false,
      closed: false,
    };
    hosted.unsubscribe = session.subscribe((event) => {
      this.#onEvent(sessionId, hosted, event);
    });
    try {
      // A turn the previous process left unfinished (it crashed or was killed) is closed like an
      // interrupted one; a conversation that ends with a response stays as it is.
      const expired =
        recovering && tools.kind === 'core'
          ? await expiredApprovals(tools.bridge, sessionId, missingToolCalls(session))
          : new Map<string, string>();
      const repair = repairInterruptedTurn(session, expired);
      if (repair.toolResults > 0 || repair.marker) {
        log(
          `closed a turn left unfinished: ${String(repair.toolResults)} interrupted tool result(s), marker ${String(repair.marker)}`,
        );
      }
      // Emits session_start: the MCP extension connects its servers now.
      await session.bindExtensions({
        onError: (error) => {
          log(`extension ${error.extensionPath} failed in ${error.event}: ${error.error}`);
        },
      });
    } catch (error) {
      hosted.unsubscribe();
      await runtime.dispose();
      throw error;
    }
    log(
      `opened in ${cwd} (trusted: ${String(trust?.trusted() ?? false)}, model: ${session.model?.provider ?? '-'}/${session.model?.id ?? '-'})`,
    );
    this.#sessions.set(sessionId, hosted);
    return this.#opened(sessionId);
  }

  #onEvent(sessionId: string, hosted: HostedSession, event: AgentSessionEvent): void {
    this.#options.onPiEvent?.(sessionId, event);
    const { batches, queue, projector } = hosted;
    switch (event.type) {
      case 'message_end':
        if (event.message.role === 'assistant' && event.message.stopReason === 'toolUse') {
          batches.plan(
            event.message.content.flatMap((part) =>
              part.type === 'toolCall' ? [{ id: part.id, name: part.name }] : [],
            ),
          );
        }
        break;
      case 'tool_execution_end':
        batches.done(event.toolCallId);
        break;
      case 'agent_end':
        batches.clear();
        break;
      case 'queue_update':
        queue.reconcile(event.steering);
        break;
      case 'message_start':
        if (event.message.role === 'user') {
          this.#recordInput(hosted, contentText(event.message.content) ?? '');
        }
        break;
      case 'agent_settled':
        if (event.aborted) {
          const repair = repairInterruptedTurn(hosted.runtime.session);
          if (repair.toolResults > 0 || repair.marker) {
            this.#options.log(
              `[session ${sessionId}] interrupted turn closed: ${String(repair.toolResults)} interrupted tool result(s), marker ${String(repair.marker)}`,
            );
          }
        }
        break;
      default:
        break;
    }
    hosted.harness.observe(event);
    projector.handle(event);
    hosted.harness.onEvent(event);
    if (event.type === 'agent_settled') {
      queue.settle();
      hosted.delivering.length = 0;
    }
  }

  /**
   * Pi persists the user message at message_end. Record its turn before it, including what
   * the user wrote when the composed message has additional attachment or mention data.
   */
  #recordInput(hosted: HostedSession, text: string): void {
    const index = hosted.delivering.findIndex((prepared) => composedText(prepared) === text);
    if (index === -1) {
      return;
    }
    const [prepared] = hosted.delivering.splice(index, 1);
    if (prepared === undefined) return;
    const record = inputRecord(prepared);
    const turnId = hosted.projector.activeTurnId;
    const { session } = hosted.runtime;
    const from = hosted.turnFrom?.turnId === turnId ? hosted.turnFrom : undefined;
    session.sessionManager.appendCustomEntry(INPUT_ENTRY, {
      turnId,
      ...(from === undefined ? {} : { from: from.from }),
      ...record,
    });
    if (record !== undefined) hosted.projector.useInput(record);
    // The turn starts where other branches start: the client shows the switcher (T28).
    if (
      from !== undefined &&
      turnId !== undefined &&
      this.#options.hostTools?.checkpoints === true &&
      startsAtFork(session.sessionManager, turnId)
    ) {
      this.#options
        .sinkFor(session.sessionId)
        .event('session/branches', { branches: branchPoints(session.sessionManager) });
    }
  }

  async #run(sessionId: string, hosted: HostedSession, turnId: string, job: Job): Promise<void> {
    let next: { readonly turnId: string; readonly job: Job } | undefined = { turnId, job };
    while (next !== undefined) {
      if (hosted.closed || hosted.projector.activeTurnId !== next.turnId) {
        return; // aborted or closed before it started
      }
      try {
        const { session } = hosted.runtime;
        // Before an automatic compaction can append anything: a rewind continues from here.
        hosted.turnFrom = { turnId: next.turnId, from: session.sessionManager.getLeafId() };
        await hosted.harness.compaction.prepare();
        if (next.job.kind === 'compact') {
          session.sessionManager.appendCustomEntry(INPUT_ENTRY, {
            turnId: next.turnId,
            action: 'compact',
            from: hosted.turnFrom.from,
          });
          await session.compact(next.job.instructions);
        } else {
          const { prepared } = next.job;
          this.#checkImageInput(sessionId, prepared.input);
          // An interrupt while an external memory import awaits approval ends this turn
          // before Pi owns it. The abort handler publishes the interrupted outcome.
          if (
            !(await hosted.memory.prepare(next.turnId)) ||
            hosted.projector.activeTurnId !== next.turnId
          )
            return;
          hosted.delivering.push(prepared);
          hosted.hooks?.addContext(prepared.hookContext);
          await session.prompt(
            composedText(prepared),
            prepared.images.length === 0 ? undefined : { images: [...prepared.images] },
          );
        }
        hosted.projector.finishTurn(next.turnId, 'completed');
      } catch (error) {
        // A compaction whose summary failed was cancelled: its reason is the error.
        const reason =
          (next.job.kind === 'compact' ? hosted.harness.compaction.lastFailure : undefined) ??
          describeError(error);
        this.#options.log(`[session ${sessionId}] ${next.job.kind} failed: ${reason}`);
        hosted.projector.finishTurn(next.turnId, 'failed', reason);
      }
      next = this.#nextFollowUp(sessionId, hosted);
    }
  }

  /** Starts the first queued follow-up as the next turn, when the session is idle. */
  #nextFollowUp(
    sessionId: string,
    hosted: HostedSession,
  ): { turnId: string; job: Job } | undefined {
    if (hosted.closed || hosted.projector.activeTurnId !== undefined) {
      return undefined;
    }
    const entry = hosted.queue.takeFollowUp();
    if (entry === undefined) {
      return undefined;
    }
    this.#options.onPiEvent?.(sessionId, { control: 'takeFollowUp' });
    const turnId = `turn-${randomUUID()}`;
    this.#options.onPiEvent?.(sessionId, { control: 'beginTurn', turnId });
    hosted.projector.beginTurn(turnId);
    return { turnId, job: { kind: 'prompt', prepared: entry.prepared } };
  }

  #get(sessionId: string): HostedSession {
    const hosted = this.#sessions.get(sessionId);
    if (hosted === undefined) {
      throw new AhpError('sessionNotFound', `no open session ${sessionId}`, {
        details: { sessionId },
      });
    }
    return hosted;
  }
}
