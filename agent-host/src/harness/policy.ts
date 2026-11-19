// Pi 1.5.2 calls tool_call after validating arguments and before any tool executes.
// A blocked call's reason is the error tool result in Pi's next model request.
import { DEFAULT_MAX_FRAME_BYTES } from '@piarc/protocol';
import { uploadChunkEnd } from '../tools/core-io.js';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

import { describeError } from '../protocol/errors.js';
import { wellFormedJson } from '../protocol/well-formed.js';
import type { CoreBridge } from '../runtime/core-bridge.js';
import { isObject } from '../runtime/items.js';
import { readPathCandidates, resolveToolPath } from '../tools/paths.js';

export const DECLINED_ENTRY = 'piarc.toolDeclined';

interface ToolCall {
  tool: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

/** The reason to block, or undefined only after an explicit, well-formed allow. */
export async function refusal(
  bridge: CoreBridge,
  sessionId: string,
  cwd: string,
  call: ToolCall,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let staging = false;
  try {
    const { tool, toolCallId } = call;
    let input = call.input;
    if (['Read', 'Edit', 'Write', 'Glob', 'Grep'].includes(tool)) {
      const requested = input.path ?? (tool === 'Glob' || tool === 'Grep' ? '.' : undefined);
      if (typeof requested !== 'string') throw new Error('missing file path');
      const resolved = resolveToolPath(requested, cwd);
      input = {
        ...input,
        path: resolved,
        ...(tool === 'Read' ? { readPathCandidates: readPathCandidates(resolved) } : {}),
      };
    }
    input = wellFormedJson(input);
    const target = { sessionId, tool, toolCallId };
    let params: Record<string, unknown> = { ...target, input };
    const envelope = {
      jsonrpc: '2.0',
      id: Number.MAX_SAFE_INTEGER,
      method: 'policy/evaluate',
      params,
    };
    if (Buffer.byteLength(JSON.stringify(envelope)) >= DEFAULT_MAX_FRAME_BYTES) {
      staging = true;
      params = await stageInput(bridge, target, input, signal);
    }
    const result = await bridge.requestTyped(
      'policy/evaluate',
      params,
      (value) =>
        isObject(value) &&
        typeof value.allowed === 'boolean' &&
        (value.reason === undefined || value.reason === null || typeof value.reason === 'string')
          ? { allowed: value.allowed, reason: value.reason }
          : undefined,
      { approval: { sessionId, toolCallId }, ...(signal === undefined ? {} : { signal }) },
    );
    if (!result.allowed)
      return result.reason?.trim() ? result.reason : 'Core denied permission for this tool call.';
    return undefined;
  } catch (error) {
    if (staging) {
      // If a transfer failed before evaluate consumed it, release this call's chunks.
      try {
        await bridge.request('policy/cancel', { sessionId, toolCallId: call.toolCallId });
      } catch (cleanupError) {
        return `Permission denied: ${describeError(error)}. Could not cancel the preflight: ${describeError(cleanupError)}.`;
      }
    }
    return `Permission denied: Core could not authorize this tool call (${describeError(error)}). Ask the user before retrying.`;
  }
}

/** Write content crosses the wire raw, so JSON escaping does not reduce its 64 MiB limit. */
async function stageInput(
  bridge: CoreBridge,
  target: { sessionId: string; tool: string; toolCallId: string },
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const { content, ...other } = input;
  const write = target.tool === 'Write';
  if (write && typeof content !== 'string') throw new Error('Missing Write content');
  const text = write && typeof content === 'string' ? content : JSON.stringify(input);
  let offset = 0;
  for (let start = 0; start < text.length;) {
    const end = uploadChunkEnd(text, start);
    const chunk = text.slice(start, end);
    await bridge.requestTyped(
      'policy/inputChunk',
      { ...target, offset, text: chunk },
      (reply) => (isObject(reply) ? true : undefined),
      signal === undefined ? {} : { signal },
    );
    offset += Buffer.byteLength(chunk);
    start = end;
  }
  return { ...target, input: write ? other : {}, stagedInputBytes: offset };
}

/**
 * The model-visible tool names to declare, given the active ones, the ones this gate removed
 * earlier and the canonical names Core denies as a whole. Returns undefined when nothing changes.
 */
export function nextActiveTools(
  active: readonly string[],
  removed: Set<string>,
  denied: ReadonlySet<string>,
  canonical: (tool: string) => string,
): string[] | undefined {
  const next = new Set(active);
  let changed = false;
  for (const name of [...removed]) {
    if (!denied.has(canonical(name))) {
      removed.delete(name);
      next.add(name);
      changed = true;
    }
  }
  for (const name of active) {
    if (denied.has(canonical(name))) {
      next.delete(name);
      removed.add(name);
      changed = true;
    }
  }
  return changed ? [...next] : undefined;
}

/** The same gate covers PiArc, MCP and project tools. */
export function policyGate(
  bridge: CoreBridge,
  sessionId: string,
  canonical: (tool: string) => string,
  markDeclined: (id: string) => void,
  log: (line: string) => void = () => undefined,
): ExtensionFactory {
  return (pi) => {
    // A deny rule without a specifier removes the tool from the model's list (architecture
    // section 6.2.2). Asked before every run, so rule edits apply to the next request.
    const removed = new Set<string>();
    pi.on('before_agent_start', async () => {
      const active = pi.getActiveTools();
      const names = [...new Set([...active, ...removed])];
      try {
        const denied = await bridge.requestTyped(
          'policy/tools',
          { sessionId, tools: names.map(canonical) },
          (value) =>
            isObject(value) &&
            Array.isArray(value.denied) &&
            value.denied.every((t) => typeof t === 'string')
              ? new Set<string>(value.denied)
              : undefined,
        );
        const next = nextActiveTools(active, removed, denied, canonical);
        if (next !== undefined) pi.setActiveTools(next);
      } catch (error) {
        // Keep the list: every call still goes through policy/evaluate.
        log(`policy/tools failed: ${describeError(error)}`);
      }
      return undefined;
    });
    pi.on('tool_call', async (event, ctx) => {
      const reason = await refusal(
        bridge,
        sessionId,
        ctx.cwd,
        {
          tool: canonical(event.toolName),
          toolCallId: event.toolCallId,
          input: event.input,
        },
        ctx.signal,
      );
      if (reason === undefined) return;
      if (!ctx.signal?.aborted) {
        markDeclined(event.toolCallId);
        pi.appendEntry(DECLINED_ENTRY, { toolCallId: event.toolCallId });
      }
      return { block: true, reason };
    });
  };
}
