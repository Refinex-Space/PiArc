// Requests from the Agent Host to Core (architecture section 7.4, "Agent Host → Core").
//
// Every request goes through `CoreBridge.request`: one id space, one pending table, one
// timeout policy. A request fails with a structured AhpError on timeout (`timeout`), when the
// connection ends first (`uncertain`), on an error response (the response's kind) and when the
// result does not match what the caller expects (`invalidRequest`). Callers turn every failure
// into a refusal; nothing continues silently.
import type { ErrorResponse, SuccessResponse } from '@piarc/protocol';

import { AhpError, errorKindOf } from '../protocol/errors.js';

/** Default timeout for requests that do not wait for a person. */
export const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;

export interface RequestOptions {
  /**
   * Milliseconds to wait for the response; `null` waits until the response, cancellation or
   * connection close (for example exec/run). Defaults to the bridge's timeout.
   */
  timeoutMs?: number | null;
  /** A matching policy/pending suspends the deadline once Core is waiting for the user. */
  approval?: { sessionId: string; toolCallId: string };
  /** Cancels the wait, for example when the session's turn is interrupted. */
  signal?: AbortSignal;
}

interface Pending {
  readonly method: string;
  readonly approval?: { sessionId: string; toolCallId: string; suspend: () => void };
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: AhpError) => void;
}

export class CoreBridge {
  readonly #send: (message: object) => void;
  readonly #defaultTimeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closedReason: string | undefined;

  constructor(send: (message: object) => void, options: { defaultTimeoutMs?: number } = {}) {
    this.#send = send;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
  }

  /** Sends `method` and resolves with the response's `result`. */
  async request(method: string, params: object, options: RequestOptions = {}): Promise<unknown> {
    if (this.#closedReason !== undefined) {
      throw new AhpError('uncertain', `${method} not sent: ${this.#closedReason}`);
    }
    const timeoutMs = options.timeoutMs === undefined ? this.#defaultTimeoutMs : options.timeoutMs;
    const { signal } = options;
    signal?.throwIfAborted();
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = (): void => {
        settle();
        reject(new AhpError('uncertain', `${method} cancelled: ${String(signal?.reason)}`));
      };
      const settle = (): void => {
        this.#pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      this.#pending.set(id, {
        method,
        ...(options.approval === undefined
          ? {}
          : {
              approval: {
                ...options.approval,
                suspend: () => {
                  clearTimeout(timer);
                },
              },
            }),
        resolve: (result) => {
          settle();
          resolve(result);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          settle();
          reject(
            new AhpError('timeout', `${method} got no response within ${String(timeoutMs)} ms`, {
              retryable: true,
            }),
          );
        }, timeoutMs);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.#send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        // The frame never left (it could not be encoded): nothing will answer it.
        settle();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Sends `method` and checks the result with `parse`, which returns the typed result or
   * `undefined` when the shape is wrong.
   */
  async requestTyped<T>(
    method: string,
    params: object,
    parse: (result: unknown) => T | undefined,
    options?: RequestOptions,
  ): Promise<T> {
    const result = parse(await this.request(method, params, options));
    if (result === undefined) {
      throw new AhpError('invalidRequest', `${method} returned a malformed result`);
    }
    return result;
  }

  /** Stops the transport deadline for the named approval. False means the caller is gone. */
  awaitingApproval(sessionId: string, toolCallId: string): boolean {
    for (const { approval } of this.#pending.values()) {
      if (approval?.sessionId === sessionId && approval.toolCallId === toolCallId) {
        approval.suspend();
        return true;
      }
    }
    return false;
  }

  /** Routes a response from Core. Returns false when no request with that id is waiting. */
  handleResponse(message: SuccessResponse | ErrorResponse): boolean {
    const pending = typeof message.id === 'number' ? this.#pending.get(message.id) : undefined;
    if (pending === undefined) {
      return false;
    }
    if ('error' in message) {
      const { kind, retryable, details } = message.error.data;
      pending.reject(
        new AhpError(errorKindOf(kind), `${pending.method} failed: ${message.error.message}`, {
          retryable,
          details,
        }),
      );
    } else {
      pending.resolve(message.result);
    }
    return true;
  }

  /** Fails every waiting request; later requests fail at once. */
  close(reason: string): void {
    this.#closedReason ??= reason;
    for (const pending of [...this.#pending.values()]) {
      pending.reject(new AhpError('uncertain', `${pending.method} lost: ${reason}`));
    }
  }

  /** Number of requests waiting for a response. */
  get pendingCount(): number {
    return this.#pending.size;
  }
}
