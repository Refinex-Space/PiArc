// The transcript's three views (architecture section 8.2, T29): normal shows tool calls as
// collapsed summaries and no thinking; thinking adds the thinking blocks (collapsed once done);
// detailed expands everything and shows the system reminders the model received (T27's
// `reminder` items). A Monitor's output (T32) shows in every view: it can wake the session, and
// the transcript tells what the model heard. The choice is presentation state, kept per session
// in this window only.
import { createContext, useContext, useSyncExternalStore } from 'react';

import type { TranscriptRow } from '../store/transcript.js';

export type TranscriptDetail = 'normal' | 'thinking' | 'detailed';

export const TRANSCRIPT_DETAILS: readonly TranscriptDetail[] = ['normal', 'thinking', 'detailed'];

/** The view where no session chose one: the transcript as it was before T29. */
export const DEFAULT_DETAIL: TranscriptDetail = 'thinking';

export const DetailContext = createContext<TranscriptDetail>(DEFAULT_DETAIL);

export function useDetail(): TranscriptDetail {
  return useContext(DetailContext);
}

/** Whether `row` is shown in `detail`. */
export function shownIn(row: TranscriptRow | undefined, detail: TranscriptDetail): boolean {
  if (row?.kind !== 'item') return true;
  switch (row.item.type) {
    case 'reminder':
      return detail === 'detailed' || row.item.reminders.some((r) => r.type === 'monitorOutput');
    case 'reasoning':
      return detail !== 'normal';
    default:
      return true;
  }
}

const chosen = new Map<string, TranscriptDetail>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSessionDetail(id: string): TranscriptDetail {
  return useSyncExternalStore(subscribe, () => detailOf(id));
}

/** The view session `id` uses in this window. */
export function detailOf(id: string): TranscriptDetail {
  return chosen.get(id) ?? DEFAULT_DETAIL;
}

export function chooseDetail(id: string, detail: TranscriptDetail): void {
  chosen.set(id, detail);
  for (const listener of listeners) listener();
}
