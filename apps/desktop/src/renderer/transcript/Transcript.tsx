// The transcript (architecture section 8.4): a virtual list of rows that follows the bottom while
// content grows, with a "back to bottom" button once the user has scrolled away.
import { useEffect, useMemo, useState } from 'react';

import { useRowIds } from './item-store.js';
import { TanstackList } from './lists/TanstackList.js';
import { VirtuosoList } from './lists/VirtuosoList.js';
import { ScrollFollow } from './scroll-follow.js';
import { useTranscriptServices } from './services.js';
import {
  pinToBottom,
  scrollTopPinner,
  useFollowView,
  useScrollFollow,
  type Pinner,
} from './use-scroll-follow.js';

export type VirtualListKind = 'tanstack' | 'virtuoso';

export function Transcript({
  list,
  onFollow,
}: {
  list: VirtualListKind;
  /** Receives the scroll-follow state machine and scroll element (prototype page, tests). */
  onFollow?: (follow: ScrollFollow, scroller: HTMLElement | null) => void;
}) {
  const { store } = useTranscriptServices();
  const ids = useRowIds(store);
  const follow = useMemo(() => new ScrollFollow(), []);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [content, setContent] = useState<HTMLElement | null>(null);
  const [pinner, setPinner] = useState<Pinner>(() => scrollTopPinner);
  useScrollFollow(follow, scroller, content, pinner);
  const view = useFollowView(follow);
  useEffect(() => {
    onFollow?.(follow, scroller);
  }, [onFollow, follow, scroller]);
  const List = list === 'tanstack' ? TanstackList : VirtuosoList;
  return (
    <div className="transcript" data-testid="transcript" data-following={view.following}>
      <List
        ids={ids}
        follow={follow}
        onScroller={setScroller}
        onContent={setContent}
        onPinner={(next) => {
          setPinner(() => next ?? scrollTopPinner);
        }}
      />
      {view.showButton ? (
        <button
          type="button"
          className="back-to-bottom"
          data-testid="back-to-bottom"
          onClick={() => {
            follow.jumpToBottom();
            if (scroller !== null) {
              pinToBottom(scroller, follow, pinner);
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
