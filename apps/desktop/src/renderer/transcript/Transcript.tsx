// The transcript (architecture section 8.4): a virtual list of rows that follows the bottom while
// content grows, with a "back to bottom" button once the user has scrolled away, and earlier
// history loaded when the user reaches the top.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../app/app-context.js';
import { SCROLL_FOLLOW } from './constants.js';
import { ScrollFollow, distanceFromBottom } from './scroll-follow.js';
import { useShownRowIds } from './services.js';
import { TranscriptList } from './TranscriptList.js';
import { pinToBottom, useFollowView, useScrollFollow } from './use-scroll-follow.js';

export function Transcript({
  onFollow,
  onReachTop,
  loadingEarlier = false,
}: {
  /** Receives the scroll-follow state machine and scroll element (prototype page, tests). */
  onFollow?: (follow: ScrollFollow, scroller: HTMLElement | null) => void;
  /** The user scrolled near the top: load earlier history, when there is any. */
  onReachTop?: () => void;
  /** Earlier history is being loaded. */
  loadingEarlier?: boolean;
}) {
  const t = useT();
  const ids = useShownRowIds();
  const follow = useMemo(() => new ScrollFollow(), []);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [content, setContent] = useState<HTMLElement | null>(null);
  useScrollFollow(follow, scroller, content);
  const view = useFollowView(follow);
  useEffect(() => {
    onFollow?.(follow, scroller);
  }, [onFollow, follow, scroller]);
  const scrollerRef = useRef<HTMLElement | null>(null);
  scrollerRef.current = scroller;
  // A row grew (layout phase): pin before paint when following.
  const onRowCommitted = useCallback(() => {
    const element = scrollerRef.current;
    if (element === null) {
      return;
    }
    const metrics = {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
    if (follow.resized(metrics, performance.now())) {
      pinToBottom(element, follow);
    }
  }, [follow]);
  useEffect(() => {
    if (scroller === null || onReachTop === undefined) {
      return;
    }
    const check = (): void => {
      const away = distanceFromBottom({
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      });
      if (scroller.scrollTop <= SCROLL_FOLLOW.loadEarlierPx && away > 0) {
        onReachTop();
      }
    };
    scroller.addEventListener('scroll', check, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', check);
    };
  }, [scroller, onReachTop]);
  return (
    <div
      className="transcript"
      data-testid="transcript"
      data-following={view.following}
      data-loading-earlier={loadingEarlier}
    >
      {loadingEarlier ? (
        <div className="transcript-loading muted" role="status">
          {t('transcript.loadEarlier')}
        </div>
      ) : null}
      <TranscriptList
        ids={ids}
        onScroller={setScroller}
        onContent={setContent}
        onRowCommitted={onRowCommitted}
      />
      {view.showButton ? (
        <button
          type="button"
          className="back-to-bottom"
          data-testid="back-to-bottom"
          onClick={() => {
            follow.jumpToBottom();
            if (scroller !== null) {
              pinToBottom(scroller, follow);
              scroller.focus();
            }
          }}
        >
          {t('transcript.backToBottom')}
        </button>
      ) : null}
    </div>
  );
}
