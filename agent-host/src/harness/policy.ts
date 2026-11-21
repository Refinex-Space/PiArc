// Pi 1.5.2 calls tool_call after validating arguments and before any tool executes.
// A blocked call's reason is the error tool result in Pi's next model request.
import { DEFAULT_MAX_FRAME_BYTES, isPermissionMode, type PermissionMode } from '@piarc/protocol';
import { uploadChunkEnd } from '../tools/core-io.js';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

import { describeError } from '../protocol/errors.js';
import { wellFormedJson } from '../protocol/well-formed.js';
import type { CoreBridge } from '../runtime/core-bridge.js';
import { isObject } from '../runtime/items.js';
import { readPathCandidates, resolveToolPath } from '../tools/paths.js';
import type { HookNote } from './hooks.js';

export const DECLINED_ENTRY = 'piarc.toolDeclined';

interface ToolCall {
  tool: string;
  toolCallId: string;
  input: Record<string, unknown>;
  /** An MCP tool that asks the user on every call (T36). */
  requiresUserInteraction?: boolean;
}

/** Core's decision on a call: a refusal reason, or the hooks' additions to an allowed call. */
export interface Preflight {
  /** Set when the call must not run. */
  readonly reason?: string;
  /** Arguments a hook gave the call instead (the whole object). */
  readonly updatedInput?: Record<string, unknown>;
  /** `PreToolUse` context for the model, delivered with the call's result. */
  readonly context?: string;
  /** A hook stops the agent after this call. */
  readonly stop?: { readonly reason?: string };
  /** Allowing the call switched the session's permission mode (T26). */
  readonly mode?: PermissionMode;
}

/** The arguments Core and hooks see: file paths resolved against the session's cwd. */
export function preflightInput(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): Record<string, unknown> {
  if (!['Read', 'Edit', 'Write', 'Glob', 'Grep'].includes(tool)) return input;
  const requested = input.path ?? (tool === 'Glob' || tool === 'Grep' ? '.' : undefined);
  if (typeof requested !== 'string') throw new Error('missing file path');
  const resolved = resolveToolPath(requested, cwd);
  return {
    ...input,
    path: resolved,
    ...(tool === 'Read' ? { readPathCandidates: readPathCandidates(resolved) } : {}),
  };
}

function parseResult(value: unknown): Preflight | { allowed: true; result: Preflight } | undefined {
  if (
    !isObject(value) ||
    typeof value.allowed !== 'boolean' ||
    !(value.reason === undefined || value.reason === null || typeof value.reason === 'string') ||
    !(value.updatedInput === undefined || isObject(value.updatedInput)) ||
    !(value.context === undefined || typeof value.context === 'string') ||
    !(value.stop === undefined || isObject(value.stop)) ||
    !(value.mode === undefined || isPermissionMode(value.mode))
  ) {
    return undefined;
  }
  const stop = isObject(value.stop)
    ? typeof value.stop.reason === 'string'
      ? { reason: value.stop.reason }
      : {}
    : undefined;
  const extras: Preflight = {
    ...(isObject(value.updatedInput) ? { updatedInput: value.updatedInput } : {}),
    ...(typeof value.context === 'string' ? { context: value.context } : {}),
    ...(stop === undefined ? {} : { stop }),
    ...(isPermissionMode(value.mode) ? { mode: value.mode } : {}),
  };
  if (value.allowed) return { allowed: true, result: extras };
  return {
    ...extras,
    reason:
      typeof value.reason === 'string' && value.reason.trim()
        ? value.reason
        : 'Core denied permission for this tool call.',
  };
}

/** Core's decision; any failure is a refusal. Only an explicit, well-formed allow lets the call run. */
export async function preflight(
  bridge: CoreBridge,
  sessionId: string,
  cwd: string,
  call: ToolCall,
  signal?: AbortSignal,
): Promise<Preflight> {
  let staging = false;
  try {
    const { tool, toolCallId } = call;
    const input = wellFormedJson(preflightInput(tool, call.input, cwd));
    const target = {
      sessionId,
      tool,
      toolCallId,
      ...(call.requiresUserInteraction === true ? { requiresUserInteraction: true } : {}),
    };
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
    // Core sends policy/pending before preflight hooks or an approval, which stops the
    // transport deadline; a Core that never answers still times out.
    const result = await bridge.requestTyped('policy/evaluate', params, parseResult, {
      approval: { sessionId, toolCallId },
      ...(signal === undefined ? {} : { signal }),
    });
    return 'allowed' in result ? result.result : result;
  } catch (error) {
    if (staging) {
      // If a transfer failed before evaluate consumed it, release this call's chunks.
      try {
        await bridge.request('policy/cancel', { sessionId, toolCallId: call.toolCallId });
      } catch (cleanupError) {
        return {
          reason: `Permission denied: ${describeError(error)}. Could not cancel the preflight: ${describeError(cleanupError)}.`,
        };
      }
    }
    return {
      reason: `Permission denied: Core could not authorize this tool call (${describeError(error)}). Ask the user before retrying.`,
    };
  }
}

/** The reason to block, or undefined only after an explicit, well-formed allow. */
export async function refusal(
  bridge: CoreBridge,
  sessionId: string,
  cwd: string,
  call: ToolCall,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return (await preflight(bridge, sessionId, cwd, call, signal)).reason;
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

/** Asks Core which of a recovered turn's calls lost their approval (`policy/recover`):
 * call id → the reason, for the calls that did. */
export async function expiredApprovals(
  bridge: CoreBridge,
  sessionId: string,
  calls: readonly { readonly id: string }[],
): Promise<Map<string, string>> {
  const expired = new Map<string, string>();
  for (const call of calls) {
    const result = await bridge.requestTyped(
      'policy/recover',
      { sessionId, toolCallId: call.id },
      (value) =>
        isObject(value) &&
        (value.reason === undefined || value.reason === null || typeof value.reason === 'string')
          ? { reason: value.reason }
          : undefined,
    );
    if (typeof result.reason === 'string') expired.set(call.id, result.reason);
  }
  return expired;
}

/** The same gate covers PiArc, MCP and project tools. `onMode` hears the mode an allowed
 * call switched to (EnterPlanMode, an approved plan) before the call runs. */
export function policyGate(
  bridge: CoreBridge,
  sessionId: string,
  canonical: (tool: string) => string,
  markDeclined: (id: string) => void,
  log: (line: string) => void = () => undefined,
  hookNotes?: Map<string, HookNote>,
  onMode?: (mode: PermissionMode) => void,
  requiresUserInteraction?: (tool: string) => boolean,
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
      const decided = await preflight(
        bridge,
        sessionId,
        ctx.cwd,
        {
          tool: canonical(event.toolName),
          toolCallId: event.toolCallId,
          input: event.input,
          ...(requiresUserInteraction?.(event.toolName) === true
            ? { requiresUserInteraction: true }
            : {}),
        },
        ctx.signal,
      );
      if (decided.context !== undefined || decided.stop !== undefined) {
        hookNotes?.set(event.toolCallId, {
          ...(decided.context === undefined ? {} : { context: decided.context }),
          ...(decided.stop === undefined ? {} : { stop: decided.stop }),
        });
      }
      const { reason } = decided;
      if (reason === undefined) {
        if (decided.mode !== undefined) onMode?.(decided.mode);
        if (decided.updatedInput !== undefined) {
          // Pi 1.5.2 runs the tool with event.input as mutated here (no re-validation).
          const input = event.input as Record<string, unknown>;
          for (const key of Object.keys(input)) Reflect.deleteProperty(input, key);
          Object.assign(input, decided.updatedInput);
        }
        return;
      }
      if (decided.stop !== undefined) ctx.abort();
      if (!ctx.signal?.aborted) {
        markDeclined(event.toolCallId);
        pi.appendEntry(DECLINED_ENTRY, { toolCallId: event.toolCallId });
      }
      return { block: true, reason };
    });
  };
}
