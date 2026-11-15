// Transcript list on react-virtuoso, for the T09 comparison: Virtuoso measures rows itself (its
// size cache is per index, so RowHeights does not apply), renders `increaseViewportBy` pixels
// beyond each edge, follows appended items through `followOutput`, and is pinned to the bottom
// through its own `scrollToIndex`: setting `scrollTop` from a ResizeObserver on its item list
// fights its positioning and can leave it rendering no rows at all.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import { VIRTUAL_LIST } from '../constants.js';
import { RowView } from '../Rows.js';
import { metricsOf, pinToBottom, type Pinner } from '../use-scroll-follow.js';
import type { ListProps } from './list-props.js';

export function VirtuosoList({ ids, follow, onScroller, onContent, onPinner }: ListProps) {
  const handle = useRef<VirtuosoHandle | null>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [viewport, setViewport] = useState(0);
  const [pinner] = useState<Pinner>(() => () => {
    handle.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
  });
  // The transcript passes new callbacks on every render; register with the first ones only.
  const register = useRef({ onContent, onPinner });

  useEffect(() => {
    const { onContent: reportContent, onPinner: reportPinner } = register.current;
    // Growth is reported through totalListHeightChanged instead of a content element.
    reportContent(null);
    reportPinner(pinner);
    return () => {
      reportPinner(null);
    };
  }, [pinner]);

  useLayoutEffect(() => {
    if (scroller === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setViewport(scroller.clientHeight);
    });
    observer.observe(scroller);
    setViewport(scroller.clientHeight);
    return () => {
      observer.disconnect();
    };
  }, [scroller]);

  const overscan = Math.round(viewport * VIRTUAL_LIST.overscanViewports);
  return (
    <Virtuoso<string>
      ref={handle}
      className="transcript-scroller"
      data-testid="transcript-scroller"
      data-list="virtuoso"
      tabIndex={0}
      role="log"
      aria-label="Transcript"
      data={ids}
      computeItemKey={(_, id) => id}
      itemContent={(_, id) => (
        <div className="transcript-row" data-row-id={id}>
          <RowView id={id} />
        </div>
      )}
      increaseViewportBy={{ top: overscan, bottom: overscan }}
      initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
      followOutput={() => (follow.state.following ? 'auto' : false)}
      totalListHeightChanged={() => {
        if (scroller !== null && follow.resized(metricsOf(scroller), performance.now())) {
          pinToBottom(scroller, follow, pinner);
        }
      }}
      scrollerRef={(element) => {
        const value = element instanceof HTMLElement ? element : null;
        setScroller(value);
        onScroller(value);
      }}
    />
  );
}
