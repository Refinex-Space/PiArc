// The collapsed rail follows the scroll position. Its small visual window and the
// expanded, virtualized list both stay bounded on documents with thousands of headings.
import {
  useLayoutEffect,
  useEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type KeyboardEvent,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useT } from '../../app/app-context.js';
import { useSurfaceDocument } from '../../app/surface-document.js';
import { IconButton } from '../../app/IconButton.js';
import { MarkdownActionIcon } from './MarkdownModes.js';
import type { Heading } from './document-model.js';

export function headingAtLine(headings: readonly Heading[], line: number) {
  let low = 0,
    high = headings.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((headings[middle]?.line ?? 0) <= line) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}
interface Props {
  headings: readonly Heading[];
  active: number;
  jump: (heading: Heading, index: number) => void;
}
const MAX_MARKS = 48;

export function MarkdownOutline({ headings, active, jump }: Props) {
  const t = useT(),
    doc = useSurfaceDocument(),
    id = useId();
  const rail = useRef<HTMLElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    marks = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<number>(undefined);
  const [open, setOpen] = useState(false),
    [takeFocus, setTakeFocus] = useState(false);
  const start = Math.max(0, Math.min(active - (MAX_MARKS >>> 1), headings.length - MAX_MARKS));
  const current = headings.slice(start, start + MAX_MARKS);
  const cancel = () => {
    doc.defaultView?.clearTimeout(closeTimer.current);
  };
  const close = (restore = false) => {
    cancel();
    setOpen(false);
    setTakeFocus(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    const el = marks.current;
    if (!el) return;
    const position = () => {
      el.toggleAttribute('data-overflow', el.scrollHeight > el.clientHeight + 1);
      const selected = el.querySelector<HTMLElement>('[data-current]');
      if (selected)
        el.scrollTop = selected.offsetTop - (el.clientHeight - selected.offsetHeight) / 2;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [active, start, headings]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (e: PointerEvent) => {
      if (rail.current && !e.composedPath().includes(rail.current)) {
        setOpen(false);
        setTakeFocus(false);
      }
    };
    const escape = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        setTakeFocus(false);
        if (rail.current?.contains(doc.activeElement))
          trigger.current?.focus({ preventScroll: true });
      }
    };
    doc.addEventListener('pointerdown', dismiss, true);
    doc.addEventListener('keydown', escape, true);
    return () => {
      doc.removeEventListener('pointerdown', dismiss, true);
      doc.removeEventListener('keydown', escape, true);
      doc.defaultView?.clearTimeout(closeTimer.current);
    };
  }, [doc, open]);
  const keyboardOpen = () => {
    cancel();
    setTakeFocus(true);
    setOpen(true);
  };
  return (
    <div className="md-outline-layer">
      <nav
        ref={rail}
        aria-label={t('files.md.outline')}
        className="md-outline"
        onPointerEnter={(e) => {
          cancel();
          if (e.pointerType !== 'touch') setOpen(true);
        }}
        onPointerLeave={() => {
          cancel();
          closeTimer.current = doc.defaultView?.setTimeout(() => {
            if (!rail.current?.querySelector('.md-outline-popover')?.contains(doc.activeElement))
              close();
          }, 140);
        }}
        onBlur={(e) => {
          if (e.relatedTarget && !rail.current?.contains(e.relatedTarget)) close();
        }}
      >
        <button
          type="button"
          ref={trigger}
          className="md-outline-trigger"
          data-testid="md-outline-trigger"
          aria-label={t('files.md.outline')}
          aria-description={headings[active]?.title}
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={keyboardOpen}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              keyboardOpen();
            }
          }}
        >
          <span className="md-outline-marks" aria-hidden="true" ref={marks}>
            {current.map((h, i) => (
              <span
                key={h.slug}
                className="md-outline-mark"
                data-level={h.level}
                data-current={i + start === active ? '' : undefined}
              />
            ))}
          </span>
        </button>
        {open && (
          <div className="md-outline-bridge">
            <OutlineContents
              id={id}
              headings={headings}
              active={active}
              takeFocus={takeFocus}
              jump={(h, i) => {
                jump(h, i);
                close(true);
              }}
            />
          </div>
        )}
      </nav>
    </div>
  );
}

function OutlineContents({
  headings,
  active,
  jump,
  id,
  takeFocus,
}: Props & { id: string; takeFocus: boolean }) {
  const t = useT(),
    [filter, setFilter] = useState(''),
    [searching, setSearching] = useState(false);
  const list = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null),
    pendingFocus = useRef<number | null>(null);
  const [cursor, setCursor] = useState(active),
    [height, setHeight] = useState(28);
  const items = useMemo(
    () =>
      headings
        .map((heading, index) => ({ heading, index }))
        .filter(({ heading }) => heading.title.toLowerCase().includes(filter.trim().toLowerCase())),
    [headings, filter],
  );
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const update = () => {
      setHeight(
        parseFloat(getComputedStyle(el).getPropertyValue('--piarc-size-button-height')) || 28,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => list.current,
    estimateSize: () => height,
    overscan: 4,
  });
  const visible = virtual.getVirtualItems();
  useLayoutEffect(() => {
    virtual.measure();
  }, [height, virtual]);
  useLayoutEffect(() => {
    if (!items.length) return;
    const at = filter
      ? 0
      : Math.max(
          0,
          items.findIndex((item) => item.index === active),
        );
    setCursor(at);
    virtual.scrollToIndex(at, { align: 'auto', behavior: 'instant' });
    if (takeFocus && !searching) pendingFocus.current = at;
  }, [items, filter, active, takeFocus, searching, virtual]);
  useLayoutEffect(() => {
    const at = pendingFocus.current;
    if (at === null) return;
    const button = list.current?.querySelector<HTMLButtonElement>(
      '[data-outline-index="' + String(at) + '"]',
    );
    if (button) {
      pendingFocus.current = null;
      button.focus({ preventScroll: true });
    }
  });
  useLayoutEffect(() => {
    if (searching) search.current?.focus();
  }, [searching]);
  function navigate(e: KeyboardEvent) {
    if (e.nativeEvent.isComposing || !items.length) return;
    if (e.key === 'Enter' && e.target === search.current) {
      const selected = items[cursor];
      if (selected) {
        e.preventDefault();
        jump(selected.heading, selected.index);
      }
      return;
    }
    let next: number;
    if (e.key === 'ArrowDown') next = Math.min(cursor + 1, items.length - 1);
    else if (e.key === 'ArrowUp') next = Math.max(cursor - 1, 0);
    else if (e.key === 'Home' && e.target !== search.current) next = 0;
    else if (e.key === 'End' && e.target !== search.current) next = items.length - 1;
    else return;
    e.preventDefault();
    pendingFocus.current = next;
    setCursor(next);
    virtual.scrollToIndex(next, { align: 'auto', behavior: 'instant' });
    if (next === cursor) {
      list.current
        ?.querySelector<HTMLButtonElement>('[data-outline-index="' + String(next) + '"]')
        ?.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  }
  return (
    <div
      id={id}
      className="md-outline-popover"
      data-testid="md-outline-popover"
      onKeyDown={navigate}
    >
      <div className="md-outline-heading">
        {searching ? (
          <input
            ref={search}
            value={filter}
            aria-label={t('files.md.findHeading')}
            placeholder={t('files.md.findHeading')}
            onChange={(e) => {
              setFilter(e.target.value);
            }}
          />
        ) : (
          <span>{t('files.md.outline')}</span>
        )}
        <IconButton
          label={t('files.md.findHeading')}
          aria-pressed={searching}
          onClick={() => {
            setSearching(!searching);
            setFilter('');
          }}
        >
          <MarkdownActionIcon name="find" />
        </IconButton>
      </div>
      <div ref={list} className="md-outline-list" style={{ height: items.length * height }}>
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {visible.map((row) => {
            const item = items[row.index];
            if (!item) return null;
            const { heading: h, index } = item;
            return (
              <button
                key={h.slug}
                type="button"
                data-outline-index={row.index}
                tabIndex={cursor === row.index ? 0 : -1}
                className="md-outline-entry"
                data-level={h.level}
                aria-current={index === active ? 'location' : undefined}
                title={h.title}
                style={{
                  transform: `translateY(${String(row.start)}px)`,
                  height: row.size,
                  paddingInlineStart: `calc(var(--piarc-space-2) + ${String(h.level - 1)} * var(--piarc-space-2))`,
                }}
                onFocus={() => {
                  setCursor(row.index);
                }}
                onClick={() => {
                  jump(h, index);
                }}
              >
                {h.title}
              </button>
            );
          })}
        </div>
      </div>
      {!items.length && <p role="status">{t('files.md.noHeadingsFound')}</p>}
    </div>
  );
}
