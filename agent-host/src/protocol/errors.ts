// Structured AHP errors: the JSON-RPC error object with mandatory `data.kind` and
// `data.retryable` (piarc-protocol `rpc_error`). Codes mirror `rpc_error::code`; the table is
// a Record over the generated ErrorKind union, so a kind added in Rust fails to compile here
// until it gets its code.
import type { ErrorKind, ErrorObject } from '@piarc/protocol';

const CODES: Record<ErrorKind, number> = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  protocolVersionMismatch: -32000,
  frameTooLarge: -32001,
  shuttingDown: -32002,
  busy: -32003,
  timeout: -32004,
  uncertain: -32005,
  hostUnavailable: -32006,
  sessionNotFound: -32007,
  sessionBusy: -32008,
  notFound: -32009,
  outsideWorkspace: -32010,
  ioError: -32011,
};

/** An error with an AHP kind; thrown by request handlers and the Core bridge. */
export class AhpError extends Error {
  readonly kind: ErrorKind;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(
    kind: ErrorKind,
    message: string,
    options: { retryable?: boolean; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'AhpError';
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  /** The wire error object. */
  toErrorObject(): ErrorObject {
    return {
      code: CODES[this.kind],
      message: this.message,
      data: {
        kind: this.kind,
        retryable: this.retryable,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/** The kind named by a peer, or `internalError` for a kind this build does not know. */
export function errorKindOf(value: unknown): ErrorKind {
  return typeof value === 'string' && Object.hasOwn(CODES, value)
    ? (value as ErrorKind)
    : 'internalError';
}

/** Converts anything thrown by a handler into a wire error object. */
export function toErrorObject(error: unknown): ErrorObject {
  if (error instanceof AhpError) {
    return error.toErrorObject();
  }
  const message = error instanceof Error ? error.message : String(error);
  return new AhpError('internalError', message).toErrorObject();
}

/** A human-readable description of anything thrown. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
