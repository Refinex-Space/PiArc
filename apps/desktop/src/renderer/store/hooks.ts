// React bindings of the store: every hook subscribes to exactly the part it reads
// (`useSyncExternalStore`), so a change re-renders only the components that show it.
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

import type { AppStore, Notice } from './app-store.js';
import type { SessionEntry, WorkspaceEntry } from './snapshots.js';
import type { TranscriptRow } from './transcript.js';

export const StoreContext = createContext<AppStore | null>(null);

export function useStore(): AppStore {
  const store = useContext(StoreContext);
  if (store === null) {
    throw new Error('useStore outside StoreContext');
  }
  return store;
}

export function useWorkspaces(): readonly WorkspaceEntry[] {
  const store = useStore();
  return useSyncExternalStore(store.subscribeWorkspaces, store.workspaces);
}

export function useSessions(): readonly SessionEntry[] {
  const store = useStore();
  return useSyncExternalStore(store.subscribeSessions, store.sessions);
}

export function useNotices(): readonly Notice[] {
  const store = useStore();
  return useSyncExternalStore(store.subscribeNotices, store.notices);
}

/** One session's entry: re-renders only when that entry changes. */
export function useSession(id: string | undefined): SessionEntry | undefined {
  const store = useStore();
  const subscribe = useCallback(
    (listener: () => void) =>
      id === undefined ? () => undefined : store.subscribeSession(id, listener),
    [store, id],
  );
  const read = useCallback(() => (id === undefined ? undefined : store.session(id)), [store, id]);
  return useSyncExternalStore(subscribe, read);
}

/** The row ids of a session's transcript: re-renders when rows are added or removed. */
export function useRowIds(sessionId: string): readonly string[] {
  const transcript = useStore().transcript(sessionId);
  const subscribe = useCallback((l: () => void) => transcript.subscribeList(l), [transcript]);
  const read = useCallback(() => transcript.rowIds(), [transcript]);
  return useSyncExternalStore(subscribe, read);
}

/** One transcript row: re-renders only when that row changes. */
export function useRow(sessionId: string, rowId: string): TranscriptRow | undefined {
  const transcript = useStore().transcript(sessionId);
  const subscribe = useCallback(
    (l: () => void) => transcript.subscribeRow(rowId, l),
    [transcript, rowId],
  );
  const read = useCallback(() => transcript.row(rowId), [transcript, rowId]);
  return useSyncExternalStore(subscribe, read);
}

/** Whether a turn runs and why the last one failed. */
export function useTurnState(sessionId: string): { running: boolean; error: string | undefined } {
  const transcript = useStore().transcript(sessionId);
  const subscribe = useCallback((l: () => void) => transcript.subscribeState(l), [transcript]);
  const running = useSyncExternalStore(
    subscribe,
    useCallback(() => transcript.isRunning(), [transcript]),
  );
  const error = useSyncExternalStore(
    subscribe,
    useCallback(() => transcript.lastError(), [transcript]),
  );
  return { running, error };
}
