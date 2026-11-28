// One window's view of the update flow (ADR-0111): the workbench subscribes to `core/updates`
// once (the preload keeps one listener per route), and the About page and the sidebar notice
// read the same snapshot.
import type { UpdateStatus } from '@piarc/protocol';
import { useSyncExternalStore } from 'react';

import { lastStatusOf, parseUpdateStatus } from './update-status.js';

export const UPDATES_ROUTE = 'core/updates';

let current: UpdateStatus | undefined;
const listeners = new Set<() => void>();

function publish(next: UpdateStatus | undefined): void {
  if (next === undefined) return;
  current = next;
  for (const listener of listeners) listener();
}

/** Takes a snapshot that a command answered (`checkForUpdates` and the like). */
export function takeUpdateStatus(json: string): UpdateStatus | undefined {
  const status = parseUpdateStatus(json);
  publish(status);
  return status;
}

/**
 * Follows `core/updates` and reads the current snapshot; answers the function that stops.
 * The workbench calls it once.
 */
export function followUpdates(): () => void {
  let stopped = false;
  window.piarc
    .subscribeEvents(UPDATES_ROUTE, (batch) => {
      publish(lastStatusOf(batch.payload));
    })
    .catch(() => {
      // The About page still reads the status when it opens.
    });
  window.piarc.updateStatus().then(
    (json) => {
      if (!stopped) takeUpdateStatus(json);
    },
    () => undefined,
  );
  return () => {
    stopped = true;
    void window.piarc.unsubscribeEvents(UPDATES_ROUTE);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The latest snapshot, or `undefined` before the first one arrives. */
export function useUpdateStatus(): UpdateStatus | undefined {
  return useSyncExternalStore(subscribe, () => current);
}

/** Tests: forget the snapshot. */
export function resetUpdateStatus(): void {
  current = undefined;
  for (const listener of listeners) listener();
}
