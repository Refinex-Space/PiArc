// The AHP connection of the Agent Host: decodes frames from Core, dispatches requests to their
// handlers, routes responses to the Core bridge and writes everything through the outbound
// queue. Malformed input is answered with a structured error and never stops the connection.
import {
  DEFAULT_MAX_FRAME_BYTES,
  FrameDecoder,
  type ErrorObject,
  type ErrorResponse,
  type RequestId,
  type SuccessResponse,
} from '@piarc/protocol';

import { CoreBridge } from '../runtime/core-bridge.js';
import { AhpError, describeError, toErrorObject } from './errors.js';
import type { OutboundQueue } from './outbound.js';

/** A request handler: receives unvalidated `params` and returns the result object. */
export type RequestHandler = (params: unknown) => Promise<object>;

/** Byte source with the parts of a Readable the connection uses. */
export interface FrameSource {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
}

export class Connection {
  readonly bridge: CoreBridge;
  readonly #outbound: OutboundQueue;
  readonly #decoder: FrameDecoder;
  readonly #handlers = new Map<string, RequestHandler>();
  readonly #log: (line: string) => void;
  #onEnd: () => void = () => undefined;

  constructor(
    outbound: OutboundQueue,
    options: {
      log: (line: string) => void;
      bridgeTimeoutMs?: number;
      maxFrameBytes?: number;
    },
  ) {
    this.#outbound = outbound;
    this.#log = options.log;
    this.#decoder = new FrameDecoder(options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES);
    this.bridge = new CoreBridge(
      (message) => {
        outbound.sendMessage(message);
      },
      options.bridgeTimeoutMs === undefined ? {} : { defaultTimeoutMs: options.bridgeTimeoutMs },
    );
  }

  /** Registers the handler for one Core → Agent Host method. */
  handle(method: string, handler: RequestHandler): void {
    this.#handlers.set(method, handler);
  }

  /** Starts reading `source`; `onEnd` runs once it ends (Core closed our stdin). */
  attach(source: FrameSource, onEnd: () => void): void {
    this.#onEnd = onEnd;
    source.on('data', (chunk) => {
      for (const frame of this.#decoder.decode(chunk)) {
        if (frame.ok) {
          this.#dispatch(frame.value);
        } else {
          this.#log(`dropped an inbound frame: ${frame.error.message}`);
          this.#replyError(null, new AhpError(frame.error.kind, frame.error.message));
        }
      }
    });
    source.on('end', () => {
      this.bridge.close('Core closed the connection');
      this.#onEnd();
    });
  }

  #dispatch(value: unknown): void {
    if (!isObject(value)) {
      const what = Array.isArray(value) ? 'batch requests are not supported' : 'not a JSON object';
      this.#replyError(null, new AhpError('invalidRequest', `invalid message: ${what}`));
      return;
    }
    const id = isRequestId(value.id) ? value.id : undefined;
    if (typeof value.method === 'string') {
      if (id === undefined) {
        this.#log(`ignored notification ${value.method} from Core`);
        return;
      }
      void this.#runHandler(id, value.method, value.params ?? {});
      return;
    }
    if (isResponse(value)) {
      if (!this.bridge.handleResponse(value)) {
        this.#log(`ignored a response with unknown id ${JSON.stringify(value.id)}`);
      }
      return;
    }
    this.#replyError(
      id ?? null,
      new AhpError('invalidRequest', 'invalid message: no method, result or error'),
    );
  }

  async #runHandler(id: RequestId, method: string, params: unknown): Promise<void> {
    const handler = this.#handlers.get(method);
    if (handler === undefined) {
      this.#replyError(id, new AhpError('methodNotFound', `unknown method ${method}`));
      return;
    }
    try {
      const result = await handler(params);
      this.#outbound.sendMessage({ jsonrpc: '2.0', id, result });
    } catch (error) {
      if (!(error instanceof AhpError)) {
        this.#log(`${method} failed: ${describeError(error)}`);
      }
      this.#replyError(id, error);
    }
  }

  #replyError(id: RequestId | null, error: unknown): void {
    const object: ErrorObject = toErrorObject(error);
    const response: ErrorResponse = { jsonrpc: '2.0', id, error: object };
    this.#outbound.sendMessage(response);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value));
}

function isResponse(value: unknown): value is SuccessResponse | ErrorResponse {
  if (!isObject(value) || value.jsonrpc !== '2.0' || !('id' in value)) {
    return false;
  }
  if ('result' in value) {
    return !('error' in value);
  }
  const error = value.error;
  return (
    isObject(error) &&
    typeof error.message === 'string' &&
    isObject(error.data) &&
    typeof error.data.kind === 'string' &&
    typeof error.data.retryable === 'boolean'
  );
}
