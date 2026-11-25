// A Core error crossing IPC. Core's errors reach the main process with their kind
// (`data.kind`, the `ErrorObject` shape), but Electron's `invoke` keeps only an error's message.
// The main process writes the kind in front of the message, and the renderer reads it back to
// describe the error in the window's language (I236).

/** The kind of a Core error and its own (English) text. */
export interface IpcError {
  readonly kind: string;
  readonly message: string;
}

const KIND = /^\[piarc:([A-Za-z]{1,64})\] /u;

/** The message the main process throws for a Core error of `kind`. */
export function encodeIpcError(kind: string, message: string): string {
  return `[piarc:${kind}] ${message}`;
}

/** The kind and text in `message`, when it came from `encodeIpcError`. */
export function decodeIpcError(message: string): IpcError | undefined {
  const match = KIND.exec(message);
  const kind = match?.[1];
  return match === null || kind === undefined
    ? undefined
    : { kind, message: message.slice(match[0].length) };
}

/** The kind of a Core error as the NAPI boundary throws it (`data.kind`), if `error` is one. */
export function coreErrorKind(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('data' in error)) return undefined;
  const { data } = error;
  if (typeof data !== 'object' || data === null || !('kind' in data)) return undefined;
  return typeof data.kind === 'string' && /^[A-Za-z]{1,64}$/u.test(data.kind)
    ? data.kind
    : undefined;
}
