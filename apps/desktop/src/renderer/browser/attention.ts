// The dot on the preview tool button (design addendum B4.4, B4.5): a local service of the
// session started listening, or one of its development servers failed, while its preview was
// not on screen. Showing the preview clears it. Window-local state.
import { useSyncExternalStore } from 'react';

const marked = new Set<string>();
/** Preview panels on screen, per session. */
const showing = new Map<string, number>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of [...listeners]) listener();
}

/** Something new for session `sessionId`'s preview: dot unless the preview is on screen. */
export function markPreview(sessionId: string): void {
  if ((showing.get(sessionId) ?? 0) > 0 || marked.has(sessionId)) return;
  marked.add(sessionId);
  changed();
}

/** The preview of `sessionId` is on screen until the returned function runs. */
export function showPreview(sessionId: string): () => void {
  showing.set(sessionId, (showing.get(sessionId) ?? 0) + 1);
  if (marked.delete(sessionId)) changed();
  return () => {
    const left = (showing.get(sessionId) ?? 1) - 1;
    if (left <= 0) showing.delete(sessionId);
    else showing.set(sessionId, left);
  };
}

/** Whether session `sessionId`'s preview button shows the dot. */
export function previewMarked(sessionId: string): boolean {
  return marked.has(sessionId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePreviewDot(sessionId: string | undefined): boolean {
  return useSyncExternalStore(subscribe, () =>
    sessionId === undefined ? false : marked.has(sessionId),
  );
}
