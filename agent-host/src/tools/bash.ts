// `Bash`: Pi's bash tool (session variables, output accumulation and truncation, exit code
// reporting) with `BashOperations.exec` delegated to Core's `exec/run`.
//
// The operations keep the contract of Pi's local shell backend (`createLocalShellOperations`,
// v1.5.2): the same timeout validation and messages, `aborted` and `timeout:<seconds>` errors,
// signal terminations reported as 128 + signal number. Abort and timeout send `exec/kill`; T17
// moves timeouts into Core and terminates whole process trees.
import {
  defineTool,
  createBashToolDefinition,
  type BashOperations,
  type BashToolDetails,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

import { errorCode, isAborted, type CoreIo, type Origin } from './core-io.js';
import { presentationOf, type ToolSetup } from './presentation.js';

type BashDefinition = ReturnType<typeof createBashToolDefinition>;

const MAX_TIMEOUT_MS = 2_147_483_647;

export function createBashTool({ io, presentation }: ToolSetup): ToolDefinition {
  const template = createBashToolDefinition('.');
  return defineTool<BashDefinition['parameters'], BashToolDetails | undefined>({
    ...presentationOf(presentation),
    parameters: template.parameters,
    ...(template.outputSchema === undefined ? {} : { outputSchema: template.outputSchema }),
    ...(template.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: template.constrainedSampling }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const pi = createBashToolDefinition(ctx.cwd, {
        operations: bashOperations(io, { tool: 'Bash', toolCallId }),
      });
      return pi.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}

/** `BashOperations` that run the command in Core. */
export function bashOperations(io: CoreIo, origin: Origin): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const timeoutMs = timeoutMsOf(timeout);
      if (isAborted(signal)) {
        throw new Error('aborted');
      }
      const { outcome, kill } = io.run({ command, cwd, env: overlayOf(env) }, onData, origin);
      const state = { timedOut: false };
      const stop = (): void => {
        // A failed kill means the command already ended or the connection is gone; either
        // way `outcome` settles on its own.
        kill().catch(() => undefined);
      };
      signal?.addEventListener('abort', stop, { once: true });
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              state.timedOut = true;
              stop();
            }, timeoutMs);
      try {
        const result = await outcome.catch(async (error: unknown) => {
          throw await explain(io, error, cwd, origin);
        });
        if (isAborted(signal)) {
          throw new Error('aborted');
        }
        if (state.timedOut) {
          throw new Error(`timeout:${String(timeout)}`);
        }
        const bySignal = result.signal === undefined ? 1 : 128 + result.signal;
        return { exitCode: result.exitCode ?? bySignal };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
      }
    },
  };
}

function timeoutMsOf(timeout: number | undefined): number | undefined {
  if (timeout === undefined) {
    return undefined;
  }
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('Invalid timeout: must be a finite number of seconds');
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${String(MAX_TIMEOUT_MS / 1000)} seconds`);
  }
  return timeoutMs;
}

/** The variables Pi set for the command beyond the Agent Host's own environment (its `PI_*`
 * session variables and `PATH`): Core applies them on top of its environment. */
function overlayOf(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const overlay: Record<string, string> = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (value !== undefined && process.env[name] !== value) {
      overlay[name] = value;
    }
  }
  return overlay;
}

/** A missing working directory gets the message of Pi's local backend. */
async function explain(io: CoreIo, error: unknown, cwd: string, origin: Origin): Promise<unknown> {
  if (errorCode(error) !== 'ENOENT') {
    return error;
  }
  try {
    await io.stat(cwd, origin);
    return error;
  } catch (statError) {
    return errorCode(statError) === 'ENOENT'
      ? new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`)
      : error;
  }
}
