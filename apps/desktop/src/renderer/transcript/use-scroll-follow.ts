// Connects a ScrollFollow state machine to the scroll element of a list and to the element that
// holds its rows: user input and scroll events go in, pins to the bottom come out. Pins happen
// in ResizeObserver callbacks, after layout and before paint, so growth never shows a frame
// that is not at the bottom.
import { useEffect, useSyncExternalStore } from 'react';

import type { FollowView, ScrollFollow, ScrollMetrics } from './scroll-follow.js';

/** Keys that scroll a focused scroll container. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

function metricsOf(element: HTMLElement): ScrollMetrics {
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}

/** Scrolls `scroller` to the bottom at once and tells `follow`. */
export function pinToBottom(scroller: HTMLElement, follow: ScrollFollow): void {
  scroller.scrollTop = scroller.scrollHeight;
  follow.pinned(metricsOf(scroller));
}

/** `content` is the element whose size changes with the rows (the list's sizer). */
export function useScrollFollow(
  follow: ScrollFollow,
  scroller: HTMLElement | null,
  content: HTMLElement | null,
): void {
  useEffect(() => {
    if (scroller === null) {
      return;
    }
    const now = (): number => performance.now();
    const onScroll = (): void => {
      if (follow.scrolled(metricsOf(scroller), now())) {
        pinToBottom(scroller, follow);
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
        pinToBottom(scroller, follow);
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
  }, [follow, scroller, content]);
}

export function useFollowView(follow: ScrollFollow): FollowView {
  return useSyncExternalStore(
    (listener) => follow.subscribe(listener),
    () => follow.state,
  );
}
