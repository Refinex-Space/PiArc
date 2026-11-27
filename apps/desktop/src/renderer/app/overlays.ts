// Floating elements that may cover a native view (design addendum B1.5.2): the preview's page is
// drawn above all DOM, so menus, tooltips and popovers register here while they are shown and
// the preview hides its page (showing a still frame) when one meets its viewport. Registration
// is exact for small overlays a sampling check can miss; the preview still samples as well.
import { useLayoutEffect, type RefObject } from 'react';

const overlays = new Set<Element>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of [...listeners]) listener();
}

/** Registers `element` as a floating overlay until the returned function is called. */
export function registerOverlay(element: Element): () => void {
  overlays.add(element);
  changed();
  return () => {
    if (overlays.delete(element)) changed();
  };
}

/** The registered overlays now. */
export function registeredOverlays(): readonly Element[] {
  return [...overlays];
}

/** Calls `listener` when an overlay comes or goes; returns the unsubscriber. */
export function onOverlaysChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Registers the element of `ref` while the component is mounted and `active`. */
export function useOverlayRect(ref: RefObject<Element | null>, active = true): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || element === null) return undefined;
    return registerOverlay(element);
  }, [ref, active]);
}

/** Whether two rectangles share an area (touching edges do not count). */
export function intersects(
  a: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  },
  b: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  },
): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
