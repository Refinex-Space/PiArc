// One tooltip per document. Any element with `data-tooltip` shows its text after a short hover
// or when it takes keyboard focus; `data-tooltip-keys` (a `Mod+Enter`-style binding) adds the
// shortcut's keycaps; `data-tooltip-side="below"` on it or an ancestor opens it below (controls
// under text they would otherwise cover). The element keeps its own accessible name, so the bubble is hidden from
// assistive technology. Moving between tooltipped controls within the warm window shows the next
// one at once. An anchor inside a modal dialog promotes the bubble into the popover top layer;
// a bubble portaled to the body would paint underneath the dialog.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useApp } from './app-context.js';
import { Keycaps } from './Keycaps.js';
import { useOverlayRect } from './overlays.js';
import { documentWindow, useSurfaceDocument } from './surface-document.js';

/** Hover time before a tooltip opens (ms). */
const OPEN_DELAY_MS = 300;
/** After a tooltip closes, the next one opens without delay for this long (ms). */
const WARM_MS = 400;
/** Distance from the anchor and from the viewport's edges (CSS px). */
const OFFSET = 6;
const EDGE = 8;

interface Tip {
  readonly text: string;
  readonly keys: string | undefined;
  readonly anchor: DOMRect;
  readonly below: boolean;
  /** The anchor sits in a modal dialog, which paints above anything portaled to the body. */
  readonly overlay: boolean;
}

/** The tooltipped element at the target, checked against the realm of the document it is in. */
function tooltipOf(
  view: Window & typeof globalThis,
  target: EventTarget | null,
): HTMLElement | null {
  return target instanceof view.Element ? target.closest<HTMLElement>('[data-tooltip]') : null;
}

export function TooltipLayer() {
  const { keyPlatform } = useApp();
  // The workbench, or a native tool window that paints part of the same tree.
  const doc = useSurfaceDocument();
  const [tip, setTip] = useState<Tip>();
  const bubble = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>();
  // A tooltip over the preview's page would be hidden behind it (B1.5.2).
  useOverlayRect(bubble, tip !== undefined);
  useEffect(() => {
    const view = documentWindow(doc);
    let current: HTMLElement | null = null;
    let timer: number | undefined;
    let warmUntil = 0;
    const hide = () => {
      view.clearTimeout(timer);
      if (current !== null) warmUntil = performance.now() + WARM_MS;
      current = null;
      setTip(undefined);
    };
    const show = (element: HTMLElement) => {
      const text = element.dataset.tooltip ?? '';
      if (text === '' || !element.isConnected) return;
      setTip({
        text,
        keys: element.dataset.tooltipKeys,
        anchor: element.getBoundingClientRect(),
        below: element.closest<HTMLElement>('[data-tooltip-side]')?.dataset.tooltipSide === 'below',
        overlay: element.closest('dialog') !== null,
      });
    };
    const arm = (element: HTMLElement, immediate: boolean) => {
      if (element === current) return;
      hide();
      current = element;
      const delay = immediate || performance.now() < warmUntil ? 0 : OPEN_DELAY_MS;
      timer = view.setTimeout(() => {
        show(element);
      }, delay);
    };
    const over = (event: PointerEvent) => {
      const element = tooltipOf(view, event.target);
      if (element === null) {
        if (current !== null) hide();
        return;
      }
      arm(element, false);
    };
    const focus = (event: FocusEvent) => {
      const element = tooltipOf(view, event.target);
      if (element?.matches(':focus-visible') === true) arm(element, false);
    };
    const blur = (event: FocusEvent) => {
      if (tooltipOf(view, event.target) === current) hide();
    };
    const leave = () => {
      hide();
    };
    doc.addEventListener('pointerover', over, true);
    doc.addEventListener('focusin', focus, true);
    doc.addEventListener('focusout', blur, true);
    doc.addEventListener('pointerdown', leave, true);
    doc.addEventListener('keydown', leave, true);
    doc.addEventListener('scroll', leave, true);
    doc.documentElement.addEventListener('pointerleave', leave);
    view.addEventListener('blur', leave);
    return () => {
      view.clearTimeout(timer);
      doc.removeEventListener('pointerover', over, true);
      doc.removeEventListener('focusin', focus, true);
      doc.removeEventListener('focusout', blur, true);
      doc.removeEventListener('pointerdown', leave, true);
      doc.removeEventListener('keydown', leave, true);
      doc.removeEventListener('scroll', leave, true);
      doc.documentElement.removeEventListener('pointerleave', leave);
      view.removeEventListener('blur', leave);
    };
  }, [doc]);
  // Above the anchor (below when asked), centred; on the other side when there is no room; kept
  // inside the viewport.
  useLayoutEffect(() => {
    const node = bubble.current;
    if (tip === undefined || node === null) {
      setPlace(undefined);
      return;
    }
    // A modal dialog is in the top layer. Join it, or the bubble paints underneath the dialog.
    if (
      tip.overlay &&
      node.popover === 'manual' &&
      !node.matches(':popover-open') &&
      typeof node.showPopover === 'function'
    ) {
      node.showPopover();
    }
    const { width, height } = node.getBoundingClientRect();
    const { anchor } = tip;
    const view = documentWindow(doc);
    const above = anchor.top - OFFSET - height;
    const below = anchor.bottom + OFFSET;
    const fitsAbove = above >= EDGE;
    const fitsBelow = below + height <= view.innerHeight - EDGE;
    const top = tip.below ? (fitsBelow || !fitsAbove ? below : above) : fitsAbove ? above : below;
    const centred = anchor.left + anchor.width / 2 - width / 2;
    const left = Math.min(Math.max(EDGE, centred), view.innerWidth - EDGE - width);
    setPlace({ left, top });
  }, [tip, doc]);
  if (tip === undefined) return null;
  return createPortal(
    <div
      ref={bubble}
      className="tooltip"
      popover={tip.overlay ? 'manual' : undefined}
      aria-hidden="true"
      data-placed={place !== undefined}
      style={place === undefined ? undefined : { left: place.left, top: place.top }}
    >
      <span className="tooltip-text">{tip.text}</span>
      {tip.keys === undefined ? null : <Keycaps binding={tip.keys} platform={keyPlatform} />}
    </div>,
    doc.body,
  );
}
