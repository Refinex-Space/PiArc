// Connects a ScrollFollow state machine to the scroll element of a list and to the element that
// holds its rows: user input and scroll events go in, pins to the bottom come out. Pins happen
// in ResizeObserver callbacks, after layout and before paint, so growth never shows a frame
// that is not at the bottom.
import { useEffect, useSyncExternalStore } from 'react';

import type { FollowView, ScrollFollow, ScrollMetrics } from './scroll-follow.js';

/** Keys that scroll a focused scroll container. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/** How a list scrolls itself to the bottom; the default sets `scrollTop`. */
export type Pinner = (scroller: HTMLElement) => void;

export const scrollTopPinner: Pinner = (scroller) => {
  scroller.scrollTop = scroller.scrollHeight;
};

export function metricsOf(element: HTMLElement): ScrollMetrics {
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}

/** Scrolls `scroller` to the bottom at once and tells `follow`. */
export function pinToBottom(
  scroller: HTMLElement,
  follow: ScrollFollow,
  pinner: Pinner = scrollTopPinner,
): void {
  pinner(scroller);
  follow.pinned(metricsOf(scroller));
}

/**
 * `content` is the element whose size changes with the rows; a list that reports growth itself
 * (react-virtuoso) passes `null` and calls `follow.resized` on its own.
 */
export function useScrollFollow(
  follow: ScrollFollow,
  scroller: HTMLElement | null,
  content: HTMLElement | null,
  pinner: Pinner = scrollTopPinner,
): void {
  useEffect(() => {
    if (scroller === null) {
      return;
    }
    const now = (): number => performance.now();
    const onScroll = (): void => {
      if (follow.scrolled(metricsOf(scroller), now())) {
        pinToBottom(scroller, follow, pinner);
      }
    };
    const onUserInput = (): void => {
      follow.userInput(now());
    };
    const onKey = (event: KeyboardEvent): void => {
      if (SCROLL_KEYS.has(event.key)) {
        follow.userInput(now());
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      // Rows cover the content area, so a press on the scroller itself is on its scrollbar.
      if (event.target === scroller) {
        follow.pointer(now(), true);
      }
    };
    const onPointerUp = (): void => {
      follow.pointer(now(), false);
    };
    const onResize = (): void => {
      if (follow.resized(metricsOf(scroller), now())) {
        pinToBottom(scroller, follow, pinner);
      }
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(scroller);
    if (content !== null) {
      observer.observe(content, { box: 'border-box' });
    }
    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('wheel', onUserInput, { passive: true });
    scroller.addEventListener('touchstart', onUserInput, { passive: true });
    scroller.addEventListener('touchmove', onUserInput, { passive: true });
    scroller.addEventListener('keydown', onKey);
    scroller.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      observer.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('wheel', onUserInput);
      scroller.removeEventListener('touchstart', onUserInput);
      scroller.removeEventListener('touchmove', onUserInput);
      scroller.removeEventListener('keydown', onKey);
      scroller.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [follow, scroller, content, pinner]);
}

export function useFollowView(follow: ScrollFollow): FollowView {
  return useSyncExternalStore(
    (listener) => follow.subscribe(listener),
    () => follow.state,
  );
}
