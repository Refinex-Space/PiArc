// The Agent Host program, independent of the real process: wires the AHP connection, the
// handshake, the request handlers and the orderly shutdown. start.ts runs it on stdio.
import path from 'node:path';

import { PROTOCOL_VERSION, isPermissionMode } from '@piarc/protocol';
import type { HostShutdownResult, HostStatus } from '@piarc/protocol';

import { credentialStatus, saveCredential } from './providers/settings.js';
import { askCoreTrust } from './harness/project-trust.js';
import { Connection, type FrameSource } from './protocol/connection.js';
import { AhpError, describeError } from './protocol/errors.js';
import { OutboundQueue, type FrameSink } from './protocol/outbound.js';
import {
  commitMessageParams,
  modelField,
  optionalCount,
  optionalString,
  paramsObject,
  parseWelcome,
  reviewParams,
  stringField,
  stringList,
  inputFields,
  textField,
} from './protocol/params.js';
import { blobReader } from './runtime/blobs.js';
import { commandOf, type UserInput } from './runtime/input.js';
import { CoreCredentialStore } from './runtime/credentials.js';
import { isObject } from './runtime/items.js';
import { SessionRegistry, type ToolBackend } from './runtime/session-registry.js';
import {
  registerTestOAuthProvider,
  testLogin,
  type TestOAuthProviderConfig,
} from './runtime/test-oauth-provider.js';
import { agentDirOf, openWorkspace } from './runtime/workspace.js';
import { parsePreferences } from './providers/preferences.js';
import { discoverModels, testProvider } from './providers/checks.js';
import { installationId, Logins } from './providers/login.js';
import { CoreIo, DEFAULT_PROFILE, ExecOutputRouter, type ToolProfile } from './tools/index.js';
import { McpPool, type PoolClock } from './mcp/pool.js';
import { signInToServer } from './mcp/sign-in.js';

/** Capabilities this Agent Host announces in `host/hello`. The models capability includes session selection and provider settings. */
export const HOST_CAPABILITIES: readonly string[] = [
  'models',
  'memory',
  'hooks',
  'planMode',
  'todo',
  'ask',
  'context',
  'checkpoints',
  'webFetch',
  'webSearch',
  'browser',
  'login',
  'subagents',
  'backgroundTasks',
  'terminalTasks',
  'mcpPool',
  'skills',
  'plugins',
  'autoMemory',
  'sideChat',
  'commitMessage',
];

/** Exit codes, for Core's log and restart decisions. */
export const EXIT = {
  ok: 0,
  handshakeFailed: 2,
  protocolMismatch: 3,
  outboundOverflow: 70,
} as const;

export interface HostOptions {
  /** PiArc's data directory; Pi's agent directory is its `pi/` child. */
  readonly dataDir: string;
  /** Pi SDK version, announced in `host/hello`. */
  readonly piVersion: string;
  /** Timeout of requests to Core that do not wait for a person. */
  readonly bridgeTimeoutMs?: number;
  /** The Tool Profile of every session; the default profile when absent. */
  readonly toolProfile?: ToolProfile;
  /** Give sessions Pi's own tools with local I/O instead (behavior comparison test only). */
  readonly piNativeTools?: boolean;
  /** Register the OAuth test provider (credential tests only). */
  readonly testOAuthProvider?: TestOAuthProviderConfig;
  /** Receives every raw Pi session event (recording golden inputs, tests only). */
  readonly recordEvents?: (sessionId: string, event: unknown) => void;
  /** Leaves the session notification with this `seq` out of stdout (gap tests only). */
  readonly dropSeq?: number;
  /** The clock of the MCP pool's idle and retry timers (tests). */
  readonly mcpClock?: PoolClock;
  /** Writes one log line to stderr. */
  readonly log: (line: string) => void;
  /** Ends the process once stdout is flushed. */
  readonly exit: (code: number) => void;
}

export interface RunningHost {
  /** Closes every session, flushes stdout and exits with `code`. Idempotent. */
  shutdown(reason: string, code: number): Promise<void>;
}

/** Starts the Agent Host on `input`/`output` and performs the handshake. */
export function runHost(input: FrameSource, output: FrameSink, options: HostOptions): RunningHost {
  const { log } = options;
  let shuttingDown: Promise<void> | undefined;
  let registry: SessionRegistry | undefined;
  let sideChatEnabled = false;
  let commitMessageEnabled = false;
  // The workspace's MCP pool (T36), when Core enabled `mcpPool`.
  let mcp: McpPool | undefined;
  // Core may send its first request right after `core/welcome`, while the workspace is still
  // opening: session requests wait for it.
  const ready = Promise.withResolvers<SessionRegistry>();
  ready.promise.catch(() => undefined);

  const outbound = new OutboundQueue(output, {
    onOverflow: (stats) => {
      log(
        `outbound queue overflow (${String(stats.queuedBytes)} bytes waiting); Core stopped reading, exiting`,
      );
      options.exit(EXIT.outboundOverflow);
    },
    onOversize: (method, sessionId, bytes) => {
      log(`[session ${sessionId}] dropped a ${method} notification of ${String(bytes)} bytes`);
    },
    ...(options.dropSeq === undefined ? {} : { dropSeq: options.dropSeq }),
  });
  const connection = new Connection(outbound, {
    log,
    ...(options.bridgeTimeoutMs === undefined ? {} : { bridgeTimeoutMs: options.bridgeTimeoutMs }),
  });

  // Credentials live in Core's vault; Core pushes changes made elsewhere.
  const credentials = new CoreCredentialStore({ core: connection.bridge, log });
  connection.onNotification('secrets/changed', (params) => credentials.applyChange(params));

  // Tools delegate their I/O to Core; command output comes back as `exec/output`.
  const execOutput = new ExecOutputRouter();
  connection.onNotification('policy/pending', (params) => {
    if (
      !isObject(params) ||
      typeof params.sessionId !== 'string' ||
      typeof params.toolCallId !== 'string'
    )
      return false;
    const { sessionId, toolCallId } = params;
    if (!connection.bridge.awaitingApproval(sessionId, toolCallId)) {
      // A late acknowledgement cannot revive an expired call or leave a card on screen.
      void connection.bridge
        .request('policy/cancel', { sessionId, toolCallId })
        .catch((error: unknown) => {
          log(`cancelling a stale approval failed: ${describeError(error)}`);
        });
    }
    return true;
  });
  connection.onNotification('exec/output', (params) => execOutput.deliver(params));
  const readBlob = blobReader(options.dataDir);
  const tools: ToolBackend =
    options.piNativeTools === true
      ? { kind: 'pi-native' }
      : {
          kind: 'core',
          bridge: connection.bridge,
          profile: options.toolProfile ?? DEFAULT_PROFILE,
          ioFor: (sessionId) =>
            new CoreIo({
              bridge: connection.bridge,
              sessionId,
              execOutput,
              readBlob,
              turn: () => registry?.activeTurn(sessionId),
            }),
        };

  const shutdown = (reason: string, code: number): Promise<void> => {
    shuttingDown ??= (async () => {
      log(`shutting down: ${reason}`);
      // A credential write in progress may carry a rotated refresh token: let it reach Core.
      await credentials.flush();
      connection.bridge.close(`the Agent Host is shutting down (${reason})`);
      await registry?.closeAll();
      // Stdio servers get the specification's shutdown; Core ends what is left with the
      // Agent Host's process group or Job Object.
      await mcp?.close();
      await outbound.flushed();
      options.exit(code);
    })();
    return shuttingDown;
  };

  const sessions = async (method: string): Promise<SessionRegistry> => {
    if (shuttingDown !== undefined) {
      throw new AhpError('shuttingDown', `${method} refused: the Agent Host is shutting down`);
    }
    return ready.promise;
  };

  connection.handle('host/ping', (params): Promise<HostStatus> => {
    const sentAt = paramsObject('host/ping', params).sentAt;
    const stats = outbound.stats();
    return Promise.resolve({
      sentAt: typeof sentAt === 'number' ? sentAt : 0,
      rssBytes: process.memoryUsage.rss(),
      outboundQueuedFrames: stats.queuedFrames,
      outboundQueuedBytes: stats.queuedBytes,
      outboundPeakBytes: stats.peakBytes,
      sessions: registry?.size ?? 0,
    });
  });
  connection.handle('host/shutdown', async (params): Promise<HostShutdownResult> => {
    const reason = paramsObject('host/shutdown', params).reason;
    const closedSessions = (await registry?.closeAll()) ?? 0;
    await credentials.flush();
    // Exit after the response is on its way.
    setImmediate(() => {
      void shutdown(
        `host/shutdown (${typeof reason === 'string' ? reason : 'no reason'})`,
        EXIT.ok,
      );
    });
    return { closedSessions };
  });
  connection.handle('models/list', async (params) => {
    const method = 'models/list';
    return (await sessions(method)).models(
      optionalString(method, paramsObject(method, params), 'sessionId'),
    );
  });
  connection.handle('models/reload', async (params) => {
    const method = 'models/reload';
    const { allowNetwork, preferences } = paramsObject(method, params);
    if (typeof allowNetwork !== 'boolean')
      throw new AhpError('invalidParams', 'Expected allowNetwork');
    const registry = await sessions(method);
    if (preferences != null) {
      const parsed = parsePreferences(preferences);
      // Providers the user turned off look unconfigured to Pi (ADR-0083).
      credentials.hide(parsed.disabledProviders ?? []);
      await registry.setPreferences(parsed);
    }
    await credentials.synchronize();
    await registry.workspace.reload(allowNetwork);
    return {};
  });
  connection.handle('models/credential', async (params) => {
    const method = 'models/credential';
    const fields = paramsObject(method, params);
    return saveCredential(
      (await sessions(method)).workspace.modelRuntime,
      credentials,
      stringField(method, fields, 'provider'),
      fields.credential,
      fields.keepKey === true,
    );
  });
  // Sign-in (T29): one `Logins` per Host, made when the workspace is ready.
  let logins: Logins | undefined;
  const loginsFor = async (method: string): Promise<Logins> => {
    const registry = await sessions(method);
    logins ??= new Logins(registry.workspace.modelRuntime, connection.bridge, log, {
      deviceId: () => installationId(path.join(options.dataDir, 'agent-host', 'installation-id')),
      credentials,
    });
    return logins;
  };
  connection.handle('models/login/start', async (params) => {
    const method = 'models/login/start';
    const fields = paramsObject(method, params);
    return (await loginsFor(method)).start(
      stringField(method, fields, 'loginId'),
      stringField(method, fields, 'provider'),
    );
  });
  connection.handle('models/login/cancel', async (params) => {
    const method = 'models/login/cancel';
    return (await loginsFor(method)).cancel(
      stringField(method, paramsObject(method, params), 'loginId'),
    );
  });
  connection.handle('models/logout', async (params) => {
    const method = 'models/logout';
    return (await loginsFor(method)).logout(
      stringField(method, paramsObject(method, params), 'provider'),
    );
  });
  // Checks of the settings window (ADR-0083).
  connection.handle('models/test', async (params) => {
    const method = 'models/test';
    const fields = paramsObject(method, params);
    const registry = await sessions(method);
    const model = optionalString(method, fields, 'model');
    return testProvider(registry.workspace.modelRuntime, {
      provider: stringField(method, fields, 'provider'),
      ...(model === undefined ? {} : { model }),
    });
  });
  connection.handle('models/discover', async (params) => {
    const method = 'models/discover';
    const fields = paramsObject(method, params);
    await sessions(method);
    const key = optionalString(method, fields, 'key');
    const storedKeyOf = optionalString(method, fields, 'storedKeyOf');
    return discoverModels(
      {
        api: stringField(method, fields, 'api'),
        baseUrl: stringField(method, fields, 'baseUrl'),
        ...(key === undefined ? {} : { key }),
        ...(storedKeyOf === undefined ? {} : { storedKeyOf }),
      },
      credentials,
    );
  });
  connection.handle('models/credentialStatus', async (params) => {
    const method = 'models/credentialStatus';
    await sessions(method);
    return credentialStatus(
      credentials,
      stringField(method, paramsObject(method, params), 'provider'),
    );
  });
  for (const method of ['session/previewModelSwitch', 'session/setModel'] as const) {
    connection.handle(method, async (params) => {
      const fields = paramsObject(method, params);
      const model = modelField(method, fields);
      if (!model) throw new AhpError('invalidParams', 'Select a model');
      const id = stringField(method, fields, 'sessionId');
      const registry = await sessions(method);
      return method === 'session/previewModelSwitch'
        ? registry.previewModelSwitch(id, model)
        : registry.setModel(id, model, optionalString(method, fields, 'effort'));
    });
  }
  connection.handle('session/setEffort', async (params) => {
    const method = 'session/setEffort';
    const fields = paramsObject(method, params);
    return (await sessions(method)).setEffort(
      stringField(method, fields, 'sessionId'),
      stringField(method, fields, 'effort'),
    );
  });
  connection.handle('session/create', async (params) => {
    const fields = paramsObject('session/create', params);
    const cwd = stringField('session/create', fields, 'cwd');
    const sessionId = optionalString('session/create', fields, 'sessionId');
    // The settings' defaults (T31, Claude Code's `model` and `effortLevel`).
    const defaults = {
      model: optionalString('session/create', fields, 'defaultModel'),
      effort: optionalString('session/create', fields, 'defaultEffort'),
    };
    return (await sessions('session/create')).create(
      cwd,
      modelField('session/create', fields),
      sessionId,
      defaults,
    );
  });
  connection.handle('session/resume', async (params) => {
    const fields = paramsObject('session/resume', params);
    const sessionId = stringField('session/resume', fields, 'sessionId');
    const cwd = stringField('session/resume', fields, 'cwd');
    const lastSeq = optionalCount('session/resume', fields, 'lastSeq');
    const registry = await sessions('session/resume');
    if (lastSeq !== undefined) {
      outbound.continueSeq(sessionId, lastSeq);
    }
    return registry.resume(sessionId, cwd);
  });
  connection.handle('session/fork', async (params) => {
    const fields = paramsObject('session/fork', params);
    return (await sessions('session/fork')).fork(
      stringField('session/fork', fields, 'sessionId'),
      stringField('session/fork', fields, 'cwd'),
      optionalString('session/fork', fields, 'entryId'),
      optionalString('session/fork', fields, 'beforeTurn'),
    );
  });
  connection.handle('session/rewind', async (params) => {
    const method = 'session/rewind';
    const fields = paramsObject(method, params);
    const mode = fields.mode;
    if (mode !== 'branch' && mode !== 'summarize') {
      throw new AhpError('invalidParams', 'session/rewind: mode must be branch or summarize', {
        details: { member: 'mode' },
      });
    }
    return (await sessions(method)).rewind(
      stringField(method, fields, 'sessionId'),
      stringField(method, fields, 'turnId'),
      mode,
    );
  });
  connection.handle('session/switchBranch', async (params) => {
    const method = 'session/switchBranch';
    const fields = paramsObject(method, params);
    return (await sessions(method)).switchBranch(
      stringField(method, fields, 'sessionId'),
      stringField(method, fields, 'entryId'),
    );
  });
  connection.handle('session/prompt', async (params) => {
    const fields = paramsObject('session/prompt', params);
    const input = inputFields('session/prompt', fields);
    const sessionId = stringField('session/prompt', fields, 'sessionId');
    const requestId = stringField('session/prompt', fields, 'requestId');
    const hookContext = optionalString('session/prompt', fields, 'hookContext');
    return (await sessions('session/prompt')).prompt(
      sessionId,
      requestId,
      withCommand('session/prompt', input, fields),
      hookContext,
    );
  });
  connection.handle('session/setPermissionMode', async (params) => {
    const method = 'session/setPermissionMode';
    const fields = paramsObject(method, params);
    const mode = fields.mode;
    if (!isPermissionMode(mode)) {
      throw new AhpError('invalidParams', 'Unsupported permission mode');
    }
    (await sessions(method)).setPermissionMode(stringField(method, fields, 'sessionId'), mode);
    return {};
  });
  connection.handle('session/compact', async (params) => {
    const fields = paramsObject('session/compact', params);
    const sessionId = stringField('session/compact', fields, 'sessionId');
    const requestId = stringField('session/compact', fields, 'requestId');
    const instructions = optionalString('session/compact', fields, 'instructions');
    return (await sessions('session/compact')).compact(sessionId, requestId, instructions);
  });
  connection.handle('session/sideChatAsk', async (params) => {
    const method = 'session/sideChatAsk';
    const fields = paramsObject(method, params);
    const registry = await sessions(method);
    if (!sideChatEnabled) throw new AhpError('methodNotFound', 'Core did not enable sideChat');
    return registry.askSideChat(
      stringField(method, fields, 'sessionId'),
      stringField(method, fields, 'panelId'),
      stringField(method, fields, 'text'),
    );
  });
  connection.handle('session/commitMessage', async (params) => {
    const method = 'session/commitMessage';
    const request = commitMessageParams(params);
    const registry = await sessions(method);
    if (!commitMessageEnabled) {
      throw new AhpError('methodNotFound', 'Core did not enable commitMessage');
    }
    return registry.commitMessage(request.sessionId, request);
  });
  connection.handle('session/sideChatControl', async (params) => {
    const method = 'session/sideChatControl';
    const fields = paramsObject(method, params);
    if (typeof fields.close !== 'boolean')
      throw new AhpError('invalidParams', 'Expected a boolean close flag');
    const registry = await sessions(method);
    if (!sideChatEnabled) throw new AhpError('methodNotFound', 'Core did not enable sideChat');
    registry.controlSideChat(
      stringField(method, fields, 'sessionId'),
      stringField(method, fields, 'panelId'),
      fields.close,
    );
    return {};
  });
  connection.handle('session/getContextUsage', async (params) => {
    const method = 'session/getContextUsage';
    const sessionId = stringField(method, paramsObject(method, params), 'sessionId');
    return (await sessions(method)).harness(sessionId).contextUsage();
  });
  connection.handle('session/remind', async (params) => {
    const method = 'session/remind';
    const fields = paramsObject(method, params);
    const sessionId = stringField(method, fields, 'sessionId');
    const type = fields.type;
    if (
      type !== 'backgroundTask' &&
      type !== 'monitorOutput' &&
      (type !== 'hookContext' || fields.wake === true)
    ) {
      throw new AhpError(
        'invalidParams',
        `${method}: expected backgroundTask, monitorOutput, or hookContext without wake`,
        {
          details: { member: 'type' },
        },
      );
    }
    const key = optionalString(method, fields, 'key');
    return (await sessions(method)).remind(sessionId, {
      type,
      source: stringField(method, fields, 'source'),
      text: stringField(method, fields, 'text'),
      ...(key === undefined ? {} : { key }),
      wake: fields.wake === true,
    });
  });
  for (const [method, kind] of [
    ['session/steer', 'steer'],
    ['session/followUp', 'followUp'],
  ] as const) {
    connection.handle(method, async (params) => {
      const fields = paramsObject(method, params);
      const input = inputFields(method, fields);
      const sessionId = stringField(method, fields, 'sessionId');
      const requestId = stringField(method, fields, 'requestId');
      const hookContext = optionalString(method, fields, 'hookContext');
      return (await sessions(method)).input(
        sessionId,
        requestId,
        withCommand(method, input, fields),
        kind,
        hookContext,
      );
    });
  }
  connection.handle('session/queue/edit', async (params) => {
    const fields = paramsObject('session/queue/edit', params);
    return (await sessions('session/queue/edit')).editQueue(
      stringField('session/queue/edit', fields, 'sessionId'),
      stringField('session/queue/edit', fields, 'itemId'),
      textField('session/queue/edit', fields),
    );
  });
  connection.handle('session/queue/delete', async (params) => {
    const fields = paramsObject('session/queue/delete', params);
    return (await sessions('session/queue/delete')).deleteQueued(
      stringField('session/queue/delete', fields, 'sessionId'),
      stringField('session/queue/delete', fields, 'itemId'),
    );
  });
  connection.handle('session/queue/reorder', async (params) => {
    const fields = paramsObject('session/queue/reorder', params);
    return (await sessions('session/queue/reorder')).reorderQueue(
      stringField('session/queue/reorder', fields, 'sessionId'),
      stringList('session/queue/reorder', fields, 'itemIds'),
    );
  });
  connection.handle('session/getEntries', async (params) => {
    const fields = paramsObject('session/getEntries', params);
    const sessionId = stringField('session/getEntries', fields, 'sessionId');
    const since = optionalCount('session/getEntries', fields, 'since') ?? 0;
    await sessions('session/getEntries');
    return outbound.entriesSince(sessionId, since);
  });
  connection.handle('session/history', async (params) => {
    const fields = paramsObject('session/history', params);
    return (await sessions('session/history')).history(
      stringField('session/history', fields, 'sessionId'),
      stringField('session/history', fields, 'cwd'),
      optionalCount('session/history', fields, 'start'),
      optionalCount('session/history', fields, 'limit') ?? 0,
    );
  });
  connection.handle('session/abort', async (params) => {
    const sessionId = stringField(
      'session/abort',
      paramsObject('session/abort', params),
      'sessionId',
    );
    return (await sessions('session/abort')).abort(sessionId);
  });
  connection.handle('resources/listAgents', async (params) => {
    const method = 'resources/listAgents';
    const registry = await sessions(method);
    const cwd = optionalString(method, paramsObject(method, params), 'cwd');
    return registry.subagents.list(cwd ?? registry.workspace.root);
  });
  connection.handle('resources/listSkills', async (params) => {
    const method = 'resources/listSkills';
    const registry = await sessions(method);
    const cwd = optionalString(method, paramsObject(method, params), 'cwd');
    const catalog = await registry.resources(cwd ?? registry.workspace.root);
    return {
      skills: catalog.skills,
      ...(catalog.issues == null ? {} : { issues: catalog.issues }),
    };
  });
  connection.handle('resources/listCommands', async (params) => {
    const method = 'resources/listCommands';
    const registry = await sessions(method);
    const cwd = optionalString(method, paramsObject(method, params), 'cwd');
    const catalog = await registry.resources(cwd ?? registry.workspace.root);
    return {
      commands: catalog.commands,
      outputStyles: catalog.outputStyles,
      outputStyle: catalog.outputStyle,
      ...(catalog.issues == null ? {} : { issues: catalog.issues }),
    };
  });
  connection.handle('hooks/prompt', async (params) => {
    const method = 'hooks/prompt';
    const fields = paramsObject(method, params);
    const timeoutMs = fields.timeoutMs;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new AhpError('invalidParams', `${method}: timeoutMs must be a positive number`, {
        details: { member: 'timeoutMs' },
      });
    }
    const model = optionalString(method, fields, 'model');
    return (await sessions(method)).judgeHook(stringField(method, fields, 'sessionId'), {
      prompt: stringField(method, fields, 'prompt'),
      timeoutMs,
      ...(model === undefined ? {} : { model }),
    });
  });
  connection.handle('policy/review', async (params) => {
    // Auto mode (T46): Core asks while the call's `policy/evaluate` waits; requests are
    // handled concurrently, so reviews of parallel subagents do not wait for each other.
    const parsed = reviewParams(params);
    return (await sessions('policy/review')).reviewCall(parsed);
  });
  connection.handle('resources/reload', async () => {
    (await sessions('resources/reload')).reloadResources();
    return {};
  });
  connection.handle('subagent/stop', async (params) => {
    const method = 'subagent/stop';
    const registry = await sessions(method);
    return {
      stopped: registry.subagents.stop(
        stringField(method, paramsObject(method, params), 'sessionId'),
      ),
    };
  });
  const pool = async (method: string): Promise<McpPool> => {
    await sessions(method);
    if (mcp === undefined) {
      throw new AhpError('methodNotFound', `${method}: Core did not enable mcpPool`);
    }
    return mcp;
  };
  connection.handle('hooks/mcpTool', async (params) => {
    // An `mcp_tool` hook's call (T41): Core runs the hook and reads the text; the tool runs on
    // the workspace's pool like a session's call.
    const method = 'hooks/mcpTool';
    const fields = paramsObject(method, params);
    const timeoutMs = fields.timeoutMs;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new AhpError('invalidParams', `${method}: timeoutMs must be a positive number`, {
        details: { member: 'timeoutMs' },
      });
    }
    const args = fields.arguments;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw new AhpError('invalidParams', `${method}: arguments must be an object`, {
        details: { member: 'arguments' },
      });
    }
    const servers = await pool(method);
    const signal = AbortSignal.timeout(timeoutMs);
    const result = await servers
      .call(
        `hook:${stringField(method, fields, 'sessionId')}`,
        stringField(method, fields, 'server'),
        stringField(method, fields, 'tool'),
        args as Record<string, unknown>,
        { signal },
      )
      .catch((error: unknown) => {
        // The MCP client reports its local abort before Core's hook timer on some runs.
        if (signal.aborted) throw new AhpError('timeout', 'MCP hook timed out');
        throw error;
      });
    const text = result.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    return { text, ...(result.isError === true ? { isError: true } : {}) };
  });
  connection.handle('mcp/status', async () => {
    const servers = await pool('mcp/status');
    await servers.refresh();
    return servers.status();
  });
  connection.handle('mcp/reconnect', async (params) => {
    const method = 'mcp/reconnect';
    const name = stringField(method, paramsObject(method, params), 'name');
    return (await pool(method)).reconnect(name);
  });
  connection.handle('mcp/setEnabled', async (params) => {
    const method = 'mcp/setEnabled';
    const name = stringField(method, paramsObject(method, params), 'name');
    return (await pool(method)).setEnabled(name);
  });
  connection.handle('mcp/login', async (params) => {
    const method = 'mcp/login';
    const fields = paramsObject(method, params);
    return signInToServer(
      await pool(method),
      connection.bridge,
      stringField(method, fields, 'name'),
      stringField(method, fields, 'loginId'),
    );
  });
  connection.handle('session/close', async (params) => {
    const sessionId = stringField(
      'session/close',
      paramsObject('session/close', params),
      'sessionId',
    );
    return (await sessions('session/close')).close(sessionId);
  });

  connection.attach(input, () => {
    void shutdown('Core closed stdin', EXIT.ok);
  });

  void (async () => {
    let welcome;
    try {
      welcome = await connection.bridge.requestTyped(
        'host/hello',
        { protocol: PROTOCOL_VERSION, pi: options.piVersion, capabilities: HOST_CAPABILITIES },
        parseWelcome,
      );
    } catch (error) {
      const mismatch = error instanceof AhpError && error.kind === 'protocolVersionMismatch';
      log(`handshake failed: ${describeError(error)}`);
      ready.reject(error);
      await shutdown(
        mismatch ? 'Core speaks another AHP major version' : 'handshake failed',
        mismatch ? EXIT.protocolMismatch : EXIT.handshakeFailed,
      );
      return;
    }
    log(
      `connected: AHP ${welcome.protocol}, epoch ${String(welcome.connectionEpoch)}, workspace ${welcome.workspace}, enabled [${welcome.enabled.join(', ')}]`,
    );
    try {
      // A failed load is logged and retried by the first operation that needs credentials.
      await credentials.load();
      credentials.hide(welcome.modelPreferences?.disabledProviders ?? []);
      const workspace = await openWorkspace(
        welcome.workspace,
        agentDirOf(options.dataDir),
        credentials,
        welcome.allowModelNetwork === true,
      );
      sideChatEnabled = welcome.enabled.includes('sideChat');
      commitMessageEnabled = welcome.enabled.includes('commitMessage');
      if (welcome.modelPreferences != null) workspace.preferences.set(welcome.modelPreferences);
      if (options.testOAuthProvider !== undefined) {
        registerTestOAuthProvider(workspace.modelRuntime, options.testOAuthProvider);
        await testLogin(workspace.modelRuntime, options.testOAuthProvider, log);
      }
      if (welcome.enabled.includes('mcpPool') && tools.kind === 'core') {
        mcp = new McpPool({
          workspace: welcome.workspace,
          bridge: connection.bridge,
          log,
          notify: (status) => {
            outbound.sendMessage({ jsonrpc: '2.0', method: 'mcp/statusChanged', params: status });
          },
          ...(options.mcpClock === undefined ? {} : { clock: options.mcpClock }),
        });
      }
      registry = new SessionRegistry({
        workspace,
        tools,
        ...(mcp === undefined ? {} : { mcp }),
        ...(welcome.enabled.includes('memory') ? { memoryBridge: connection.bridge } : {}),
        ...(welcome.enabled.includes('hooks') ? { hooksBridge: connection.bridge } : {}),
        hostTools: {
          bridge: connection.bridge,
          planMode: welcome.enabled.includes('planMode'),
          todo: welcome.enabled.includes('todo'),
          ask: welcome.enabled.includes('ask'),
          context: welcome.enabled.includes('context'),
          checkpoints: welcome.enabled.includes('checkpoints'),
          webFetch: welcome.enabled.includes('webFetch'),
          webSearch: welcome.enabled.includes('webSearch'),
          browser: welcome.enabled.includes('browser'),
          subagents: welcome.enabled.includes('subagents'),
          backgroundTasks: welcome.enabled.includes('backgroundTasks'),
          skills: welcome.enabled.includes('skills'),
          plugins: welcome.enabled.includes('plugins'),
          autoMemory: welcome.enabled.includes('autoMemory'),
        },
        log,
        sinkFor: (sessionId) => ({
          event: (method, payload) => {
            outbound.sendSessionEvent(sessionId, method, payload);
          },
          delta: (method, mergeKey, payload, delta) => {
            outbound.sendDelta(sessionId, method, mergeKey, payload, delta);
          },
          replaceable: (method, key, payload) => {
            outbound.sendReplaceable(sessionId, method, key, payload);
          },
        }),
        isTrusted: (cwd) => askCoreTrust(connection.bridge, cwd, log),
        onClosed: (sessionId) => {
          outbound.forget(sessionId);
        },
        ...(options.recordEvents === undefined ? {} : { onPiEvent: options.recordEvents }),
      });
      ready.resolve(registry);
    } catch (error) {
      log(`workspace setup failed: ${describeError(error)}`);
      ready.reject(error);
      await shutdown('workspace setup failed', EXIT.handshakeFailed);
    }
  })();

  return { shutdown };
}

/** `input` with the slash command Core expanded into its text (T37), when the request has
 * one. */
function withCommand(method: string, input: UserInput, fields: Record<string, unknown>): UserInput {
  if (fields.command == null) return input;
  const command = commandOf(fields.command);
  if (command === undefined) {
    throw new AhpError('invalidParams', `${method}: command is not a slash command`, {
      details: { member: 'command' },
    });
  }
  return { ...input, command };
}
