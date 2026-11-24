// Embedded documents have independent media decoders or a script context. Release their mount
// while the tab, tile, or owning native window is hidden, retaining the tab's editor model.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { documentWindow, useSurfaceDocument } from '../app/surface-document.js';
import { isWindowVisible, onWindowVisibility } from '../app/window-visibility.js';

export function VisibleFilePreview({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  const node = useRef<HTMLDivElement>(null),
    doc = useSurfaceDocument();
  const [painted, setPainted] = useState(false);
  useLayoutEffect(() => {
    const host = node.current;
    if (!host || !visible) {
      setPainted(false);
      return;
    }
    const win = documentWindow(doc);
    let included = host.getClientRects().length > 0;
    const update = () => {
      const shown =
        win === window ? isWindowVisible() : !doc.documentElement.hasAttribute('data-tool-hidden');
      setPainted(included && !doc.hidden && shown);
    };
    update();
    const observer = new win.IntersectionObserver((entries) => {
      included = entries.at(-1)?.isIntersecting ?? false;
      update();
    });
    observer.observe(host);
    const stop = onWindowVisibility(update);
    doc.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      stop();
      doc.removeEventListener('visibilitychange', update);
    };
  }, [doc, visible]);
  return (
    <div className="file-preview-surface" ref={node}>
      {visible && painted ? children : null}
    </div>
  );
}
