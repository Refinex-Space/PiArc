// The transcript (architecture section 8.4): a virtual list of rows that follows the bottom while
// content grows, with a "back to bottom" button once the user has scrolled away, and earlier
// history loaded when the user reaches the top.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../app/app-context.js';
import { SCROLL_FOLLOW } from './constants.js';
import { ScrollFollow, distanceFromBottom } from './scroll-follow.js';
import { useShownRowIds } from './services.js';
import { TranscriptList } from './TranscriptList.js';
import { ArrowDownGlyph } from '../shell/icons.js';
import { isApprovalRow } from '../store/transcript.js';
import { pinToBottom, useFollowView, useScrollFollow } from './use-scroll-follow.js';

export function Transcript({
  onFollow,
  onReachTop,
  loadingEarlier = false,
  focus,
}: {
  /** Scrolls to this row and marks it (T35: a search result); a new nonce scrolls again. */
  focus?: { readonly rowId: string; readonly nonce: number } | undefined;
  /** Receives the scroll-follow state machine and scroll element (prototype page, tests). */
  onFollow?: (follow: ScrollFollow, scroller: HTMLElement | null) => void;
  /** The user scrolled near the top: load earlier history, when there is any. */
  onReachTop?: () => Promise<void>;
  /** Earlier history is being loaded. */
  loadingEarlier?: boolean;
}) {
  const t = useT();
  const ids = useShownRowIds();
  // An approval card waits below: the jump says so.
  const waiting = ids.some(isApprovalRow);
  const follow = useMemo(() => new ScrollFollow(), []);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [content, setContent] = useState<HTMLElement | null>(null);
  useScrollFollow(follow, scroller, content);
  const view = useFollowView(follow);
  // Moving to a found message is like the user scrolling: it stops following the end.
  useEffect(() => {
    if (focus !== undefined) follow.userInput(performance.now());
  }, [focus, follow]);
  useEffect(() => {
    onFollow?.(follow, scroller);
  }, [onFollow, follow, scroller]);
  const scrollerRef = useRef<HTMLElement | null>(null);
  scrollerRef.current = scroller;
  // Several rows and their Markdown or highlighted children can commit together. Read the
  // final geometry once before paint, after all their layout effects have run.
  const pinPending = useRef(false);
  const onRowCommitted = useCallback(() => {
    if (pinPending.current) return;
    pinPending.current = true;
    queueMicrotask(() => {
      pinPending.current = false;
      const element = scrollerRef.current;
      if (!element?.isConnected) {
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
    });
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
        void onReachTop();
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
        following={view.following}
        onScroller={setScroller}
        onContent={setContent}
        onRowCommitted={onRowCommitted}
        loadEarlier={onReachTop}
        focus={focus}
      />
      {view.showButton ? (
        <button
          type="button"
          className="back-to-bottom"
          data-testid="back-to-bottom"
          data-waiting={waiting}
          aria-label={t(waiting ? 'transcript.backToBottomInput' : 'transcript.backToBottom')}
          data-tooltip={waiting ? undefined : t('transcript.backToBottom')}
          onClick={() => {
            follow.jumpToBottom();
            if (scroller !== null) {
              pinToBottom(scroller, follow);
              scroller.focus();
            }
          }}
        >
          {waiting ? (
            <>
              <span className="back-to-bottom-dot" aria-hidden="true" />
              <span aria-hidden="true">{t('transcript.needsInput')}</span>
            </>
          ) : null}
          <ArrowDownGlyph />
        </button>
      ) : null}
    </div>
  );
}
