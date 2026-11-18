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
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type {
  HistoryWindow,
  InputAccepted,
  ModelRef,
  PromptAccepted,
  QueueItem,
  QueueState,
  SessionOpened,
  SessionStopped,
} from '@piarc/protocol';

import { repairInterruptedTurn } from '../harness/interruption.js';
import { takeOverProjectTrust, type TrustTakeover } from '../harness/project-trust.js';
import { CONCURRENCY_SAFE_TOOLS, ToolBatches } from '../harness/tool-batches.js';
import {
  createToolResultBudget,
  TOOL_RESULT_LIMITS,
  type ToolResultLimits,
} from '../harness/tool-results.js';
import { AhpError, describeError } from '../protocol/errors.js';
import {
  ToolNameMap,
  toolOptions,
  type CoreIo,
  type Shells,
  type ToolProfile,
} from '../tools/index.js';
import { historyWindow, MAX_HISTORY_LIMIT, projectHistory } from './history.js';
import {
  composedText,
  INPUT_ENTRY,
  inputRecord,
  prepareInput,
  type PreparedInput,
  type UserInput,
} from './input.js';
import { contentText } from './items.js';
import { Projector, type ProjectionSink } from './projector.js';
import { InputQueue } from './queue.js';
import type { Workspace } from './workspace.js';

/** Emits the projected notifications of one session. */
export type SessionSinkFactory = (sessionId: string) => ProjectionSink;

/**
 * Which tools sessions get. `core`: the canonical tools of `profile` with their I/O delegated to
 * Core (the only mode Core starts the Agent Host in). `pi-native`: Pi's own tools with local I/O,
 * under their own names; only the behavior comparison test uses it (`--pi-native-tools`).
 */
export type ToolBackend =
  | {
      readonly kind: 'core';
      readonly profile: ToolProfile;
      readonly ioFor: (sessionId: string) => CoreIo;
    }
  | { readonly kind: 'pi-native' };

/** Pi's tools the `pi-native` backend activates: the counterparts of the canonical six. */
const PI_NATIVE_TOOLS = ['read', 'write', 'edit', 'bash', 'find', 'grep'];

/** Session ids Core may choose: Pi's own rule is stricter about nothing but length. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

export interface RegistryOptions {
  readonly workspace: Workspace;
  readonly tools: ToolBackend;
  readonly sinkFor: SessionSinkFactory;
  /**
   * Asks Core whether `cwd` is a trusted project (`askCoreTrust`); must resolve `false` on any
   * failure. Answers Pi's project trust hook (`takeOverProjectTrust`).
   */
  readonly isTrusted: (cwd: string) => Promise<boolean>;
  readonly log: (line: string) => void;
  /**
   * Test only (`--test-record-events`): receives every raw Pi event of every session, and the
   * registry's own steps that shape the projection (a turn accepted, an abort, a queued input),
   * so a recording replays exactly.
   */
  readonly onPiEvent?: (sessionId: string, event: AgentSessionEvent | RecordedControl) => void;
  /** A session was closed: its replay buffer can go. */
  readonly onClosed?: (sessionId: string) => void;
  /** How much of a tool result reaches the model; `TOOL_RESULT_LIMITS` when absent. */
  readonly toolResultLimits?: ToolResultLimits;
}

/** What a turn runs: an input, or a compaction (`/compact`). */
type Job =
  { readonly kind: 'prompt'; readonly prepared: PreparedInput } | { readonly kind: 'compact' };

/** A registry step in a recording (`onPiEvent`). */
export type RecordedControl =
  | { readonly control: 'beginTurn'; readonly turnId: string }
  | { readonly control: 'markAborting' }
  | { readonly control: 'takeFollowUp' }
  | { readonly control: 'steer' | 'followUp'; readonly text: string };

interface HostedSession {
  readonly runtime: AgentSessionRuntime;
  readonly projector: Projector;
  readonly queue: InputQueue;
  readonly batches: ToolBatches;
  readonly toCanonical: (tool: string) => string;
  unsubscribe: () => void;
  /** Idempotency keys of accepted prompts → their turn ids. */
  readonly prompts: Map<string, string>;
  /** Idempotency keys of accepted steering and follow-up inputs → their answers. */
  readonly inputs: Map<string, InputAccepted>;
  /** Idempotency keys of requests whose attachments are still being read → their answer. */
  readonly preparing: Map<string, Promise<unknown>>;
  /** Inputs given to Pi whose user message has not started yet (input.ts records). */
  readonly delivering: PreparedInput[];
  closed: boolean;
}

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
      return this.#open(cwd, manager, undefined);
    });
  }

  /** Opens a new session whose conversation is `sessionId`'s current branch up to `entryId`. */
  async fork(sessionId: string, cwd: string, entryId: string | undefined): Promise<SessionOpened> {
    checkSessionId(sessionId);
    const file =
      this.#sessions.get(sessionId)?.runtime.session.sessionFile ??
      SessionManager.findById(cwd, sessionId);
    if (file === undefined) {
      throw new AhpError(
        'invalidParams',
        `session ${sessionId} has no saved conversation to fork`,
        {
          details: { sessionId },
        },
      );
    }
    // A separate reader of the file: the open session's own manager keeps writing its file.
    const source = SessionManager.open(file);
    const leaf = entryId ?? source.getLeafId();
    if (leaf === null || source.getEntry(leaf) === undefined) {
      throw new AhpError('invalidParams', `session ${sessionId} has no entry ${String(entryId)}`, {
        details: { sessionId, entryId },
      });
    }
    const forked = source.createBranchedSession(leaf);
    if (forked === undefined) {
      throw new AhpError('internalError', `forking session ${sessionId} wrote no file`);
    }
    return this.#open(cwd, SessionManager.open(forked), undefined);
  }

  /**
   * Accepts a prompt; the turn runs after the response is queued. Attachments are read first
   * (input.ts), so an unreadable attachment fails the request rather than the turn.
   */
  async prompt(sessionId: string, requestId: string, input: UserInput): Promise<PromptAccepted> {
    const hosted = this.#get(sessionId);
    const known = hosted.prompts.get(requestId);
    if (known !== undefined) {
      return { turnId: known };
    }
    return this.#onceFor(hosted, requestId, async () => {
      const prepared = await this.#prepare(sessionId, input);
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

  /** Compacts the conversation as a turn of its own (`/compact`); the session must be idle. */
  compact(sessionId: string, requestId: string): PromptAccepted {
    const hosted = this.#get(sessionId);
    const known = hosted.prompts.get(requestId);
    if (known !== undefined) {
      return { turnId: known };
    }
    this.#checkIdle(sessionId, hosted);
    const turnId = this.#startTurn(sessionId, hosted, { kind: 'compact' });
    hosted.prompts.set(requestId, turnId);
    return { turnId };
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
  ): Promise<InputAccepted> {
    const hosted = this.#get(sessionId);
    const known = hosted.inputs.get(requestId);
    if (known !== undefined) {
      return known;
    }
    return this.#onceFor(hosted, requestId, async () => {
      const prepared = await this.#prepare(sessionId, input);
      const again = hosted.inputs.get(requestId);
      if (again !== undefined) {
        return again;
      }
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
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
      throw new AhpError(
        'invalidParams',
        `session/history: limit must be between 1 and ${String(MAX_HISTORY_LIMIT)}`,
        { details: { member: 'limit' } },
      );
    }
    const hosted = this.#sessions.get(sessionId);
    let branch;
    let toCanonical = (tool: string): string => tool;
    if (hosted !== undefined) {
      branch = hosted.runtime.session.sessionManager.getBranch();
      toCanonical = hosted.toCanonical;
    } else {
      const file = SessionManager.findById(cwd, sessionId);
      branch = file === undefined ? [] : SessionManager.open(file).getBranch();
      const { tools } = this.#options;
      if (tools.kind === 'core') {
        const names = new ToolNameMap(tools.profile);
        toCanonical = (tool) => names.toCanonical(tool);
      }
    }
    return historyWindow(projectHistory(branch, toCanonical), start, limit);
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
    if (input.attachments.length === 0) {
      return { input, sections: '', images: [] };
    }
    const { tools } = this.#options;
    if (tools.kind !== 'core') {
      throw new AhpError('invalidParams', 'attachments need the Core tool backend', {
        details: { sessionId },
      });
    }
    const io = tools.ioFor(sessionId);
    return prepareInput(input, {
      readBlob: (blob) => io.readBlob(blob),
      pdf: (path, pages) => io.pdf(path, pages),
    });
  }

  #checkIdle(sessionId: string, hosted: HostedSession): void {
    const running = hosted.projector.activeTurnId;
    if (running !== undefined) {
      throw new AhpError('sessionBusy', `session ${sessionId} is running turn ${running}`, {
        retryable: true,
        details: { sessionId, turnId: running },
      });
    }
  }

  #opened(sessionId: string): SessionOpened {
    return { sessionId, restoredMessages: this.#get(sessionId).runtime.session.messages.length };
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
  ): Promise<SessionOpened> {
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
    const factory: CreateAgentSessionRuntimeFactory = async (target) => {
      const io =
        tools.kind === 'core' ? tools.ioFor(target.sessionManager.getSessionId()) : undefined;
      // Which command tools the session gets depends on the shells Core found (T17).
      const sessionTools =
        tools.kind === 'core' && io !== undefined
          ? scheduled(
              toolOptions(io, tools.profile, await shellsFor(io, this.#options.log)),
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
      const settingsManager = SettingsManager.create(target.cwd, target.agentDir, {
        projectTrusted: false,
      });
      // Recoverable model errors are retried by Pi's agent loop, which reports each retry
      // (`turn/retrying`) and keeps the failed attempt out of the context; the provider SDK
      // would retry rate limits and overloads silently (architecture section 6.15).
      settingsManager.applyOverrides({ retry: { provider: { maxRetries: 0 } } });
      const services = await createAgentSessionServices({
        cwd: target.cwd,
        agentDir: target.agentDir,
        modelRuntime: workspace.modelRuntime,
        settingsManager,
        resourceLoaderReloadOptions: trust.reloadOptions,
        resourceLoaderOptions: {
          // PiArc assembles project context itself (T22).
          noContextFiles: true,
          extensionFactories: [createMcpExtension(), ...budget],
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
    const projector = new Projector(sink, toCanonical);
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
      queue,
      batches,
      toCanonical,
      unsubscribe: () => undefined,
      prompts: new Map(),
      inputs: new Map(),
      preparing: new Map(),
      delivering,
      closed: false,
    };
    hosted.unsubscribe = session.subscribe((event) => {
      this.#onEvent(sessionId, hosted, event);
    });
    this.#sessions.set(sessionId, hosted);
    // A turn the previous process left unfinished (it crashed or was killed) is closed like an
    // interrupted one; a conversation that ends with a response stays as it is.
    const repair = repairInterruptedTurn(session);
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
    log(
      `opened in ${cwd} (trusted: ${String(trust?.trusted() ?? false)}, model: ${session.model?.provider ?? '-'}/${session.model?.id ?? '-'})`,
    );
    return { sessionId, restoredMessages: session.messages.length };
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
    projector.handle(event);
    if (event.type === 'agent_settled') {
      queue.settle();
      hosted.delivering.length = 0;
    }
  }

  /**
   * A user message starts: when it is an input PiArc gave Pi with mentions or attachments, the
   * record of what the user wrote goes into the session file just before the message (Pi
   * persists the message at its end) and into the live projection.
   */
  #recordInput(hosted: HostedSession, text: string): void {
    const index = hosted.delivering.findIndex((prepared) => composedText(prepared) === text);
    if (index === -1) {
      return;
    }
    const [prepared] = hosted.delivering.splice(index, 1);
    const record = prepared === undefined ? undefined : inputRecord(prepared);
    if (record === undefined) {
      return;
    }
    hosted.runtime.session.sessionManager.appendCustomEntry(INPUT_ENTRY, record);
    hosted.projector.useInput(record);
  }

  async #run(sessionId: string, hosted: HostedSession, turnId: string, job: Job): Promise<void> {
    let next: { readonly turnId: string; readonly job: Job } | undefined = { turnId, job };
    while (next !== undefined) {
      if (hosted.closed || hosted.projector.activeTurnId !== next.turnId) {
        return; // aborted or closed before it started
      }
      try {
        const { session } = hosted.runtime;
        if (next.job.kind === 'compact') {
          await session.compact();
        } else {
          const { prepared } = next.job;
          hosted.delivering.push(prepared);
          await session.prompt(
            composedText(prepared),
            prepared.images.length === 0 ? undefined : { images: [...prepared.images] },
          );
        }
        hosted.projector.finishTurn(next.turnId, 'completed');
      } catch (error) {
        this.#options.log(
          `[session ${sessionId}] ${next.job.kind} failed: ${describeError(error)}`,
        );
        hosted.projector.finishTurn(next.turnId, 'failed', describeError(error));
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

/** The canonical tools with their executions held by `batches`. */
function scheduled(
  options: ReturnType<typeof toolOptions>,
  batches: ToolBatches,
): ReturnType<typeof toolOptions> {
  return {
    ...options,
    customTools: options.customTools.map((tool: ToolDefinition) => batches.wrap(tool)),
  };
}

function checkSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) {
    throw new AhpError(
      'invalidParams',
      'sessionId must be 1 to 128 letters, digits, ".", "_" or "-"',
      { details: { member: 'sessionId' } },
    );
  }
}

function stopped(
  sessionId: string,
  turnId: string | undefined,
  returned: readonly QueueItem[],
): SessionStopped {
  return {
    sessionId,
    ...(turnId === undefined ? {} : { interruptedTurnId: turnId }),
    ...(returned.length === 0 ? {} : { returnedQueue: [...returned] }),
  };
}

/**
 * The shells for a session's command tools. When Core cannot say (the request failed), the
 * platform's usual answer: bash everywhere but Windows, PowerShell on Windows only.
 */
async function shellsFor(io: CoreIo, log: (line: string) => void): Promise<Shells> {
  try {
    return await io.shells();
  } catch (error) {
    log(
      `[session ${io.sessionId}] exec/shells failed, assuming the platform's shells: ${String(error)}`,
    );
    const windows = process.platform === 'win32';
    return { bash: !windows, powershell: windows };
  }
}
