// The transcript (architecture section 8.4): a virtual list of rows that follows the bottom while
// content grows, with a "back to bottom" button once the user has scrolled away.
import { useEffect, useMemo, useState } from 'react';

import { useRowIds } from './item-store.js';
import { ScrollFollow } from './scroll-follow.js';
import { useTranscriptServices } from './services.js';
import { TranscriptList } from './TranscriptList.js';
import { pinToBottom, useFollowView, useScrollFollow } from './use-scroll-follow.js';

export function Transcript({
  onFollow,
}: {
  /** Receives the scroll-follow state machine and scroll element (prototype page, tests). */
  onFollow?: (follow: ScrollFollow, scroller: HTMLElement | null) => void;
}) {
  const { store } = useTranscriptServices();
  const ids = useRowIds(store);
  const follow = useMemo(() => new ScrollFollow(), []);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [content, setContent] = useState<HTMLElement | null>(null);
  useScrollFollow(follow, scroller, content);
  const view = useFollowView(follow);
  useEffect(() => {
    onFollow?.(follow, scroller);
  }, [onFollow, follow, scroller]);
  return (
    <div className="transcript" data-testid="transcript" data-following={view.following}>
      <TranscriptList ids={ids} onScroller={setScroller} onContent={setContent} />
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
          Back to bottom
        </button>
      ) : null}
    </div>
  );
}
