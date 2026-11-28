// A panel's layout decides whether it is on screen. Chromium's intersection reports can
// transiently go empty when a native PDF view or an editor changes its composited surface.
import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import { useSurfaceDocument } from '../app/surface-document.js';
import { isWindowVisible, onWindowVisibility } from '../app/window-visibility.js';
import { useToolVisible } from '../shell/ToolHeaderSlot.js';

export function useFileSurfaceVisible(active: boolean) {
  const doc = useSurfaceDocument(),
    placed = useToolVisible();
  const subscribe = useCallback(
    (notify: () => void) => {
      doc.addEventListener('visibilitychange', notify);
      const stop = onWindowVisibility(notify);
      return () => {
        stop();
        doc.removeEventListener('visibilitychange', notify);
      };
    },
    [doc],
  );
  const shown = useSyncExternalStore(
    subscribe,
    () =>
      !doc.hidden &&
      (doc === document
        ? isWindowVisible()
        : !doc.documentElement.hasAttribute('data-tool-hidden')),
  );
  return active && placed && shown;
}
export function VisibleFilePreview({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  const painted = useFileSurfaceVisible(visible);
  return <div className="file-preview-surface">{painted ? children : null}</div>;
}
