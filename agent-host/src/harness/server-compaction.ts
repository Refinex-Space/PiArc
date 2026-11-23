// Anthropic threshold compaction is stateless: the exact compaction block belongs at the
// start of the assistant response on every subsequent request. Pi normalizes that block
// away. Capture it before normalization and attach it to the finalized assistant entry,
// which Pi appends atomically. Projection uses the current branch, including after a rewind.
import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { ServerContextEdit } from '@piarc/protocol';

import { serverContextEdits } from '../providers/context-edits.js';
import { isObject } from '../runtime/items.js';

const EDITS = {
  clearTools: { edit: 'clear_tool_uses_20250919', beta: 'context-management-2025-06-27' },
  compact: { edit: 'compact_20260112', beta: 'compact-2026-01-12' },
} as const;

/** The marker exists only between Pi's context and payload hooks and never goes to disk. */
function restoreBlocks(payload: Record<string, unknown>, summaries: ReadonlyMap<string, string>) {
  if (!Array.isArray(payload.messages) || summaries.size === 0) return payload.messages;
  return payload.messages.map((message: unknown) => {
    if (!isObject(message) || message.role !== 'assistant' || !Array.isArray(message.content))
      return message;
    return {
      ...message,
      content: message.content.map((block: unknown) => {
        if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string')
          return block;
        const summary = summaries.get(block.text);
        return summary === undefined ? block : { type: 'compaction', content: summary };
      }),
    };
  });
}

export class ServerCompaction {
  #active: ServerContextEdit | undefined;
  #rejected: string | undefined;
  #selection: string | undefined;
  #markers = new Map<string, string>();
  #blockIndex: number | undefined;
  #summary: string | undefined;
  #responseId: string | undefined;
  #retry = false;
  fallback = false;

  /** Rejection latches for the current selection until the user changes model/strategy. */
  select(model: Model<Api>, edit: ServerContextEdit | null | undefined, enabled: boolean): boolean {
    const key = JSON.stringify([model.provider, model.id, edit, enabled]);
    if (this.#selection !== key) this.#rejected = undefined;
    this.#selection = key;
    const supported = edit != null && serverContextEdits(model).serverContextEdits?.includes(edit);
    this.fallback = enabled && edit != null && (!supported || this.#rejected === key);
    this.#active = enabled && supported && !this.fallback ? edit : undefined;
    return this.#active !== undefined;
  }

  #context(messages: AgentMessage[], model: Model<Api>) {
    this.#markers.clear();
    if (this.#active !== 'compact') return;
    return {
      messages: messages.map((message) => {
        if (
          message.role !== 'assistant' ||
          message.provider !== model.provider ||
          message.model !== model.id ||
          !('piarcCompaction' in message) ||
          typeof message.piarcCompaction !== 'string'
        )
          return message;
        const marker = randomUUID();
        this.#markers.set(marker, message.piarcCompaction);
        return {
          ...message,
          content: [{ type: 'text' as const, text: marker }, ...message.content],
        };
      }),
    };
  }

  install(
    pi: ExtensionAPI,
    fallback: () => void,
    before: () => Promise<{ block?: string; instructions?: string } | undefined>,
    after: (summary: string) => Promise<void>,
  ) {
    pi.on('cache_warming_decision', () =>
      this.#active === undefined ? undefined : { action: 'stop' },
    );
    pi.on('context', ({ messages }, ctx) => {
      const model: Model<Api> | undefined = ctx.model;
      if (model !== undefined) return this.#context(messages, model);
      return undefined;
    });
    pi.on('before_provider_request', async ({ payload }, ctx) => {
      if (
        this.#active === undefined ||
        ctx.model?.api !== 'anthropic-messages' ||
        !isObject(payload) ||
        payload.model !== ctx.model.id
      )
        return undefined;
      const strategy = this.#active;
      const { edit, beta } = EDITS[strategy];
      const decision = await before();
      // pi-ai's Anthropic adapter passes betas to the SDK, which merges them into the HTTP
      // header. Preserve betas selected by Pi (thinking, tools, …).
      return {
        ...payload,
        messages: restoreBlocks(payload, this.#markers),
        betas: [
          ...new Set([
            ...(Array.isArray(payload.betas)
              ? payload.betas.filter((b: unknown): b is string => typeof b === 'string')
              : []),
            beta,
          ]),
        ],
        ...(decision?.block === undefined
          ? {
              context_management: {
                edits: [
                  {
                    type: edit,
                    ...(strategy === 'compact' && decision?.instructions
                      ? { instructions: decision.instructions }
                      : {}),
                  },
                ],
              },
            }
          : {}),
      };
    });
    pi.on('provider_stream_event', ({ data, provider, api }) => {
      if (
        this.#active !== 'compact' ||
        provider !== 'anthropic' ||
        api !== 'anthropic-messages' ||
        !isObject(data)
      )
        return;
      if (data.type === 'message_start' && isObject(data.message)) {
        this.#responseId = typeof data.message.id === 'string' ? data.message.id : undefined;
        this.#blockIndex = undefined;
        this.#summary = undefined;
      } else if (
        data.type === 'content_block_start' &&
        isObject(data.content_block) &&
        data.content_block.type === 'compaction' &&
        typeof data.index === 'number'
      ) {
        this.#blockIndex = data.index;
        this.#summary =
          typeof data.content_block.content === 'string' ? data.content_block.content : undefined;
      } else if (
        data.type === 'content_block_delta' &&
        data.index === this.#blockIndex &&
        isObject(data.delta) &&
        data.delta.type === 'compaction_delta' &&
        typeof data.delta.content === 'string'
      ) {
        this.#summary = data.delta.content;
      }
    });
    pi.on('message_end', async ({ message }) => {
      if (this.#active === undefined || message.role !== 'assistant') return undefined;
      if (message.stopReason === 'error') {
        this.#rejected = this.#selection;
        this.#retry =
          message.content.length === 0 &&
          /context.management|compact_20260112|clear_tool_uses|compact-2026-01-12/i.test(
            message.errorMessage ?? '',
          );
        fallback();
        return undefined;
      }
      if (
        message.stopReason === 'aborted' ||
        !this.#responseId ||
        message.responseId !== this.#responseId
      )
        return undefined;
      const summary = this.#summary;
      if (!summary) {
        // The service can return a completed compaction block with null content when
        // summarization failed. The original conversation is still authoritative.
        if (this.#blockIndex !== undefined) {
          this.#rejected = this.#selection;
          fallback();
        }
        return undefined;
      }
      this.#summary = undefined;
      await after(summary);
      const replacement = { ...message, piarcCompaction: summary };
      return { message: replacement };
    });
    pi.on('agent_before_settle', (event) => {
      const retry = this.#retry;
      this.#retry = false;
      if (retry && event.outcome !== 'completed' && event.context.canContinue)
        return { continue: true };
      return undefined;
    });
  }
}
