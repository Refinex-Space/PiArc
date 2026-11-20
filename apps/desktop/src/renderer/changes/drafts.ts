// Text waiting for a session's input box (T28): "branch from here" opens the new session with the
// chosen message in its input, the way a rewind gives the message back.

const pending = new Map<string, string>();

/** `text` goes into session `sessionId`'s input when its conversation shows. */
export function setDraft(sessionId: string, text: string): void {
  pending.set(sessionId, text);
}

/** The text waiting for `sessionId`'s input, once. */
export function takeDraft(sessionId: string): string | undefined {
  const text = pending.get(sessionId);
  pending.delete(sessionId);
  return text;
}
