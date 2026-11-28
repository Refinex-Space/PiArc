// The text of a failed `window.piarc` call for the user, in the window's language (I236).
import { describeError, errorKindOf } from '../app/error-text.js';

/** The message of `error`, without the prefix `ipcRenderer.invoke` adds. */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // `ipcRenderer.invoke` prefixes "Error invoking remote method '<channel>': Error: ".
  return text.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/u, '');
}

/** The reason of `error` for the user: a Core error by its kind, anything else as written. */
export function reason(error: unknown): string {
  return describeError(messageOf(error));
}

/** The Core error kind of a failed call (`sessionBusy`, `cancelled`…), if it was one. */
export function failureKind(error: unknown): string | undefined {
  return errorKindOf(messageOf(error));
}
