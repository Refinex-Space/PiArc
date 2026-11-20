// Whether the Changes panel is in the dock (presentation state of the window, architecture
// section 8.3 rule 2): opened from the rail's changes card or with Mod+Shift+D, which also
// closes it.
import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();

/** Opens (`true`) or closes the Changes panel. */
export function openChangesPanel(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of [...listeners]) listener();
}

/** Opens a closed panel and closes an open one. */
export function toggleChangesPanel(): boolean {
  openChangesPanel(!open);
  return open;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useChangesPanelOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open);
}
