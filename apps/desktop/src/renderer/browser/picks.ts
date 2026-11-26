// The tray of picked elements per session (B3.1): cards wait here across panel re-renders and
// tool moves until the user adds them to the conversation or clears them. Cards come only from
// the main process's `browserPick` events (a real click, or the page menu), never from the page.
import { useSyncExternalStore } from 'react';

import { BROWSER_CONTEXT_LIMITS, type BrowserPick } from '../../shared/browser.js';

export interface TrayCard {
  readonly pick: BrowserPick;
  readonly comment: string;
}

const EMPTY: readonly TrayCard[] = [];
const trays = new Map<string, readonly TrayCard[]>();
const listeners = new Set<() => void>();

function set(sessionId: string, cards: readonly TrayCard[]): void {
  if (cards.length === 0) trays.delete(sessionId);
  else trays.set(sessionId, cards);
  for (const listener of [...listeners]) listener();
}

/** Adds a card; false when the tray is full. */
export function addPick(sessionId: string, pick: BrowserPick): boolean {
  const cards = trays.get(sessionId) ?? EMPTY;
  if (cards.length >= BROWSER_CONTEXT_LIMITS.picks) return false;
  if (cards.some((card) => card.pick.id === pick.id)) return true;
  set(sessionId, [...cards, { pick, comment: '' }]);
  return true;
}

export function setPickComment(sessionId: string, id: string, comment: string): void {
  const cards = trays.get(sessionId) ?? EMPTY;
  set(
    sessionId,
    cards.map((card) =>
      card.pick.id === id
        ? { ...card, comment: comment.slice(0, BROWSER_CONTEXT_LIMITS.comment) }
        : card,
    ),
  );
}

export function removePick(sessionId: string, id: string): void {
  set(
    sessionId,
    (trays.get(sessionId) ?? EMPTY).filter((card) => card.pick.id !== id),
  );
}

export function clearPicks(sessionId: string): void {
  set(sessionId, EMPTY);
}

export function picksOf(sessionId: string): readonly TrayCard[] {
  return trays.get(sessionId) ?? EMPTY;
}

/** The session's cards, re-rendering on change. */
export function usePicks(sessionId: string): readonly TrayCard[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => picksOf(sessionId),
  );
}
