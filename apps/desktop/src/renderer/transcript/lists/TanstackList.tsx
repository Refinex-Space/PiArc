// Transcript list on @tanstack/react-virtual: rows absolutely positioned in a sizer, measured with
// ResizeObserver, heights remembered per row id and width (RowHeights), about one viewport of
// rows rendered beyond each edge, and the list anchored to its end.
import {
  measureElement as measureWithObserver,
  useVirtualizer,
  type Range,
  type Virtualizer,
} from '@tanstack/react-virtual';
import { useLayoutEffect, useRef, useState } from 'react';

import { VIRTUAL_LIST } from '../constants.js';
import { RowView } from '../Rows.js';
import { useTranscriptServices } from '../services.js';
import type { ListProps } from './list-props.js';

type RowVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>;

/** Visible rows plus about `overscanViewports` viewport heights of rows on each side. */
function pixelOverscan(range: Range, instance: RowVirtualizer | null): number[] {
  const viewport = (instance?.scrollRect?.height ?? 0) * VIRTUAL_LIST.overscanViewports;
  const sizeOf = (index: number): number => instance?.measurementsCache[index]?.size ?? 0;
  let start = range.startIndex;
  let end = range.endIndex;
  for (let covered = 0; start > 0 && covered < viewport;) {
    start -= 1;
    covered += sizeOf(start);
  }
  for (let covered = 0; end < range.count - 1 && covered < viewport;) {
    end += 1;
    covered += sizeOf(end);
  }
  const indexes: number[] = [];
  for (let index = start; index <= end; index += 1) {
    indexes.push(index);
  }
  return indexes;
}

export function TanstackList({ ids, onScroller, onContent }: ListProps) {
  const { store, heights } = useTranscriptServices();
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const instance = useRef<RowVirtualizer | null>(null);

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: ids.length,
    getScrollElement: () => scroller,
    estimateSize: (index) => {
      const id = ids[index] ?? '';
      return heights.estimate(store.row(id), id, width);
    },
    getItemKey: (index) => ids[index] ?? index,
    anchorTo: 'end',
    rangeExtractor: (range) => pixelOverscan(range, instance.current),
    measureElement: (element, entry, owner) => {
      const size = measureWithObserver(element, entry, owner);
      const id = element.dataset.rowId;
      if (id !== undefined && width > 0) {
        heights.set(id, width, size);
      }
      return size;
    },
  });
  instance.current = virtualizer;

  // Track the width: heights are cached per width, and a new width needs new measurements.
  useLayoutEffect(() => {
    if (scroller === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setWidth(scroller.clientWidth);
    });
    observer.observe(scroller);
    setWidth(scroller.clientWidth);
    return () => {
      observer.disconnect();
    };
  }, [scroller]);
  useLayoutEffect(() => {
    if (width > 0) {
      virtualizer.measure();
    }
  }, [virtualizer, width]);

  return (
    <div
      ref={(element) => {
        setScroller(element);
        onScroller(element);
      }}
      className="transcript-scroller"
      data-testid="transcript-scroller"
      data-list="tanstack"
      tabIndex={0}
      role="log"
      aria-label="Transcript"
    >
      <div
        ref={onContent}
        className="transcript-sizer"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const id = ids[item.index] ?? '';
          return (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              data-row-id={id}
              className="transcript-row"
              style={{ transform: `translateY(${String(item.start)}px)` }}
            >
              <RowView id={id} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
