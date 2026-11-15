// Transcript list on react-virtuoso, for the T09 comparison: Virtuoso measures rows itself (its
// size cache is per index, so RowHeights does not apply), renders `increaseViewportBy` pixels
// beyond each edge, and follows output through `followOutput`.
import { useLayoutEffect, useState, type Ref } from 'react';
import { Virtuoso, type ContextProp, type ListProps as VirtuosoListProps } from 'react-virtuoso';

import { RowView } from '../Rows.js';
import { VIRTUAL_LIST } from '../constants.js';
import type { ListProps } from './list-props.js';

interface ListContext {
  readonly onContent: (element: HTMLElement | null) => void;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') {
    ref(value);
  } else if (ref !== null && ref !== undefined) {
    ref.current = value;
  }
}

/** Virtuoso's item list element, reported as the content element for scroll following. */
function ItemList({ context, ref, ...props }: VirtuosoListProps & ContextProp<ListContext>) {
  return (
    <div
      {...props}
      ref={(element) => {
        assignRef(ref, element);
        context.onContent(element);
      }}
    />
  );
}

export function VirtuosoList({ ids, follow, onScroller, onContent }: ListProps) {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [viewport, setViewport] = useState(0);
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
    <Virtuoso<string, ListContext>
      className="transcript-scroller"
      data-testid="transcript-scroller"
      data-list="virtuoso"
      tabIndex={0}
      role="log"
      aria-label="Transcript"
      data={ids}
      context={{ onContent }}
      computeItemKey={(_, id) => id}
      itemContent={(_, id) => (
        <div className="transcript-row" data-row-id={id}>
          <RowView id={id} />
        </div>
      )}
      increaseViewportBy={{ top: overscan, bottom: overscan }}
      initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
      followOutput={() => (follow.state.following ? 'auto' : false)}
      components={{ List: ItemList }}
      scrollerRef={(element) => {
        const value = element instanceof HTMLElement ? element : null;
        setScroller(value);
        onScroller(value);
      }}
    />
  );
}
