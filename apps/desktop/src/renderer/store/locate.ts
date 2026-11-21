// Where a session should scroll to when it shows (T35: a search result names an entry). The
// request waits here until the session's view takes it; presentation state, kept per window.
type Listener = () => void;

const requests = new Map<string, { readonly entryId: string; readonly nonce: number }>();
const listeners = new Set<Listener>();
let nonce = 0;

/** Asks session `sessionId`'s view to show entry `entryId`. */
export function requestLocate(sessionId: string, entryId: string): void {
  nonce += 1;
  requests.set(sessionId, { entryId, nonce });
  for (const listener of [...listeners]) listener();
}

/** Takes the request for `sessionId`, if any. */
export function takeLocate(sessionId: string): { entryId: string; nonce: number } | undefined {
  const request = requests.get(sessionId);
  requests.delete(sessionId);
  return request;
}

export function onLocate(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether row `rowId` shows entry `entryId`: history rows are keyed by the entry id (a user
 * message) or `<entry id>#<n>` (a part of an agent reply).
 */
export function rowShowsEntry(rowId: string, entryId: string): boolean {
  return rowId === entryId || rowId.startsWith(`${entryId}#`);
}
