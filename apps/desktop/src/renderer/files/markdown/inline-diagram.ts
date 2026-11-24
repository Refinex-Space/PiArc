// In the reading pane the wheel normally scrolls the document. A modified wheel or a
// trackpad pinch magnifies only this drawing. Its layout box remains unchanged.
import { useEffect, useRef, type RefObject } from 'react';
import { useSurfaceDocument } from '../../app/surface-document.js';
export function useInlineDiagram(
  viewport: RefObject<HTMLSpanElement | null>,
  enabled: boolean,
  src: string,
) {
  const doc = useSurfaceDocument(),
    zoom = useRef(1);
  useEffect(() => {
    const node = viewport.current,
      img = node?.querySelector('img');
    if (!enabled || !node || !img) return;
    let x = 0,
      y = 0,
      z = 1,
      drag: { id: number; x: number; y: number } | undefined;
    const apply = () => {
      const w = node.clientWidth,
        h = node.clientHeight;
      x = Math.min(0, Math.max((1 - z) * w, x));
      y = Math.min(0, Math.max((1 - z) * h, y));
      img.style.transform =
        z === 1
          ? ''
          : 'translate(' + String(x) + 'px, ' + String(y) + 'px) scale(' + String(z) + ')';
      zoom.current = z;
      node.dataset.inlineZoom = String(z);
    };
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.deltaY) return;
      e.preventDefault();
      const r = node.getBoundingClientRect(),
        px = e.clientX - r.left,
        py = e.clientY - r.top;
      const dz = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1),
        next = Math.max(1, Math.min(16, z * Math.exp(-Math.max(-400, Math.min(400, dz)) / 300)));
      x = px - ((px - x) * next) / z;
      y = py - ((py - y) * next) / z;
      z = next;
      apply();
    };
    const down = (e: PointerEvent) => {
      if (
        e.button !== 0 ||
        z === 1 ||
        !(e.target instanceof (doc.defaultView ?? window).Element) ||
        e.target.closest('.md-media-expand')
      )
        return;
      e.preventDefault();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      node.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (drag?.id !== e.pointerId) return;
      x += e.clientX - drag.x;
      y += e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      apply();
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId === drag?.id) drag = undefined;
    };
    const reset = (e: MouseEvent) => {
      if (z === 1) return;
      e.preventDefault();
      z = 1;
      x = y = 0;
      apply();
    };
    node.addEventListener('wheel', wheel, { passive: false });
    node.addEventListener('pointerdown', down);
    node.addEventListener('pointermove', move);
    node.addEventListener('lostpointercapture', end);
    node.addEventListener('dblclick', reset);
    return () => {
      node.removeEventListener('wheel', wheel);
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('lostpointercapture', end);
      node.removeEventListener('dblclick', reset);
      img.style.transform = '';
      delete node.dataset.inlineZoom;
      zoom.current = 1;
    };
  }, [enabled, viewport, src, doc]);
  return zoom;
}
