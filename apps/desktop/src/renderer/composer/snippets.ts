// Text other parts of the window attach to a session's message (T34: the terminal panel's
// "Add selection to message"). A snippet waits here until the session's composer takes it,
// then shows as a chip; the message carries its text (serialize.ts).
import type { SnippetData } from './schema.js';

const pending = new Map<string, SnippetData[]>();
const listeners = new Map<string, Set<() => void>>();

/** Queues `snippet` for the composer of session `sessionId`. */
export function attachSnippet(sessionId: string, snippet: SnippetData): void {
  pending.set(sessionId, [...(pending.get(sessionId) ?? []), snippet]);
  for (const listener of [...(listeners.get(sessionId) ?? [])]) listener();
}

/** Takes the snippets waiting for session `sessionId`. */
export function takeSnippets(sessionId: string): readonly SnippetData[] {
  const list = pending.get(sessionId) ?? [];
  pending.delete(sessionId);
  return list;
}

/** Calls `listener` when a snippet arrives for session `sessionId`; returns the unsubscriber. */
export function onSnippet(sessionId: string, listener: () => void): () => void {
  const set = listeners.get(sessionId) ?? new Set();
  set.add(listener);
  listeners.set(sessionId, set);
  return () => {
    set.delete(listener);
  };
}
