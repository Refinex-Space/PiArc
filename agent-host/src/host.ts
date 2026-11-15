// The Agent Host program, independent of the real process: wires the AHP connection, the
// handshake, the request handlers and the orderly shutdown. main.ts runs it on stdio.
import { PROTOCOL_VERSION } from '@piarc/protocol';
import type { HostShutdownResult, HostStatus } from '@piarc/protocol';

import { Connection, type FrameSource } from './protocol/connection.js';
import { AhpError, describeError } from './protocol/errors.js';
import { OutboundQueue, type FrameSink } from './protocol/outbound.js';
import {
  modelField,
  paramsObject,
  parseTrust,
  parseWelcome,
  stringField,
} from './protocol/params.js';
import { SessionRegistry } from './runtime/session-registry.js';
import { agentDirOf, openWorkspace } from './runtime/workspace.js';

/** Capabilities this Agent Host announces in `host/hello`. None of the optional features exist yet. */
export const HOST_CAPABILITIES: readonly string[] = [];

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
  });
  const connection = new Connection(outbound, {
    log,
    ...(options.bridgeTimeoutMs === undefined ? {} : { bridgeTimeoutMs: options.bridgeTimeoutMs }),
  });

  const shutdown = (reason: string, code: number): Promise<void> => {
    shuttingDown ??= (async () => {
      log(`shutting down: ${reason}`);
      connection.bridge.close(`the Agent Host is shutting down (${reason})`);
      await registry?.closeAll();
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
    // Exit after the response is on its way.
    setImmediate(() => {
      void shutdown(
        `host/shutdown (${typeof reason === 'string' ? reason : 'no reason'})`,
        EXIT.ok,
      );
    });
    return { closedSessions };
  });
  connection.handle('session/create', async (params) => {
    const fields = paramsObject('session/create', params);
    const cwd = stringField('session/create', fields, 'cwd');
    return (await sessions('session/create')).create(cwd, modelField('session/create', fields));
  });
  connection.handle('session/resume', async (params) => {
    const fields = paramsObject('session/resume', params);
    return (await sessions('session/resume')).resume(
      stringField('session/resume', fields, 'sessionId'),
      stringField('session/resume', fields, 'cwd'),
    );
  });
  connection.handle('session/prompt', async (params) => {
    const fields = paramsObject('session/prompt', params);
    const text = fields.text;
    if (typeof text !== 'string') {
      throw new AhpError('invalidParams', 'session/prompt: text must be a string');
    }
    const sessionId = stringField('session/prompt', fields, 'sessionId');
    const requestId = stringField('session/prompt', fields, 'requestId');
    return (await sessions('session/prompt')).prompt(sessionId, requestId, text);
  });
  connection.handle('session/abort', async (params) => {
    const sessionId = stringField(
      'session/abort',
      paramsObject('session/abort', params),
      'sessionId',
    );
    return (await sessions('session/abort')).abort(sessionId);
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
      const workspace = await openWorkspace(welcome.workspace, agentDirOf(options.dataDir));
      registry = new SessionRegistry({
        workspace,
        log,
        sinkFor: (sessionId) => ({
          event: (method, payload) => {
            outbound.sendSessionEvent(sessionId, method, payload);
          },
          delta: (method, mergeKey, payload, delta) => {
            outbound.sendDelta(sessionId, method, mergeKey, payload, delta);
          },
        }),
        isTrusted: async (cwd) => {
          try {
            const { trusted } = await connection.bridge.requestTyped(
              'trust/get',
              { path: cwd },
              parseTrust,
            );
            return trusted;
          } catch (error) {
            log(`trust/get for ${cwd} failed, treating it as untrusted: ${describeError(error)}`);
            return false;
          }
        },
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
