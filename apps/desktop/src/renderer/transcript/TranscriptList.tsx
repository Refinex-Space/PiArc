// The transcript's virtual list on @tanstack/react-virtual (ADR-0022): rows absolutely positioned
// in a sizer, measured with ResizeObserver, heights remembered per row id and width (RowHeights),
// about one viewport of rows rendered beyond each edge, and the list anchored to its end (rows
// put before the first one keep the viewport where it was). The rows of a selected exchange are
// kept rendered so a DOM selection can cover them.
import {
  measureElement as measureWithObserver,
  useVirtualizer,
  type Range,
  type Virtualizer,
} from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../app/app-context.js';
import { LOCATED_MS, VIRTUAL_LIST } from './constants.js';
import { loadExchange } from './copy.js';
import { ListActionsContext, type ListActions } from './rows/list-actions.js';
import { RowView } from './rows/RowView.js';
import { useTranscriptView } from './services.js';

type RowVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>;

/** Visible rows plus about `overscanViewports` viewport heights of rows on each side, and the
 * rows of `keep` (a selected exchange). */
function pixelOverscan(
  range: Range,
  instance: RowVirtualizer | null,
  keep: { start: number; end: number } | null,
): number[] {
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
  if (keep !== null && keep.end < range.count) {
    start = Math.min(start, keep.start);
    end = Math.max(end, keep.end);
  }
  const indexes: number[] = [];
  for (let index = start; index <= end; index += 1) {
    indexes.push(index);
  }
  return indexes;
}

export function TranscriptList({
  ids,
  onScroller,
  onContent,
  onRowCommitted,
  loadEarlier,
  focus,
}: {
  ids: readonly string[];
  /** Scroll to this row and mark it for a moment (T35). */
  focus?: { readonly rowId: string; readonly nonce: number } | undefined;
  /** Receives the scroll element. */
  onScroller: (element: HTMLElement | null) => void;
  /** Receives the element whose size changes when rows change size. */
  onContent: (element: HTMLElement | null) => void;
  /** A row committed new content (layout phase, before paint). */
  onRowCommitted: () => void;
  loadEarlier: (() => Promise<void>) | undefined;
}) {
  const t = useT();
  const { services, transcript } = useTranscriptView();
  const { heights } = services;
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<readonly string[] | null>(null);
  const selectionRequest = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => selectionRequest.current?.abort(), []);
  const instance = useRef<RowVirtualizer | null>(null);
  const keep = useMemo(() => {
    if (selected === null) {
      return null;
    }
    const first = ids.indexOf(selected[0] ?? '');
    const last = ids.indexOf(selected.at(-1) ?? '');
    return first === -1 || last === -1 ? null : { start: first, end: last };
  }, [ids, selected]);
  const keepRef = useRef(keep);
  keepRef.current = keep;

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: ids.length,
    getScrollElement: () => scroller,
    estimateSize: (index) => {
      const id = ids[index] ?? '';
      return heights.estimate(transcript.row(id), transcript.cacheKey(id), width);
    },
    getItemKey: (index) => ids[index] ?? index,
    anchorTo: 'end',
    rangeExtractor: (range) => pixelOverscan(range, instance.current, keepRef.current),
    measureElement: (element, entry, owner) => {
      const size = measureWithObserver(element, entry, owner);
      const id = element.dataset.rowId;
      if (id !== undefined && width > 0) {
        heights.set(transcript.cacheKey(id), width, size);
      }
      return size;
    },
  });
  instance.current = virtualizer;
  const [located, setLocated] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (focus === undefined) return;
    const index = ids.indexOf(focus.rowId);
    if (index === -1) return;
    virtualizer.scrollToIndex(index, { align: 'center' });
    setLocated(focus.rowId);
    const timer = setTimeout(() => {
      setLocated(undefined);
    }, LOCATED_MS);
    return () => {
      clearTimeout(timer);
    };
    // Only a new request (its nonce) scrolls; later row changes do not pull the view back.
  }, [focus?.nonce]);

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
      // measure() forgets every size, and a row's observer reports only its own resizes (often
      // just before the width change, as when expanded output brings a classic scrollbar, which
      // takes width). Measure the rows in the DOM again, or they keep estimates and overlap
      // (W1). getTotalSize() first rebuilds the measurements from the estimates: resizing
      // compares against them, and a row compared with its old size would change nothing.
      // resizeItem() also measures while the list scrolls, which measureElement() skips: at the
      // bottom, a width change comes with the scroll that keeps the bottom in view.
      virtualizer.getTotalSize();
      for (const row of scroller?.querySelectorAll<HTMLDivElement>('.transcript-row') ?? []) {
        const index = Number(row.dataset.index);
        if (Number.isInteger(index)) {
          virtualizer.resizeItem(
            index,
            virtualizer.options.measureElement(row, undefined, virtualizer),
          );
        }
      }
    }
  }, [virtualizer, width, scroller]);

  // The selected exchange's rows are rendered now: select them in the DOM.
  useLayoutEffect(() => {
    if (selected === null || scroller === null) {
      return;
    }
    const element = (id: string | undefined): Element | null =>
      id === undefined ? null : scroller.querySelector(`[data-row-id="${CSS.escape(id)}"]`);
    const first = element(selected[0]);
    const last = element(selected.at(-1));
    const selection = window.getSelection();
    if (first === null || last === null || selection === null) {
      return;
    }
    const range = document.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    selection.removeAllRanges();
    selection.addRange(range);
  }, [selected, scroller, keep]);
  // A new selection elsewhere releases the kept rows.
  useLayoutEffect(() => {
    if (selected === null) {
      return;
    }
    const release = (): void => {
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed) {
        setSelected(null);
      }
    };
    document.addEventListener('selectionchange', release);
    return () => {
      document.removeEventListener('selectionchange', release);
    };
  }, [selected]);

  // Every commit of the list (a measurement moved rows or grew the sizer) keeps the bottom in
  // view before paint, like a row's own commit.
  useLayoutEffect(() => {
    onRowCommitted();
  });

  const actions = useMemo<ListActions>(
    () => ({
      selectExchange: (rowId) => {
        selectionRequest.current?.abort();
        const request = new AbortController();
        selectionRequest.current = request;
        void loadExchange(transcript, rowId, loadEarlier, request.signal).then((rows) => {
          if (!request.signal.aborted) setSelected(rows.length === 0 ? null : rows);
        });
      },
      rowCommitted: onRowCommitted,
    }),
    [transcript, onRowCommitted, loadEarlier],
  );

  return (
    <ListActionsContext.Provider value={actions}>
      <div
        ref={(element) => {
          setScroller(element);
          onScroller(element);
        }}
        className="transcript-scroller"
        data-testid="transcript-scroller"
        tabIndex={0}
        role="log"
        aria-label={t('transcript.label')}
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
                data-located={located === id ? true : undefined}
                className="transcript-row"
                style={{ transform: `translateY(${String(item.start)}px)` }}
              >
                <RowView id={id} />
              </div>
            );
          })}
        </div>
      </div>
    </ListActionsContext.Provider>
  );
}
