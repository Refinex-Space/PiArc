// What a handler's error becomes on its way to the page: a Core error keeps its kind in the
// message (Electron's `invoke` keeps only the message; the page reads it back, I236).
import { coreErrorKind, encodeIpcError } from '../../shared/ipc-error.js';

/** `error`, with a Core error's kind written into its message for the page. */
export function forPage(error: unknown): unknown {
  const kind = coreErrorKind(error);
  return kind === undefined || !(error instanceof Error)
    ? error
    : new Error(encodeIpcError(kind, error.message));
}

/** Runs `handler`, passing on what it returns and rethrowing its errors `forPage`. */
export function answer(handler: () => unknown): unknown {
  let result: unknown;
  try {
    result = handler();
  } catch (error) {
    throw forPage(error);
  }
  return result instanceof Promise
    ? result.catch((error: unknown) => {
        throw forPage(error);
      })
    : result;
}
