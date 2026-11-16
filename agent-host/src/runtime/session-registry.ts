// The sessions hosted by this process: sessionId → Pi AgentSessionRuntime (architecture
// section 5.3). Every session has its own cwd, its own file-backed SessionManager under
// `<agentDir>/sessions/` and its own resource loader; they share the workspace's ModelRuntime.
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
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from '@earendil-works/pi-coding-agent';
import type { ModelRef, PromptAccepted, SessionOpened, SessionStopped } from '@piarc/protocol';

import { takeOverProjectTrust, type TrustTakeover } from '../harness/project-trust.js';
import { AhpError, describeError } from '../protocol/errors.js';
import { ToolNameMap, toolOptions, type CoreIo, type ToolProfile } from '../tools/index.js';
import { Projector, type ProjectionSink } from './projector.js';
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
}

interface HostedSession {
  readonly runtime: AgentSessionRuntime;
  readonly projector: Projector;
  readonly unsubscribe: () => void;
  /** Idempotency keys of accepted prompts → their turn ids. */
  readonly prompts: Map<string, string>;
}

export class SessionRegistry {
  readonly #options: RegistryOptions;
  readonly #sessions = new Map<string, HostedSession>();

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

  /** Creates a session in `cwd`. */
  async create(cwd: string, model: ModelRef | undefined): Promise<SessionOpened> {
    return this.#open(cwd, SessionManager.create(cwd), model);
  }

  /** Reopens a session by id; one that never stored a message starts empty under that id. */
  async resume(sessionId: string, cwd: string): Promise<SessionOpened> {
    if (this.#sessions.has(sessionId)) {
      return { sessionId, restoredMessages: this.#get(sessionId).runtime.session.messages.length };
    }
    const file = SessionManager.findById(cwd, sessionId);
    const manager =
      file === undefined
        ? SessionManager.create(cwd, undefined, { id: sessionId })
        : SessionManager.open(file);
    return this.#open(cwd, manager, undefined);
  }

  /** Accepts a prompt; the turn runs after the response is queued. */
  prompt(sessionId: string, requestId: string, text: string): PromptAccepted {
    const hosted = this.#get(sessionId);
    const known = hosted.prompts.get(requestId);
    if (known !== undefined) {
      return { turnId: known };
    }
    const running = hosted.projector.activeTurnId;
    if (running !== undefined) {
      throw new AhpError('sessionBusy', `session ${sessionId} is running turn ${running}`, {
        retryable: true,
        details: { sessionId, turnId: running },
      });
    }
    const turnId = `turn-${randomUUID()}`;
    hosted.prompts.set(requestId, turnId);
    hosted.projector.beginTurn(turnId);
    // Start on the next macrotask: the handler's response is queued first, so Core learns the
    // turn id before any of the turn's notifications.
    setImmediate(() => {
      void this.#run(sessionId, hosted, turnId, text);
    });
    return { turnId };
  }

  /** Interrupts the running turn and waits until the session is idle. */
  async abort(sessionId: string): Promise<SessionStopped> {
    const hosted = this.#get(sessionId);
    const turnId = hosted.projector.activeTurnId;
    await hosted.runtime.session.abort();
    if (turnId !== undefined) {
      hosted.projector.finishTurn(turnId, 'interrupted');
    }
    return stopped(sessionId, turnId);
  }

  /** Aborts, shuts the session down (extensions get `session_shutdown`) and forgets it. */
  async close(sessionId: string): Promise<SessionStopped> {
    const hosted = this.#get(sessionId);
    const turnId = hosted.projector.activeTurnId;
    this.#sessions.delete(sessionId);
    try {
      await hosted.runtime.dispose();
    } finally {
      if (turnId !== undefined) {
        hosted.projector.finishTurn(turnId, 'interrupted');
      }
      hosted.unsubscribe();
    }
    return stopped(sessionId, turnId);
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
    const factory: CreateAgentSessionRuntimeFactory = async (target) => {
      const sessionTools =
        tools.kind === 'core'
          ? toolOptions(tools.ioFor(target.sessionManager.getSessionId()), tools.profile)
          : { tools: PI_NATIVE_TOOLS };
      // Project-level Pi resources (`.pi/settings.json`, `.pi/mcp.json`, extensions) load
      // only for directories Core trusts: nothing project-level is read until the takeover
      // hook has Core's answer.
      trust = takeOverProjectTrust(target.cwd, this.#options.isTrusted);
      const services = await createAgentSessionServices({
        cwd: target.cwd,
        agentDir: target.agentDir,
        modelRuntime: workspace.modelRuntime,
        settingsManager: SettingsManager.create(target.cwd, target.agentDir, {
          projectTrusted: false,
        }),
        resourceLoaderReloadOptions: trust.reloadOptions,
        resourceLoaderOptions: {
          // PiArc assembles project context itself (T22).
          noContextFiles: true,
          extensionFactories: [createMcpExtension()],
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
    const projector = new Projector(
      this.#options.sinkFor(sessionId),
      names === undefined ? undefined : (tool) => names.toCanonical(tool),
    );
    const unsubscribe = session.subscribe((event) => {
      projector.handle(event);
    });
    this.#sessions.set(sessionId, { runtime, projector, unsubscribe, prompts: new Map() });
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

  async #run(
    sessionId: string,
    hosted: HostedSession,
    turnId: string,
    text: string,
  ): Promise<void> {
    if (hosted.projector.activeTurnId !== turnId) {
      return; // aborted or closed before it started
    }
    try {
      await hosted.runtime.session.prompt(text);
      hosted.projector.finishTurn(turnId, 'completed');
    } catch (error) {
      this.#options.log(`[session ${sessionId}] prompt failed: ${describeError(error)}`);
      hosted.projector.finishTurn(turnId, 'failed', describeError(error));
    }
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

function stopped(sessionId: string, turnId: string | undefined): SessionStopped {
  return { sessionId, ...(turnId === undefined ? {} : { interruptedTurnId: turnId }) };
}
