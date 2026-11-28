// Automatic fetch (design addendum H5): while the Git tool or its rail card is visible and the
// window is in front, a repository is fetched once its interval has passed since the last
// automatic fetch. Core runs it without any credential prompt and skips it while another
// operation holds the repository; a failure shows only on the Fetch button's tooltip.
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { useWindowFocused } from '../../app/window-focus.js';
import { gitCall, opResultOf, type Repository } from './protocol.js';
import { gitSession } from './state.js';

/** How often the condition is checked. */
const TICK_MS = 30_000;

/** The last automatic fetch of each repository root, and its failure. */
const last = new Map<string, { readonly at: number; readonly failure?: string | undefined }>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Why the last automatic fetch of `root` failed, if it did. */
export function useAutoFetchFailure(root: string | undefined): string | undefined {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return useSyncExternalStore(subscribe, () =>
    root === undefined ? undefined : last.get(root)?.failure,
  );
}

/** Fetches the session's repository every `minutes` (0: never) while `visible`. */
export function useAutoFetch(
  sessionId: string,
  repo: Repository | undefined,
  minutes: number,
  visible: boolean,
): void {
  const focused = useWindowFocused();
  const root = repo?.root;
  const ready =
    minutes > 0 &&
    visible &&
    focused &&
    repo !== undefined &&
    repo.writable &&
    repo.remotes.length > 0;
  useEffect(() => {
    if (!ready || root === undefined) return;
    const tick = () => {
      const previous = last.get(root);
      if (previous !== undefined && Date.now() - previous.at < minutes * 60_000) return;
      last.set(root, { at: Date.now(), failure: previous?.failure });
      void gitCall(sessionId, { op: 'fetch', background: true }, opResultOf).then((reply) => {
        last.set(root, {
          at: Date.now(),
          failure: reply.ok ? undefined : (reply.failure.message ?? reply.failure.kind),
        });
        notify();
        if (reply.ok && reply.value.skipped !== true) gitSession(sessionId).changed();
      });
    };
    tick();
    const timer = window.setInterval(tick, TICK_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [ready, root, minutes, sessionId]);
}
