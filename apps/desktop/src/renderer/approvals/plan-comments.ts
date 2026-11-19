// The user's inline comments on a plan waiting for review (T26), per approval request: the plan
// panel adds and removes them, the plan card sends them with "Keep planning". They are drafts of
// this window only; Core receives them with the answer. Offsets count UTF-16 code units of the
// plan text (architecture section 7.7), which is how JavaScript strings index.
import { useCallback, useSyncExternalStore } from 'react';

export interface DraftComment {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
  readonly text: string;
}

const NONE: readonly DraftComment[] = [];

export class PlanComments {
  private readonly byRequest = new Map<string, readonly DraftComment[]>();
  private readonly listeners = new Set<() => void>();

  get(requestId: string): readonly DraftComment[] {
    return this.byRequest.get(requestId) ?? NONE;
  }

  /** Adds a comment on `plan[start..end]`; false when it overlaps one already there. */
  add(requestId: string, plan: string, start: number, end: number, text: string): boolean {
    const current = this.get(requestId);
    if (start >= end || end > plan.length || !text.trim()) return false;
    if (current.some((c) => start < c.end && c.start < end)) return false;
    const comment = {
      id: crypto.randomUUID(),
      start,
      end,
      quote: plan.slice(start, end),
      text: text.trim(),
    };
    this.set(
      requestId,
      [...current, comment].sort((a, b) => a.start - b.start),
    );
    return true;
  }

  remove(requestId: string, id: string): void {
    this.set(
      requestId,
      this.get(requestId).filter((c) => c.id !== id),
    );
  }

  clear(requestId: string): void {
    this.set(requestId, NONE);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(requestId: string, comments: readonly DraftComment[]): void {
    if (comments.length === 0) this.byRequest.delete(requestId);
    else this.byRequest.set(requestId, comments);
    for (const listener of [...this.listeners]) listener();
  }
}

/** The window's comment drafts. */
export const planComments = new PlanComments();

export function usePlanComments(requestId: string | undefined): readonly DraftComment[] {
  const subscribe = useCallback((l: () => void) => planComments.subscribe(l), []);
  return useSyncExternalStore(
    subscribe,
    useCallback(() => (requestId === undefined ? NONE : planComments.get(requestId)), [requestId]),
  );
}
