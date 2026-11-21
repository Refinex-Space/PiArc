// Slash commands chosen outside a session's composer (the Mod+K palette, T37): the session's
// conversation runs a built-in command or puts `/name ` in its input. A request made before the
// conversation is shown waits until it takes it.
type Listener = (sessionId: string) => void;

const pending = new Map<string, string>();
const listeners = new Set<Listener>();

/** Asks `sessionId`'s conversation to run slash command `name`. */
export function requestCommand(sessionId: string, name: string): void {
  pending.set(sessionId, name);
  for (const listener of listeners) listener(sessionId);
}

/** The command waiting for `sessionId`, taken. */
export function takeCommand(sessionId: string): string | undefined {
  const name = pending.get(sessionId);
  pending.delete(sessionId);
  return name;
}

/** Calls `listener` with the session id of each new request; returns the unsubscribe. */
export function onCommandRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
