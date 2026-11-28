// Whether this window can be seen, as the main process reports it (app events of type
// `visibility`: minimized or hidden windows are not). Chromium does not always mark the page
// hidden for a minimized window (T34 measured animation frames running on macOS), so views
// that pull work per frame, the terminal's, also stop on this.
let visible = true;
const listeners = new Set<() => void>();

export function setWindowVisible(value: boolean): void {
  if (value === visible) return;
  visible = value;
  for (const listener of [...listeners]) listener();
}

export function isWindowVisible(): boolean {
  return visible;
}

/** Calls `listener` when the window is minimized, hidden, restored or shown. */
export function onWindowVisibility(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
