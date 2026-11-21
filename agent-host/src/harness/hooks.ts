// Hooks of the events the Agent Host observes in Pi 1.5.2 (architecture section 6.3.2,
// ADR-0039). Core runs every hook command; this module reports the moment over AHP
// `hooks/run` and applies the merged answer:
//
// | Pi event                | Hook event            | Applied here                                  |
// | ----------------------- | --------------------- | --------------------------------------------- |
// | `session_start`         | SessionStart          | context for the next run (not awaited)        |
// | `session_shutdown`      | SessionEnd            | nothing (awaited, Core bounds it)             |
// | `tool_result` (success) | PostToolUse           | replaced output and feedback; context         |
// | `tool_result` (error)   | PostToolUseFailure    | feedback; context                             |
// | `agent_before_settle`   | Stop (SubagentStop in a subagent) | continue with the reason, at most 8 in a row |
// | `turn_end` with results | PostToolBatch         | context; a block stops the run (T38)          |
// | subagent's first run    | SubagentStart         | context for its first request (T38)           |
// | `session_before_compact`| PreCompact            | cancel, or summary instructions (compaction.ts)|
// | `session_compact`       | PostCompact, then SessionStart (`compact`) (compaction.ts)  |
//
// Context hooks add (`additionalContext`, plain stdout) is a `hookContext` reminder (T27,
// ADR-0043): delivered with the next run or after the round's tool results, never inside a
// tool result. A failed `hooks/run` (Core gone, unknown method) changes nothing: the action goes
// on.
import { DEFAULT_MAX_FRAME_BYTES } from '@piarc/protocol';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

import { describeError } from '../protocol/errors.js';
import { wellFormedJson } from '../protocol/well-formed.js';
import type { CoreBridge } from '../runtime/core-bridge.js';
import { isObject } from '../runtime/items.js';
import { hookContextNotice, hookStoppedRun } from './prompts/notices.js';
import { reminderMessage, type Reminders } from './reminders.js';

/** First line of a hook's feedback in a tool result (before T27 also of hook context
 * messages, which older sessions still hold). */
export const HOOK_MARKER = '[PiArc hook context]';

type HostEvent =
  | 'sessionStart'
  | 'sessionEnd'
  | 'postToolUse'
  | 'postToolUseFailure'
  | 'stop'
  | 'preCompact'
  | 'postCompact'
  | 'subagentStart'
  | 'subagentStop'
  | 'postToolBatch';

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
  /** How the session opened; `branch` is the same session reopened on another branch (T28),
   * which runs no SessionStart hooks. */
  readonly source: 'startup' | 'resume' | 'fork' | 'branch';
  readonly canonical: (tool: string) => string;
  /** Pi's session file, once the session exists. */
  readonly transcript: () => string | undefined;
  /** The session's reminder channel: hook context goes there. */
  readonly reminders: Reminders;
  /** Resolves a file tool's `path` the way the preflight does. */
  readonly hookInput: (tool: string, input: Record<string, unknown>) => Record<string, unknown>;
  readonly log: (line: string) => void;
  /** A subagent's session (T31): no SessionStart, Stop or SessionEnd; its start and end are
   * SubagentStart and SubagentStop (T38). */
  readonly subagent?: boolean;
  /** The session's effort level for the hooks' `effort` (T38); undefined without one. */
  readonly effort?: () => string | undefined;
}

export class SessionHooks {
  readonly #o: SessionHooksOptions;
  /** `PreToolUse` context and stops, by tool call id. */
  readonly notes = new Map<string, HookNote>();
  #starting: Promise<void> = Promise.resolve();
  readonly #startedAt = new Map<string, number>();
  /** `Stop` continuations in a row; a tool call resets them. */
  #continuations = 0;
  #active = false;
  /** Set when the session closes to reopen on another branch: no SessionEnd. */
  #muted = false;

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

  /** The session closes only to reopen on another branch (T28): it does not end. */
  mute(): void {
    this.#muted = true;
  }

  /** `{ effort: { level } }` when the session's model has an effort level (T38, I115). */
  #effort(): Record<string, unknown> {
    const level = this.#o.effort?.();
    return level === undefined ? {} : { effort: { level } };
  }

  /** `SubagentStart` (T38): the subagent is about to send its first request; the context
   * hooks add goes with it. Core matches the agent type and adds `agent_id`, `agent_type`. */
  async subagentStart(): Promise<void> {
    const result = await this.run('subagentStart', {});
    this.#remind('SubagentStart', result.context);
  }

  /** Context a hook added, for the model's next request. */
  #remind(event: string, text: string | undefined): void {
    if (text === undefined || text.length === 0) return;
    this.#o.reminders.enqueue(this.#o.reminders.uniqueKey(`hook:${event}`), {
      type: 'hookContext',
      source: event,
      text: hookContextNotice(event, text),
    });
  }

  /** `UserPromptSubmit` context of an input: with the next run, or after the current round's
   * tool results during a run. */
  addContext(text: string | undefined): void {
    this.#remind('UserPromptSubmit', text);
  }

  /** `PreCompact`: Core's merged answer (a block, or summary instructions). */
  async preCompact(trigger: 'manual' | 'auto', instructions: string | undefined) {
    return this.run('preCompact', { trigger, custom_instructions: instructions ?? null });
  }

  /** `PostCompact` with the summary, then `SessionStart` (`compact`) whose context is queued. */
  async postCompact(trigger: 'manual' | 'auto', summary: string): Promise<void> {
    await this.run('postCompact', { trigger, compact_summary: summary });
    const start = await this.run('sessionStart', { source: 'compact' });
    this.#remind('SessionStart', start.context);
  }

  #toolInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
    try {
      return this.#o.hookInput(tool, input);
    } catch {
      return input;
    }
  }

  extension: ExtensionFactory = (pi) => {
    pi.on('session_start', (_event, ctx) => {
      if (this.#o.source === 'branch' || this.#o.subagent === true) return;
      // Not awaited: a slow hook must not hold up opening the session; the first run waits.
      this.#starting = this.run('sessionStart', {
        source: this.#o.source,
        ...(ctx.model === undefined ? {} : { model: ctx.model.id }),
      }).then((result) => {
        this.#remind('SessionStart', result.context);
      });
    });

    pi.on('before_agent_start', async () => {
      // The reminders extension, registered after this one, delivers what is queued.
      await this.#starting;
      this.#continuations = 0;
      this.#active = false;
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
        ...this.#effort(),
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
      if (result.feedback !== undefined && result.feedback.length > 0) {
        content = [...content, { type: 'text', text: `${HOOK_MARKER}\n${result.feedback}` }];
        changed = true;
      }
      this.#remind('PreToolUse', note?.context);
      this.#remind(event.isError ? 'PostToolUseFailure' : 'PostToolUse', result.context);
      if (note?.stop !== undefined || result.stop !== undefined) {
        this.#o.log(`a hook stopped the turn after ${event.toolCallId}`);
        ctx.abort();
      }
      return changed ? { content } : undefined;
    });

    pi.on('turn_end', async (event, ctx) => {
      // One round of tool calls finished; the next request has not been sent (T38).
      if (event.toolResults.length === 0 || event.outcome !== 'completed') return undefined;
      const message: unknown = event.message;
      const inputs = new Map<string, Record<string, unknown>>();
      if (isObject(message) && Array.isArray(message.content)) {
        for (const part of message.content as unknown[]) {
          if (isObject(part) && part.type === 'toolCall' && typeof part.id === 'string') {
            inputs.set(part.id, isObject(part.arguments) ? part.arguments : {});
          }
        }
      }
      const calls = event.toolResults.map((result) => {
        const tool = this.#o.canonical(result.toolName);
        return {
          tool_name: tool,
          tool_input: this.#toolInput(tool, inputs.get(result.toolCallId) ?? {}),
          tool_use_id: result.toolCallId,
          tool_response: contentForHook(result.content),
        };
      });
      const batch = await this.run('postToolBatch', { tool_calls: calls, ...this.#effort() });
      this.#remind('PostToolBatch', batch.context);
      if (batch.block !== undefined || batch.stop !== undefined) {
        // Pi's `turn_end` cannot end the run: stop it before the next request, and tell the
        // model why with the next input (the user reads the reason in the hook notice).
        this.#o.log('a PostToolBatch hook stopped the run');
        const reason = batch.block ?? batch.stop?.reason;
        if (reason !== undefined && reason !== '') {
          this.#o.reminders.enqueue(this.#o.reminders.uniqueKey('hook:PostToolBatch'), {
            type: 'hookContext',
            source: 'PostToolBatch',
            text: hookStoppedRun('PostToolBatch', reason),
          });
        }
        ctx.abort();
      }
      return undefined;
    });

    pi.on('agent_before_settle', async (event) => {
      // Not after an interrupt or a failed request (Claude Code's StopFailure, M4).
      if (event.outcome !== 'completed') return undefined;
      const messages: readonly unknown[] = event.context.contextMessages;
      const last = messages.findLast((m) => isObject(m) && m.role === 'assistant');
      const text =
        isObject(last) && Array.isArray(last.content) ? contentText(last.content as unknown[]) : '';
      const subagent = this.#o.subagent === true;
      const transcript = this.#o.transcript();
      const result = await this.run(
        subagent ? 'subagentStop' : 'stop',
        {
          stop_hook_active: this.#active,
          last_assistant_message: text,
          ...(subagent && transcript !== undefined ? { agent_transcript_path: transcript } : {}),
          ...this.#effort(),
        },
        this.#continuations,
      );
      if (result.stop !== undefined) return undefined;
      const reasons = [result.block, result.context].filter(
        (r): r is string => r !== undefined && r.length > 0,
      );
      if (reasons.length === 0) return undefined;
      this.#continuations += 1;
      this.#active = true;
      const name = subagent ? 'SubagentStop' : 'Stop';
      const reminder = reminderMessage([
        {
          key: this.#o.reminders.uniqueKey(`hook:${name}`),
          type: 'hookContext',
          source: name,
          text: hookContextNotice(name, reasons.join('\n\n')),
        },
      ]);
      return {
        entries: [{ type: 'custom_message' as const, ...reminder }],
        continue: true,
      };
    });

    pi.on('session_shutdown', async () => {
      if (this.#muted || this.#o.subagent === true) return;
      await this.run('sessionEnd', { reason: 'other' });
    });
  };
}
