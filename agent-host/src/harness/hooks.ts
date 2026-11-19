// Hooks of the events the Agent Host observes in Pi 1.5.2 (architecture section 6.3.2,
// ADR-0039). Core runs every hook command; this module reports the moment over AHP
// `hooks/run` and applies the merged answer:
//
// | Pi event                | Hook event            | Applied here                                  |
// | ----------------------- | --------------------- | --------------------------------------------- |
// | `session_start`         | SessionStart          | context for the next run (not awaited)        |
// | `session_shutdown`      | SessionEnd            | nothing (awaited, Core bounds it)             |
// | `tool_result` (success) | PostToolUse           | replaced output, feedback and context appended |
// | `tool_result` (error)   | PostToolUseFailure    | feedback and context appended                 |
// | `agent_before_settle`   | Stop                  | continue with the reason, at most 8 in a row  |
// | `session_before_compact`| PreCompact            | cancel, or summary instructions               |
// | `session_compact`       | PostCompact, then SessionStart (`compact`) | context for the next run |
//
// A failed `hooks/run` (Core gone, unknown method) changes nothing: the action goes on.
import { compact } from '@earendil-works/pi-coding-agent';
import { DEFAULT_MAX_FRAME_BYTES } from '@piarc/protocol';
import type { AgentSession, ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';

import { describeError } from '../protocol/errors.js';
import { wellFormedJson } from '../protocol/well-formed.js';
import type { CoreBridge } from '../runtime/core-bridge.js';
import { isObject } from '../runtime/items.js';

/** Custom message type of hook context in the conversation. */
export const HOOK_CONTEXT = 'piarc.hookContext';

/** First line of every hook context message (Anthropic wire merges it with its user message). */
export const HOOK_MARKER = '[PiArc hook context]';

type HostEvent =
  | 'sessionStart'
  | 'sessionEnd'
  | 'postToolUse'
  | 'postToolUseFailure'
  | 'stop'
  | 'preCompact'
  | 'postCompact';

/** Core's merged answer (`hooks/run` result). */
export interface HookResult {
  readonly block?: string;
  readonly context?: string;
  readonly feedback?: string;
  readonly updatedOutput?: unknown;
  readonly instructions?: string;
  readonly stop?: { readonly reason?: string };
}

/** What `PreToolUse` left for the call's result. */
export interface HookNote {
  readonly context?: string;
  readonly stop?: { readonly reason?: string };
}

const optionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';

export function parseHookResult(value: unknown): HookResult | undefined {
  if (!isObject(value)) return undefined;
  const { block, context, feedback, instructions, stop, updatedOutput } = value;
  if (
    !optionalString(block) ||
    !optionalString(context) ||
    !optionalString(feedback) ||
    !optionalString(instructions) ||
    (stop !== undefined && (!isObject(stop) || !optionalString(stop.reason)))
  ) {
    return undefined;
  }
  return {
    ...(block === undefined ? {} : { block }),
    ...(context === undefined ? {} : { context }),
    ...(feedback === undefined ? {} : { feedback }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(updatedOutput === undefined ? {} : { updatedOutput }),
    ...(stop === undefined
      ? {}
      : { stop: typeof stop.reason === 'string' ? { reason: stop.reason } : {} }),
  };
}

/** A tool result's text, images named by type only. */
function contentForHook(content: readonly unknown[]): unknown[] {
  return content.map((block) =>
    isObject(block) && block.type === 'image' ? { type: 'image', mimeType: block.mimeType } : block,
  );
}

function contentText(content: readonly unknown[]): string {
  return content
    .map((block) => (isObject(block) && typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}

const isTextBlock = (b: unknown): b is { type: 'text'; text: string } =>
  isObject(b) && b.type === 'text' && typeof b.text === 'string';

/** `updatedToolOutput` as content blocks: text, a list of text blocks, or JSON text. */
function outputContent(output: unknown): { type: 'text'; text: string }[] {
  if (typeof output === 'string') return [{ type: 'text', text: output }];
  if (Array.isArray(output) && output.every(isTextBlock)) {
    return output.map((b) => ({ type: 'text', text: b.text }));
  }
  return [{ type: 'text', text: JSON.stringify(output) }];
}

/** Longest string kept in a hook input that would not fit in one AHP frame. */
const FIT_STRING_CHARS = 16 * 1024;

/** Strings longer than `limit` cut to it, with a note of how much was left out. */
function cutStrings(value: unknown, limit: number): unknown {
  if (typeof value === 'string' && value.length > limit) {
    return `${value.slice(0, limit)}\n[PiArc cut ${String(value.length - limit)} characters from this hook input field]`;
  }
  if (Array.isArray(value)) return value.map((item) => cutStrings(item, limit));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cutStrings(v, limit)]));
  }
  return value;
}

/**
 * `params` as one AHP frame can carry it: a tool's input or output larger than the frame
 * budget (a large Write) has its long strings cut; undefined when even that does not fit.
 */
export function fitFrame(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const size = (p: unknown) =>
    Buffer.byteLength(
      JSON.stringify({
        jsonrpc: '2.0',
        id: Number.MAX_SAFE_INTEGER,
        method: 'hooks/run',
        params: p,
      }),
    );
  if (size(params) < DEFAULT_MAX_FRAME_BYTES) return params;
  const cut = { ...params, input: cutStrings(params.input, FIT_STRING_CHARS) };
  return size(cut) < DEFAULT_MAX_FRAME_BYTES ? cut : undefined;
}

export interface SessionHooksOptions {
  readonly bridge: CoreBridge;
  readonly sessionId: string;
  readonly cwd: string;
  /** How the session opened: `startup` (created), `resume` or `fork`. */
  readonly source: 'startup' | 'resume' | 'fork';
  readonly canonical: (tool: string) => string;
  /** Pi's session file, once the session exists. */
  readonly transcript: () => string | undefined;
  /** The session, once it exists (compaction with instructions needs its stream function). */
  readonly session: () => AgentSession | undefined;
  /** Resolves a file tool's `path` the way the preflight does. */
  readonly hookInput: (tool: string, input: Record<string, unknown>) => Record<string, unknown>;
  readonly log: (line: string) => void;
}

export class SessionHooks {
  readonly #o: SessionHooksOptions;
  /** `PreToolUse` context and stops, by tool call id. */
  readonly notes = new Map<string, HookNote>();
  /** Context for the next run. */
  #pending: string[] = [];
  #starting: Promise<void> = Promise.resolve();
  readonly #startedAt = new Map<string, number>();
  /** `Stop` continuations in a row; a tool call resets them. */
  #continuations = 0;
  #active = false;
  #pi: ExtensionAPI | undefined;

  constructor(options: SessionHooksOptions) {
    this.#o = options;
  }

  /** Runs one event's hooks in Core; a failure is logged and means "go on unchanged". */
  async run(
    event: HostEvent,
    input: Record<string, unknown>,
    continuations?: number,
  ): Promise<HookResult> {
    try {
      const transcript = this.#o.transcript();
      const params = fitFrame({
        sessionId: this.#o.sessionId,
        event,
        cwd: this.#o.cwd,
        ...(transcript === undefined ? {} : { transcriptPath: transcript }),
        input: wellFormedJson(input),
        ...(continuations === undefined ? {} : { continuations }),
      });
      if (params === undefined) {
        this.#o.log(`hooks/run ${event} skipped: its input does not fit in one AHP frame`);
        return {};
      }
      // Core bounds every hook with its own timeout and answers every frame it reads.
      return await this.#o.bridge.requestTyped('hooks/run', params, parseHookResult, {
        timeoutMs: null,
      });
    } catch (error) {
      this.#o.log(`hooks/run ${event} failed: ${describeError(error)}`);
      return {};
    }
  }

  /** `UserPromptSubmit` context of an input: with the next run, or now during a run. */
  addContext(text: string | undefined, running = false): void {
    if (text === undefined || text.length === 0) return;
    if (running && this.#pi !== undefined) {
      // Pi 1.5.2 appends it after the current step's tool results, before the next request.
      this.#pi.sendMessage(message(text), { triggerTurn: false });
      return;
    }
    this.#pending.push(text);
  }

  #toolInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
    try {
      return this.#o.hookInput(tool, input);
    } catch {
      return input;
    }
  }

  extension: ExtensionFactory = (pi) => {
    this.#pi = pi;
    pi.on('session_start', (_event, ctx) => {
      // Not awaited: a slow hook must not hold up opening the session; the first run waits.
      this.#starting = this.run('sessionStart', {
        source: this.#o.source,
        ...(ctx.model === undefined ? {} : { model: ctx.model.id }),
      }).then((result) => {
        if (result.context !== undefined) this.#pending.push(result.context);
      });
    });

    pi.on('before_agent_start', async () => {
      await this.#starting;
      this.#continuations = 0;
      this.#active = false;
      const texts = this.#pending;
      this.#pending = [];
      return texts.length === 0 ? undefined : { message: message(texts.join('\n\n')) };
    });

    pi.on('tool_execution_start', (event) => {
      this.#startedAt.set(event.toolCallId, Date.now());
      this.#continuations = 0;
    });

    pi.on('tool_result', async (event, ctx) => {
      if (event.parentToolCallId !== undefined) return undefined;
      const note = this.notes.get(event.toolCallId);
      this.notes.delete(event.toolCallId);
      const started = this.#startedAt.get(event.toolCallId);
      this.#startedAt.delete(event.toolCallId);
      const tool = this.#o.canonical(event.toolName);
      const common = {
        tool_name: tool,
        tool_input: this.#toolInput(tool, event.input),
        tool_use_id: event.toolCallId,
        ...(started === undefined ? {} : { duration_ms: Date.now() - started }),
      };
      const result = event.isError
        ? await this.run('postToolUseFailure', {
            ...common,
            error: contentText(event.content),
            is_interrupt: ctx.signal?.aborted === true,
          })
        : await this.run('postToolUse', {
            ...common,
            tool_response: { content: contentForHook(event.content) },
          });
      let content = event.content;
      let changed = false;
      if (!event.isError && result.updatedOutput !== undefined) {
        content = outputContent(result.updatedOutput);
        changed = true;
      }
      const added = [note?.context, result.feedback, result.context].filter(
        (text): text is string => text !== undefined && text.length > 0,
      );
      if (added.length > 0) {
        content = [...content, { type: 'text', text: `${HOOK_MARKER}\n${added.join('\n\n')}` }];
        changed = true;
      }
      if (note?.stop !== undefined || result.stop !== undefined) {
        this.#o.log(`a hook stopped the turn after ${event.toolCallId}`);
        ctx.abort();
      }
      return changed ? { content } : undefined;
    });

    pi.on('agent_before_settle', async (event) => {
      // Not after an interrupt or a failed request (Claude Code's StopFailure, M4).
      if (event.outcome !== 'completed') return undefined;
      const messages: readonly unknown[] = event.context.contextMessages;
      const last = messages.findLast((m) => isObject(m) && m.role === 'assistant');
      const text =
        isObject(last) && Array.isArray(last.content) ? contentText(last.content as unknown[]) : '';
      const result = await this.run(
        'stop',
        { stop_hook_active: this.#active, last_assistant_message: text },
        this.#continuations,
      );
      if (result.stop !== undefined) return undefined;
      const reasons = [result.block, result.context].filter(
        (r): r is string => r !== undefined && r.length > 0,
      );
      if (reasons.length === 0) return undefined;
      this.#continuations += 1;
      this.#active = true;
      return {
        entries: [
          {
            type: 'custom_message' as const,
            customType: HOOK_CONTEXT,
            content: `${HOOK_MARKER}\nA Stop hook asked to continue:\n${reasons.join('\n\n')}`,
            display: false,
          },
        ],
        continue: true,
      };
    });

    pi.on('session_before_compact', async (event, ctx) => {
      const trigger = event.reason === 'manual' ? 'manual' : 'auto';
      const result = await this.run('preCompact', {
        trigger,
        custom_instructions: event.customInstructions ?? null,
      });
      if (result.block !== undefined) return { cancel: true };
      if (result.instructions === undefined) return undefined;
      const session = this.#o.session();
      const model = ctx.model;
      if (session === undefined || model === undefined) return undefined;
      // Pi does not read instructions back from this event: summarize here with them.
      const instructions = [event.customInstructions, result.instructions]
        .filter((t): t is string => t !== undefined && t.length > 0)
        .join('\n\n');
      const compaction = await compact(
        event.preparation,
        model,
        undefined,
        undefined,
        instructions,
        event.signal,
        session.thinkingLevel,
        session.agent.streamFunction,
      );
      return { compaction };
    });

    pi.on('session_compact', async (event) => {
      const trigger = event.reason === 'manual' ? 'manual' : 'auto';
      await this.run('postCompact', {
        trigger,
        compact_summary: event.compactionEntry.summary,
      });
      const start = await this.run('sessionStart', { source: 'compact' });
      if (start.context !== undefined) this.#pending.push(start.context);
    });

    pi.on('session_shutdown', async () => {
      await this.run('sessionEnd', { reason: 'other' });
    });
  };
}

function message(text: string) {
  return {
    customType: HOOK_CONTEXT,
    display: false,
    content: `${HOOK_MARKER}\n${text}`,
  };
}
