import type { ScrollFollow } from '../scroll-follow.js';
import type { Pinner } from '../use-scroll-follow.js';

/** What the transcript gives a virtual list implementation. */
export interface ListProps {
  readonly ids: readonly string[];
  readonly follow: ScrollFollow;
  /** Receives the scroll element. */
  readonly onScroller: (element: HTMLElement | null) => void;
  /** Receives the element whose size changes when rows change size. */
  readonly onContent: (element: HTMLElement | null) => void;
  /** Receives how this list scrolls to the bottom, when it is not by setting `scrollTop`. */
  readonly onPinner: (pinner: Pinner | null) => void;
}
