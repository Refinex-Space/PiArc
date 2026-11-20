// React bindings of the store: every hook subscribes to exactly the part it reads
// (`useSyncExternalStore`), so a change re-renders only the components that show it.
import type { BranchPoint, ContextUsage } from '@piarc/protocol';
import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react';

import type { AppStore, Notice } from './app-store.js';
import type { ChangesState } from './changes.js';
import type { HarnessSnapshot } from './harness.js';
import type { SessionEntry, WorkspaceEntry } from './snapshots.js';
import type { QueuedInput, TranscriptRow, TurnInfo } from './transcript.js';

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
  return useSessionOf(useStore(), id);
}

/** `useSession` for the component that owns the store (the window shell). */
export function useSessionOf(store: AppStore, id: string | undefined): SessionEntry | undefined {
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

/** The running turn of a session (the working row, the composer's keys). */
export function useTurnInfo(sessionId: string): TurnInfo {
  const transcript = useStore().transcript(sessionId);
  const subscribe = useCallback((l: () => void) => transcript.subscribeState(l), [transcript]);
  return useSyncExternalStore(
    subscribe,
    useCallback(() => transcript.turnInfo(), [transcript]),
  );
}

/** Whether the session's persisted conversation must be loaded again (`session/resync`). */
export function useNeedsReload(sessionId: string): boolean {
  const transcript = useStore().transcript(sessionId);
  const subscribe = useCallback((l: () => void) => transcript.subscribeState(l), [transcript]);
  return useSyncExternalStore(
    subscribe,
    useCallback(() => transcript.needsReload(), [transcript]),
  );
}

/** The session's plan and task list (T26). */
export function useHarness(sessionId: string | undefined): HarnessSnapshot | undefined {
  return useHarnessOf(useStore(), sessionId);
}

/** `useHarness` for the component that owns the store (the window shell). */
export function useHarnessOf(
  store: AppStore,
  sessionId: string | undefined,
): HarnessSnapshot | undefined {
  const harness = sessionId === undefined ? undefined : store.transcript(sessionId).harness;
  const subscribe = useCallback(
    (l: () => void) => harness?.subscribe(l) ?? (() => undefined),
    [harness],
  );
  return useSyncExternalStore(
    subscribe,
    useCallback(() => harness?.state(), [harness]),
  );
}

/** The session's context usage (T27); asks Core for it the first time the session shows. */
export function useContextUsage(sessionId: string | undefined): ContextUsage | undefined {
  const store = useStore();
  const usage = sessionId === undefined ? undefined : store.transcript(sessionId).usage;
  useEffect(() => {
    if (usage !== undefined && sessionId !== undefined) {
      usage.request(() => window.piarc.contextUsage(sessionId));
    }
  }, [usage, sessionId]);
  const subscribe = useCallback(
    (l: () => void) => usage?.subscribe(l) ?? (() => undefined),
    [usage],
  );
  return useSyncExternalStore(
    subscribe,
    useCallback(() => usage?.state(), [usage]),
  );
}

/** The session's queued inputs. */
export function useQueue(sessionId: string): readonly QueuedInput[] {
  const transcript = useStore().transcript(sessionId);
  const subscribe = useCallback((l: () => void) => transcript.subscribeQueue(l), [transcript]);
  return useSyncExternalStore(
    subscribe,
    useCallback(() => transcript.queue(), [transcript]),
  );
}

/** The session's branch points (T28). */
export function useBranches(sessionId: string | undefined): readonly BranchPoint[] {
  const store = useStore();
  const branches = sessionId === undefined ? undefined : store.transcript(sessionId).branches;
  const subscribe = useCallback(
    (l: () => void) => branches?.subscribe(l) ?? (() => undefined),
    [branches],
  );
  return useSyncExternalStore(
    subscribe,
    useCallback(() => branches?.state() ?? NO_BRANCHES, [branches]),
  );
}

const NO_BRANCHES: readonly BranchPoint[] = [];

/**
 * The session's changes (T28): asked for when first shown, again when a turn ends and when the
 * conversation moves to another branch.
 */
export function useChanges(sessionId: string | undefined): ChangesState | undefined {
  const store = useStore();
  const transcript = sessionId === undefined ? undefined : store.transcript(sessionId);
  const changes = transcript?.changes;
  useEffect(() => {
    if (transcript === undefined || sessionId === undefined) return;
    const fetch = () => window.piarc.sessionChanges(sessionId);
    if (changes?.state().view === undefined) void changes?.refresh(fetch);
    let running = transcript.turnInfo().running;
    let reload = transcript.needsReload();
    return transcript.subscribeState(() => {
      const now = transcript.turnInfo().running;
      const again = transcript.needsReload();
      if ((running && !now) || (!reload && again)) void changes?.refresh(fetch);
      running = now;
      reload = again;
    });
  }, [transcript, changes, sessionId]);
  const subscribe = useCallback(
    (l: () => void) => changes?.subscribe(l) ?? (() => undefined),
    [changes],
  );
  return useSyncExternalStore(
    subscribe,
    useCallback(() => changes?.state(), [changes]),
  );
}
