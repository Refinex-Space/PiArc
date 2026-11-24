import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../app/app-context.js';
import { documentWindow, useSurfaceDocument } from '../../app/surface-document.js';
import { readerRange } from './reader-range.js';
import type { FileSelection } from '../viewer-model.js';
interface ReadingSelection {
  selection: FileSelection;
  range: Range;
  reader: HTMLElement;
}
export function readingSelection(
  scope: Element,
  lines: readonly string[],
): ReadingSelection | undefined {
  const sel = scope.ownerDocument.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount !== 1 || !sel.anchorNode || !sel.focusNode) return;
  const r = sel.getRangeAt(0);
  const el = (node: Node) => (node.nodeType === 1 ? (node as Element) : node.parentElement);
  const start = el(r.startContainer),
    reader = start?.closest<HTMLElement>('.markdown-reader');
  if (!reader || !scope.contains(reader) || !reader.contains(r.endContainer)) return;
  const selection = readerRange(r, lines);
  if (!selection) return;
  return { reader, range: r.cloneRange(), selection };
}
export function ReaderSelectionTools({
  scope,
  lines,
  copy,
  attach,
  comment,
  edit,
}: {
  scope: RefObject<HTMLDivElement | null>;
  lines: readonly string[];
  copy: (s: string) => void;
  attach: (s: FileSelection) => void;
  comment: (s: FileSelection) => void;
  edit?: ((line: number) => void) | undefined;
}) {
  const t = useT(),
    doc = useSurfaceDocument(),
    win = documentWindow(doc);
  const [picked, setPicked] = useState<ReadingSelection>(),
    bar = useRef<HTMLDivElement>(null),
    suppress = useRef(false);
  const read = useCallback(() => {
    if (!suppress.current && scope.current) setPicked(readingSelection(scope.current, lines));
  }, [scope, lines]);
  useLayoutEffect(() => {
    let raf = 0;
    const schedule = () => {
      win.cancelAnimationFrame(raf);
      raf = win.requestAnimationFrame(read);
    };
    const down = (e: PointerEvent) => {
      if (bar.current?.contains(e.target as Node)) return;
      suppress.current = e.button === 0;
      setPicked(undefined);
    };
    const up = () => {
      if (suppress.current) {
        suppress.current = false;
        schedule();
      }
    };
    const menu = () => {
      suppress.current = true;
      setPicked(undefined);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPicked(undefined);
        return;
      }
      if (e.altKey && e.key === 'F10' && bar.current) {
        e.preventDefault();
        bar.current.querySelector('button')?.focus();
        return;
      }
      suppress.current = false;
    };
    doc.addEventListener('pointerdown', down, true);
    doc.addEventListener('pointerup', up, true);
    doc.addEventListener('pointercancel', up, true);
    doc.addEventListener('selectionchange', schedule);
    doc.addEventListener('contextmenu', menu, true);
    doc.addEventListener('keydown', key, true);
    return () => {
      win.cancelAnimationFrame(raf);
      doc.removeEventListener('pointerdown', down, true);
      doc.removeEventListener('pointerup', up, true);
      doc.removeEventListener('pointercancel', up, true);
      doc.removeEventListener('selectionchange', schedule);
      doc.removeEventListener('contextmenu', menu, true);
      doc.removeEventListener('keydown', key, true);
    };
  }, [read, doc, win]);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!picked || !el) return;
    const place = () => {
      const bounds = picked.reader.getBoundingClientRect(),
        area = picked.range.getBoundingClientRect(),
        size = el.getBoundingClientRect();
      if (!area.width || !bounds.width || area.bottom < bounds.top || area.top > bounds.bottom) {
        el.style.visibility = 'hidden';
        return;
      }
      const edge = 8;
      el.style.maxWidth = String(Math.max(0, bounds.width - 2 * edge)) + 'px';
      const left = Math.max(edge, bounds.left + edge),
        right = Math.min(win.innerWidth - edge, bounds.right - edge);
      const top = Math.max(edge, bounds.top + edge);
      const x = Math.max(
        left,
        Math.min(right - size.width, (area.left + area.right - size.width) / 2),
      );
      const y =
        area.top - size.height - 6 >= top
          ? area.top - size.height - 6
          : Math.min(
              area.bottom + 6,
              win.innerHeight - edge - size.height,
              bounds.bottom - edge - size.height,
            );
      el.style.transform = 'translate(' + String(x) + 'px,' + String(Math.max(top, y)) + 'px)';
      el.style.visibility = 'visible';
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(picked.reader);
    ro.observe(el);
    doc.addEventListener('scroll', place, true);
    win.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      doc.removeEventListener('scroll', place, true);
      win.removeEventListener('resize', place);
    };
  }, [picked, doc, win]);
  if (!picked) return null;
  const options = [
    {
      label: t('md.selection.copy'),
      run: () => {
        copy(picked.selection.text);
      },
    },
    {
      label: t('files.viewer.attachSelection'),
      run: () => {
        attach(picked.selection);
      },
    },
    {
      label: t('files.viewer.comment'),
      run: () => {
        comment(picked.selection);
      },
    },
    ...(edit
      ? [
          {
            label: t('files.viewer.edit'),
            run: () => {
              edit(picked.selection.startLine);
            },
          },
        ]
      : []),
  ];
  return createPortal(
    <div
      ref={bar}
      role="toolbar"
      aria-label={t('md.selection.readTools')}
      className="md-reader-selection"
      data-testid="markdown-reader-tools"
      onMouseDown={(e) => {
        e.preventDefault();
      }}
      onKeyDown={(e) => {
        const buttons = Array.from(e.currentTarget.querySelectorAll('button')),
          i = buttons.indexOf(e.target as HTMLButtonElement);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          buttons[
            (i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
          ]?.focus();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setPicked(undefined);
          picked.reader.focus({ preventScroll: true });
        }
      }}
    >
      {options.map((item) => (
        <button
          type="button"
          key={item.label}
          onClick={() => {
            setPicked(undefined);
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    doc.body,
  );
}
