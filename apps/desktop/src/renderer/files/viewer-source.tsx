import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useT } from '../app/app-context.js';
import { useFileHighlight } from './viewer-highlight.js';
import { Token } from '../transcript/highlight/CodeBlock.js';
import { revealBidi } from '../transcript/reveal.js';
import { useDarkScheme } from '../transcript/use-color-scheme.js';
import type { FileSelection, FindMatch, ViewerSettings } from './viewer-model.js';

export interface FileLocation {
  line: number;
  endLine?: number;
  column?: number;
  nonce?: number;
}
function lineOfNode(node: Node | null) {
  const element = node?.nodeType === 1 ? (node as Element) : node?.parentElement;
  const line = element?.closest<HTMLElement>('[data-source-line]')?.dataset.sourceLine;
  return line === undefined ? undefined : Number(line);
}

export function FileSource({
  path,
  text,
  lines,
  settings,
  location,
  match,
  matches,
  selection,
  onSelect,
  onEdit,
}: {
  path: string;
  text: string;
  lines: readonly string[];
  settings: ViewerSettings;
  location: FileLocation | undefined;
  match: FindMatch | undefined;
  matches: readonly FindMatch[] | undefined;
  selection: FileSelection | undefined;
  onSelect: (value: FileSelection | undefined) => void;
  onEdit: (line: number) => void;
}) {
  const activeTokens = useFileHighlight(path, text);
  const byLine = useMemo(() => {
    const grouped = new Map<number, FindMatch[]>();
    for (const hit of matches ?? []) {
      const existing = grouped.get(hit.line);
      if (existing) existing.push(hit);
      else grouped.set(hit.line, [hit]);
    }
    return grouped;
  }, [matches]);
  const dark = useDarkScheme(),
    t = useT();
  const [scroll, setScroll] = useState<HTMLDivElement | null>(null);
  const [current, setCurrent] = useState(1);
  const anchor = useRef(1);
  const virtual = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroll,
    estimateSize: () => 20,
    overscan: 10,
  });
  useLayoutEffect(() => {
    virtual.measure();
  }, [virtual, settings.wordWrap, settings.tabSize, scroll]);
  useEffect(() => {
    if (!scroll || typeof ResizeObserver === 'undefined') return;
    let width = scroll.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width !== scroll.clientWidth) {
        width = scroll.clientWidth;
        virtual.measure();
      }
    });
    observer.observe(scroll);
    return () => {
      observer.disconnect();
    };
  }, [scroll, virtual]);
  useEffect(() => {
    const line = match?.line ?? location?.line;
    if (line !== undefined) {
      const bounded = Math.max(1, Math.min(lines.length, line));
      virtual.scrollToIndex(bounded - 1, { align: 'center' });
      setCurrent(bounded);
    }
  }, [location, match, lines.length, virtual]);
  function selectLine(line: number, extend: boolean) {
    if (!extend) anchor.current = line;
    setCurrent(line);
    const startLine = Math.min(anchor.current, line),
      endLine = Math.max(anchor.current, line);
    onSelect({ startLine, endLine, text: lines.slice(startLine - 1, endLine).join('\n') });
  }
  function readSelection() {
    const range = scroll?.ownerDocument.getSelection();
    if (
      !range ||
      range.isCollapsed ||
      !scroll?.contains(range.anchorNode) ||
      !scroll.contains(range.focusNode)
    )
      return;
    const a = lineOfNode(range.anchorNode),
      b = lineOfNode(range.focusNode);
    if (a && b)
      onSelect({ startLine: Math.min(a, b), endLine: Math.max(a, b), text: range.toString() });
  }
  const position = (line: number) =>
    Boolean(selection && line >= selection.startLine && line <= selection.endLine) ||
    Boolean(location && line >= location.line && line <= (location.endLine ?? location.line));
  return (
    <div
      ref={setScroll}
      className="file-source-scroll"
      aria-label={t('files.viewer.source')}
      role="region"
      tabIndex={0}
      data-testid="file-source"
      data-wrap={settings.wordWrap}
      data-past={settings.scrollPastEnd}
      style={
        {
          tabSize: settings.tabSize,
          '--file-number-width': String(String(lines.length).length) + 'ch',
          '--file-tab-width': String(settings.tabSize) + 'ch',
        } as CSSProperties
      }
      onContextMenu={(event) => {
        if (selection) return;
        const n = lineOfNode(event.target as Node);
        if (n) selectLine(n, false);
      }}
      onPointerUp={readSelection}
      onKeyUp={readSelection}
      onKeyDown={(event) => {
        if (
          event.target !== scroll &&
          !event.currentTarget.ownerDocument.activeElement?.closest('.file-line-number')
        )
          return;
        const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
        if (delta) {
          event.preventDefault();
          const next = Math.max(1, Math.min(current + delta, lines.length));
          selectLine(next, event.shiftKey);
          virtual.scrollToIndex(next - 1, { align: 'auto' });
        } else if (event.key === 'Enter') {
          event.preventDefault();
          selectLine(current, event.shiftKey);
        } else if (event.key === 'Escape') {
          onSelect(undefined);
        }
      }}
    >
      <div className="file-source-canvas" style={{ height: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map((item) => {
          const at = item.index,
            line = at + 1,
            value = lines[at] ?? '',
            tokens = activeTokens?.[at];
          const hits = byLine.get(line);
          const indent = settings.indentGuides ? (/^[ \t]+/u.exec(value)?.[0] ?? '') : '';
          return (
            <div
              key={item.key}
              ref={virtual.measureElement}
              className="file-source-line"
              data-index={at}
              data-source-line={line}
              data-selected={position(line) || match?.line === line || undefined}
              style={{ transform: 'translateY(' + String(item.start) + 'px)' }}
            >
              <button
                className="file-line-number"
                tabIndex={-1}
                aria-label={t('files.viewer.selectLine', { line })}
                data-number={line}
                onClick={(event) => {
                  selectLine(line, event.shiftKey);
                  scroll?.focus({ preventScroll: true });
                }}
              />
              <code
                className="file-line-text"
                onDoubleClick={() => {
                  onEdit(line);
                }}
              >
                {indent && (
                  <span className="file-indent-guide" aria-hidden="true">
                    {indent}
                  </span>
                )}
                {settings.showWhitespace && (
                  <span className="file-whitespace" aria-hidden="true">
                    {value
                      .replace(/[^ \t]/gu, '\u00a0')
                      .replace(/ /gu, '·')
                      .replace(/\t/gu, '→\t')}
                  </span>
                )}
                {hits ? (
                  <>
                    {hits.map((hit, i) => (
                      <Fragment key={hit.start}>
                        {revealBidi(value.slice(hits[i - 1]?.end ?? 0, hit.start))}
                        <mark data-current={hit === match || undefined}>
                          {revealBidi(value.slice(hit.start, hit.end))}
                        </mark>
                      </Fragment>
                    ))}
                    {revealBidi(value.slice(hits.at(-1)?.end))}
                  </>
                ) : tokens ? (
                  tokens.map((token, i) => <Token key={i} dark={dark} token={token} />)
                ) : (
                  revealBidi(value)
                )}
              </code>
            </div>
          );
        })}
      </div>
    </div>
  );
}
