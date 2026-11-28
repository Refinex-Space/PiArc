// Small helpers of the session registry (session-registry.ts).
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { QueueItem, SessionStopped } from '@piarc/protocol';

import type { ToolBatches } from '../harness/tool-batches.js';
import { AhpError } from '../protocol/errors.js';
import type { CoreIo, Shells, toolOptions } from '../tools/index.js';
import { CONSERVATIVE_TOOLS, isCanonicalTool } from '../tools/profile.js';
import type { Model, Api } from '@earendil-works/pi-ai';

import { prepareInput, type PreparedInput, type UserInput } from './input.js';
import type { Workspace } from './workspace.js';

/** Session ids Core may choose: Pi's own rule is stricter about nothing but length. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** The canonical tools with their executions held by `batches`. */
export function scheduled(
  options: ReturnType<typeof toolOptions>,
  batches: ToolBatches,
): ReturnType<typeof toolOptions> {
  return {
    ...options,
    customTools: options.customTools.map((tool: ToolDefinition) => batches.wrap(tool)),
  };
}

/** The conservative Tool Profile's subset of `options` (T29); everything when not conservative. */
export function onlyConservative(
  options: ReturnType<typeof toolOptions>,
  conservative: boolean,
  canonical: (tool: string) => string,
): ReturnType<typeof toolOptions> {
  if (!conservative) return options;
  return {
    ...options,
    customTools: options.customTools.filter((tool) => {
      const name = canonical(tool.name);
      return isCanonicalTool(name) && CONSERVATIVE_TOOLS.has(name);
    }),
  };
}

/** `prepared` with the context its `UserPromptSubmit` hooks added. */
export function withHookContext(
  prepared: PreparedInput,
  hookContext: string | undefined,
): PreparedInput {
  return hookContext === undefined ? prepared : { ...prepared, hookContext };
}

export function checkSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) {
    throw new AhpError(
      'invalidParams',
      'sessionId must be 1 to 128 letters, digits, ".", "_" or "-"',
      { details: { member: 'sessionId' } },
    );
  }
}

export function stopped(
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
export async function shellsFor(io: CoreIo, log: (line: string) => void): Promise<Shells> {
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

/** Refuses image attachments the session's model cannot take. */
export function checkImageInput(
  workspace: Workspace,
  model: Model<Api> | undefined,
  input: UserInput,
): void {
  if (!input.attachments.some((attachment) => attachment.kind === 'image')) return;
  const live = model && workspace.modelRuntime.getModel(model.provider, model.id);
  if (live === undefined || !workspace.preferences.vision(live)) {
    throw new AhpError(
      'invalidParams',
      'Image attachments are not supported by the selected model',
      {
        details: { member: 'attachments', reason: 'visionUnsupported' },
      },
    );
  }
}

/** Reads an input's attachments through Core (images by blob, PDFs by `fs/pdf`); `io` is
 * absent with Pi's own tools, which take no attachments. */
export async function prepareAttachments(
  io: CoreIo | undefined,
  sessionId: string,
  input: UserInput,
): Promise<PreparedInput> {
  if (input.attachments.length === 0) {
    return { input, sections: '', images: [] };
  }
  if (io === undefined) {
    throw new AhpError('invalidParams', 'attachments need the Core tool backend', {
      details: { sessionId },
    });
  }
  return prepareInput(input, {
    readBlob: (blob) => io.readBlob(blob),
    pdf: (path, pages) => io.pdf(path, pages),
  });
}
