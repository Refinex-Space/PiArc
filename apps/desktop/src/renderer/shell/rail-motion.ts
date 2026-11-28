// Motion of the session rail: showing and hiding (the rail and each card's body) and moving cards.
// A held card follows the pointer while the others make room; the dropped card glides into its
// slot. All motion is CSS transitions, so the reduced-motion rule (durations 0) finishes it at once.
import { useLayoutEffect, useState, type RefObject } from 'react';

/** A card's place in the column, in the scroll content's coordinates. */
export interface Slot {
  readonly id: string;
  readonly top: number;
  readonly height: number;
}

/**
 * The slot the held card takes when its top is at `top`: it passes a card above once its top
 * edge rises past that card's middle, and a card below once its bottom edge sinks past that
 * card's middle, so tall and short cards both move where the pointer carries their edge.
 */
export function dropIndex(slots: readonly Slot[], from: number, top: number): number {
  const held = slots[from];
  if (!held) return from;
  const bottom = top + held.height;
  let index = from;
  slots.forEach((slot, i) => {
    const middle = slot.top + slot.height / 2;
    if (i < from && top < middle) index--;
    else if (i > from && bottom > middle) index++;
  });
  return index;
}

/** How far card `i` moves aside while card `from` is held over slot `to`. */
export function shiftOf(i: number, from: number, to: number, distance: number): number {
  if (i === from) return 0;
  if (from < to && i > from && i <= to) return -distance;
  if (to < from && i >= to && i < from) return distance;
  return 0;
}

/** The top of card `from` once it sits in slot `to` (the others moved aside). */
export function landingTop(slots: readonly Slot[], from: number, to: number): number {
  const held = slots[from];
  const target = slots[to];
  if (!held || !target || to === from) return held?.top ?? 0;
  return to < from ? target.top : target.top + target.height - held.height;
}

/** Scroll speed (px per frame) near the scroll area's edges while a card is held. */
export function edgeScroll(pointer: number, top: number, bottom: number, zone = 48, max = 14) {
  if (pointer < top + zone) return -Math.ceil(max * Math.min(1, (top + zone - pointer) / zone));
  if (pointer > bottom - zone)
    return Math.ceil(max * Math.min(1, (pointer - (bottom - zone)) / zone));
  return 0;
}

/** The longest transition (duration plus delay, ms) of `element` now. */
export function transitionTime(element: Element): number {
  const style = getComputedStyle(element);
  const times = (value: string) =>
    value.split(',').map((part) => {
      const n = parseFloat(part);
      return Number.isFinite(n) ? (part.trim().endsWith('ms') ? n : n * 1000) : 0;
    });
  const durations = times(style.transitionDuration);
  const delays = times(style.transitionDelay);
  return Math.max(0, ...durations.map((d, i) => d + (delays[i % delays.length] ?? 0)));
}

export type Phase = 'open' | 'opening' | 'closing' | 'closed';

/**
 * Keeps an element mounted while it animates out. `opening` renders it in its closed style for
 * one layout, then `open` starts the transition; `closing` waits for one of `properties` to end
 * on the element itself (or its longest transition) before `closed` unmounts it. An element
 * that starts open does not animate in.
 */
export function usePresence(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  properties: readonly string[],
): Phase {
  const [phase, setPhase] = useState<Phase>(open ? 'open' : 'closed');
  useLayoutEffect(() => {
    setPhase((current) => {
      if (open) return current === 'closed' ? 'opening' : current === 'closing' ? 'open' : current;
      return current === 'open' || current === 'opening' ? 'closing' : current;
    });
  }, [open]);
  useLayoutEffect(() => {
    if (phase === 'opening') {
      // Style the closed state once so the change to open transitions.
      ref.current?.getBoundingClientRect();
      setPhase('open');
      return;
    }
    if (phase !== 'closing') return;
    const element = ref.current;
    const done = () => {
      setPhase((current) => (current === 'closing' ? 'closed' : current));
    };
    const time = element ? transitionTime(element) : 0;
    if (!element || time <= 0) {
      done();
      return;
    }
    const ended = (event: TransitionEvent) => {
      if (event.target === element && properties.includes(event.propertyName)) done();
    };
    element.addEventListener('transitionend', ended);
    const timer = window.setTimeout(done, time + 60);
    return () => {
      element.removeEventListener('transitionend', ended);
      window.clearTimeout(timer);
    };
  }, [phase, ref, properties]);
  return phase;
}
