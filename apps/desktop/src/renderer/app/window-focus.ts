// Whether this window is the one in front, as the main process reports it (app events of type
// `focus`, and `focused` in the app state at start). Sessions are marked read and reminders
// skipped only while the window is really in front.
import { useSyncExternalStore } from 'react';

let focused = false;
const listeners = new Set<() => void>();

export function setWindowFocused(value: boolean): void {
  if (value === focused) {
    return;
  }
  focused = value;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function isWindowFocused(): boolean {
  return focused;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders when the window comes to the front or leaves it. */
export function useWindowFocused(): boolean {
  return useSyncExternalStore(subscribe, isWindowFocused);
}
