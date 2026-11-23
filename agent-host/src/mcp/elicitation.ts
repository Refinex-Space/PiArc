// pi-mcp dispatches incoming requests on the connection. On a shared connection an
// elicitation without a unique originating call cannot safely be routed to a session.
import type { CoreBridge } from '../runtime/core-bridge.js';
import { isObject } from '../runtime/items.js';

export interface ElicitationOwner {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly serverTool: string;
}

export class Elicitations {
  readonly #calls = new Set<{
    owner?: ElicitationOwner;
    end: AbortController;
    pending: boolean;
    latest: number;
  }>();

  begin(owner?: ElicitationOwner): () => void {
    const call = {
      ...(owner === undefined ? {} : { owner }),
      end: new AbortController(),
      pending: false,
      latest: 0,
    };
    this.#calls.add(call);
    return () => {
      call.end.abort();
      this.#calls.delete(call);
    };
  }

  async handle(bridge: CoreBridge, server: string, params: unknown, signal: AbortSignal) {
    if (this.#calls.size !== 1) return { action: 'cancel' };
    const call = this.#calls.values().next().value;
    if (call?.owner === undefined || call.pending) return { action: 'cancel' };
    if (!isObject(params) || typeof params.message !== 'string') {
      throw new Error('Invalid MCP elicitation request.');
    }
    const mode = params.mode ?? 'form';
    let request;
    if (mode === 'form' && isObject(params.requestedSchema)) {
      request = { mode, message: params.message, requestedSchema: params.requestedSchema };
    } else if (
      mode === 'url' &&
      typeof params.url === 'string' &&
      typeof params.elicitationId === 'string'
    ) {
      request = {
        mode,
        message: params.message,
        url: params.url,
        elicitationId: params.elicitationId,
      };
    } else {
      throw new Error('Invalid MCP elicitation mode or parameters.');
    }
    const owner = call.owner;
    const abort = AbortSignal.any([call.end.signal, signal]);
    abort.throwIfAborted();
    const interaction = ++call.latest;
    let cancellation: Promise<unknown> | undefined;
    const cancel = () => {
      cancellation = bridge.request('mcp/cancelElicitation', {
        sessionId: owner.sessionId,
        toolCallId: owner.toolCallId,
        interaction,
      });
    };
    abort.addEventListener('abort', cancel, { once: true });
    call.pending = true;
    try {
      const reply = await bridge.request(
        'mcp/elicit',
        { ...owner, server, interaction, request },
        { signal: abort, timeoutMs: null },
      );
      if (
        !isObject(reply) ||
        !['accept', 'decline', 'cancel'].some((action) => action === reply.action)
      ) {
        throw new Error('Invalid MCP elicitation response.');
      }
      return reply;
    } finally {
      abort.removeEventListener('abort', cancel);
      try {
        // The next question must not overtake this withdrawal, even if dispatch in Core
        // has not yet started handling the original elicitation.
        await cancellation;
      } finally {
        call.pending = false;
      }
    }
  }
}
