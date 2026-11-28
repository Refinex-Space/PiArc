// Session details form a single scrollable column of cards. Disclosure state and order belong to
// the window layout; the session data inside each card continues to follow its Core store.
//
// Moving a card: the whole card lifts and follows the pointer (or, from the keyboard, steps
// between slots) while the other cards slide aside to open its slot; on release it glides into
// that slot. Positions are written to the cards' styles directly so a drag never re-renders
// the cards' contents.
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { IconButton } from '../app/IconButton.js';
import { useT } from '../app/app-context.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { useSession } from '../store/hooks.js';
import { ChevronDownIcon, ComputerIcon, FolderIcon, GripIcon } from './icons.js';
import {
  dropIndex,
  edgeScroll,
  landingTop,
  shiftOf,
  usePresence,
  type Slot,
} from './rail-motion.js';
import {
  moveRailSection,
  railOrder,
  readRailPreferences,
  saveRailPreferences,
} from './rail-order.js';
import { useRequestedPanel, type PanelContext, type PanelSpec } from './registry.js';
import { baseName } from './ui.js';

function Environment({ sessionId }: { sessionId: string | undefined }) {
  const t = useT();
  const session = useSession(sessionId);
  const folder = session?.worktreePath ?? session?.cwd ?? session?.workspace;
  return (
    <>
      <div className="rail-environment-row">
        <ComputerIcon />
        <span>{t('workbench.local')}</span>
      </div>
      {folder && (
        <div className="rail-environment-row" title={folder}>
          <FolderIcon />
          <span>{baseName(folder)}</span>
          <small dir="auto">{folder}</small>
        </div>
      )}
    </>
  );
}

const environment: PanelSpec = {
  id: 'environment',
  title: 'panels.environment',
  initiallyExpanded: true,
  area: 'rail',
  order: 0,
  render: (context) => <Environment sessionId={context.sessionId} />,
};

/** Pointer travel before a press on a card's heading becomes a drag. */
const DRAG_THRESHOLD = 4;
const BODY_PROPERTIES = ['grid-template-rows'] as const;

/** A card being moved. Positions are in the scroll content's coordinates. */
interface Drag {
  readonly id: string;
  readonly mode: 'pointer' | 'keyboard';
  readonly from: number;
  to: number;
  readonly slots: readonly Slot[];
  /** The held card's height plus the gap: how far the others move aside. */
  readonly distance: number;
  readonly startY: number;
  readonly startScroll: number;
  y: number;
}

interface Press {
  readonly id: string;
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly heading: HTMLElement;
}

const translate = (y: number) => (y === 0 ? '' : `translate3d(0, ${String(y)}px, 0)`);

function RailCard({
  panel,
  context,
  expanded,
  headerId,
  hintId,
  held,
  onToggle,
  cardRef,
  gripRef,
  onGripClick,
  onGripKey,
  onPress,
}: {
  panel: PanelSpec;
  context: PanelContext;
  expanded: boolean;
  headerId: string;
  hintId: string;
  held: Drag['mode'] | undefined;
  onToggle: () => void;
  cardRef: (element: HTMLElement | null) => void;
  gripRef: (element: HTMLButtonElement | null) => void;
  onGripClick: () => void;
  onGripKey: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onPress: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const t = useT();
  const body = useRef<HTMLDivElement>(null);
  const phase = usePresence(expanded, body, BODY_PROPERTIES);
  const title = t(panel.title);
  return (
    <section
      ref={cardRef}
      className="rail-section"
      data-section={panel.id}
      data-held={held}
      data-collapsed={expanded ? undefined : true}
    >
      <div className="rail-heading" onPointerDown={onPress}>
        <h2>
          <button
            type="button"
            id={headerId}
            data-testid={'panel-tab-' + panel.id}
            aria-expanded={expanded}
            aria-controls={headerId + '-body'}
            onClick={onToggle}
          >
            <span className="rail-title">{title}</span>
            <ChevronDownIcon />
          </button>
        </h2>
        {panel.actions === undefined ? null : (
          <div className="rail-actions">{panel.actions(context)}</div>
        )}
        <IconButton
          className="rail-grip"
          label={t('rail.reorder', { name: title })}
          aria-describedby={hintId}
          aria-pressed={held !== undefined}
          ref={gripRef}
          data-testid={'rail-reorder-' + panel.id}
          onClick={onGripClick}
          onKeyDown={onGripKey}
        >
          <GripIcon />
        </IconButton>
      </div>
      <div
        ref={body}
        id={headerId + '-body'}
        className="rail-section-body"
        data-phase={phase}
        hidden={phase === 'closed'}
        role="group"
        aria-labelledby={headerId}
      >
        <div className="rail-section-inner">{phase !== 'closed' && panel.render(context)}</div>
      </div>
    </section>
  );
}

export function RailContents({
  context,
  registered,
  handled,
}: {
  context: PanelContext;
  registered: readonly PanelSpec[];
  handled: RefObject<ReturnType<typeof useRequestedPanel>>;
}) {
  const t = useT();
  const groupId = useId();
  const [preferences, setPreferences] = useState(readRailPreferences);
  // Which card is held, for its pressed grip and lifted style; positions live in `drag`.
  const [moving, setMoving] = useState<{ id: string; mode: Drag['mode'] } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const live = useRef<HTMLSpanElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const drag = useRef<Drag | null>(null);
  const press = useRef<Press | null>(null);
  /** Where each card was on screen just before a drop, to glide from (FLIP). */
  const settleFrom = useRef<Map<string, number> | null>(null);
  const request = useRequestedPanel();
  const sections = new Map(
    [environment, ...registered.filter((p) => p.area === 'rail')].map((panel) => [panel.id, panel]),
  );
  const order = railOrder([...sections.keys()], preferences.order);
  const content = order.flatMap((id) => {
    const panel = sections.get(id);
    return panel && (panel.when?.(context) ?? true) ? [panel] : [];
  });
  const visible = content.map((panel) => panel.id);
  // The latest values for the document-level pointer handlers.
  const latest = useRef({ order, visible });
  latest.current = { order, visible };

  useEffect(() => {
    saveRailPreferences(preferences);
  }, [preferences]);
  useEffect(() => {
    if (!request || handled.current === request) return;
    const card = cards.current.get(request.id);
    if (!card) return;
    handled.current = request;
    setPreferences((current) =>
      current.expanded[request.id] === true
        ? current
        : {
            ...current,
            expanded: { ...current.expanded, [request.id]: true },
          },
    );
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [request, handled, context]);

  // After a drop the cards are in their new order: start each from where it was on screen and
  // let it glide to its slot.
  useLayoutEffect(() => {
    const from = settleFrom.current;
    if (!from) return;
    settleFrom.current = null;
    const elements = [...cards.current.entries()];
    for (const [, element] of elements) {
      element.style.transition = 'none';
      element.style.transform = '';
    }
    const offsets = elements.map(([id, element]) => {
      const before = from.get(id);
      return before === undefined ? 0 : before - element.getBoundingClientRect().top;
    });
    elements.forEach(([, element], i) => {
      element.style.transform = translate(offsets[i] ?? 0);
    });
    scroller.current?.getBoundingClientRect();
    for (const [, element] of elements) {
      element.style.transition = '';
      element.style.transform = '';
    }
  }, [preferences.order]);

  const announce = (text: string) => {
    if (live.current) live.current.textContent = text;
  };
  const position = (id: string, to: number, done: boolean) => {
    const section = sections.get(id);
    if (!section) return;
    announce(
      t(done ? 'rail.placed' : 'rail.position', {
        name: t(section.title),
        position: to + 1,
        count: latest.current.visible.length,
      }),
    );
  };

  /** Writes the held card's and the others' positions. */
  const paint = (current: Drag) => {
    const scrolled = (scroller.current?.scrollTop ?? 0) - current.startScroll;
    current.slots.forEach((slot, i) => {
      const element = cards.current.get(slot.id);
      if (!element) return;
      if (i === current.from) {
        element.style.transform = translate(
          current.mode === 'pointer'
            ? current.y - current.startY + scrolled
            : landingTop(current.slots, current.from, current.to) - slot.top,
        );
      } else {
        element.style.transform = translate(shiftOf(i, current.from, current.to, current.distance));
      }
    });
  };

  const begin = (id: string, mode: Drag['mode'], y: number): Drag | null => {
    const ids = latest.current.visible;
    const from = ids.indexOf(id);
    const container = scroller.current;
    if (from < 0 || !container) return null;
    const slots = ids.flatMap((card): Slot[] => {
      const element = cards.current.get(card);
      return element ? [{ id: card, top: element.offsetTop, height: element.offsetHeight }] : [];
    });
    if (slots.length !== ids.length) return null;
    const gap = parseFloat(getComputedStyle(container).rowGap) || 0;
    const next: Drag = {
      id,
      mode,
      from,
      to: from,
      slots,
      distance: (slots[from]?.height ?? 0) + gap,
      startY: y,
      startScroll: container.scrollTop,
      y,
    };
    drag.current = next;
    // Lift at once so the first pointer move is followed directly, not eased.
    const held = cards.current.get(id);
    if (held) held.dataset.held = mode;
    setMoving({ id, mode });
    position(id, from, false);
    return next;
  };

  /** Moves the held card into its slot, or (`to` unchanged) lets everything glide back. */
  const finish = (cancelled: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    document.documentElement.classList.remove('is-rail-dragging');
    const { order: currentOrder, visible: currentVisible } = latest.current;
    const target = currentVisible[current.to];
    const next =
      cancelled || target === undefined
        ? currentOrder
        : moveRailSection(currentOrder, currentVisible, current.id, target);
    if (next !== currentOrder) {
      settleFrom.current = new Map(
        [...cards.current.entries()].map(([id, element]) => [
          id,
          element.getBoundingClientRect().top,
        ]),
      );
      setPreferences((prefs) => ({ ...prefs, order: next }));
    } else {
      for (const element of cards.current.values()) element.style.transform = '';
    }
    setMoving(null);
    if (cancelled) announce(t('rail.cancelled'));
    else position(current.id, current.to, true);
    requestAnimationFrame(() => handles.current.get(current.id)?.focus({ preventScroll: true }));
  };

  // Pointer dragging: listeners on the document while a heading is pressed.
  useEffect(() => {
    let frame = 0;
    let pointerY = 0;
    const autoScroll = () => {
      frame = 0;
      const current = drag.current;
      const container = scroller.current;
      if (current?.mode !== 'pointer' || !container) return;
      const box = container.getBoundingClientRect();
      const speed = edgeScroll(pointerY, box.top, box.bottom);
      if (speed === 0) return;
      const before = container.scrollTop;
      container.scrollTop += speed;
      if (container.scrollTop !== before) track(current);
      frame = requestAnimationFrame(autoScroll);
    };
    const track = (current: Drag) => {
      const slot = current.slots[current.from];
      if (!slot) return;
      const scrolled = (scroller.current?.scrollTop ?? 0) - current.startScroll;
      const top = slot.top + current.y - current.startY + scrolled;
      const to = dropIndex(current.slots, current.from, top);
      if (to !== current.to) {
        current.to = to;
        position(current.id, to, false);
      }
      paint(current);
    };
    const move = (event: PointerEvent) => {
      const pressed = press.current;
      if (pressed?.pointerId !== event.pointerId) return;
      pointerY = event.clientY;
      let current = drag.current;
      if (!current) {
        if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < DRAG_THRESHOLD)
          return;
        current = begin(pressed.id, 'pointer', pressed.y);
        if (!current) return;
        document.documentElement.classList.add('is-rail-dragging');
        try {
          pressed.heading.setPointerCapture(pressed.pointerId);
        } catch {
          // The pointer is already gone; its release ends the drag.
        }
      }
      event.preventDefault();
      current.y = event.clientY;
      track(current);
      if (!frame) frame = requestAnimationFrame(autoScroll);
    };
    const release = (event: PointerEvent) => {
      const pressed = press.current;
      if (pressed?.pointerId !== event.pointerId) return;
      press.current = null;
      if (drag.current?.mode !== 'pointer') return;
      // The press was a drag, not a click on the title or grip.
      const swallow = (click: MouseEvent) => {
        click.stopPropagation();
        click.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => {
        window.removeEventListener('click', swallow, { capture: true });
      }, 0);
      finish(event.type === 'pointercancel');
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || drag.current?.mode !== 'pointer') return;
      event.preventDefault();
      event.stopPropagation();
      press.current = null;
      finish(true);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', release);
    document.addEventListener('keydown', key, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', release);
      document.removeEventListener('pointercancel', release);
      document.removeEventListener('keydown', key, true);
      document.documentElement.classList.remove('is-rail-dragging');
    };
    // The handlers read `drag`, `press` and `latest`; they are installed once.
  }, []);

  const onPress = (id: string) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    if (event.target instanceof Element && event.target.closest('.rail-actions')) return;
    press.current = {
      id,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      heading: event.currentTarget,
    };
  };

  // Keyboard moving: Enter or Space on a grip picks the card up, arrows move it, Enter or Space
  // drops it, Escape (or leaving the column) puts it back.
  const pick = (id: string) => {
    const current = drag.current;
    if (current?.mode === 'keyboard') {
      if (current.id !== id) {
        const to = latest.current.visible.indexOf(id);
        if (to >= 0) current.to = to;
      }
      finish(false);
    } else if (!current) {
      const next = begin(id, 'keyboard', 0);
      if (next) paint(next);
    }
  };
  const gripKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (current?.mode !== 'keyboard' || isImeComposing(event.nativeEvent)) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const to = current.to + (event.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= current.slots.length) return;
    current.to = to;
    position(current.id, to, false);
    paint(current);
    const element = cards.current.get(current.id);
    const container = scroller.current;
    if (element && container) {
      const top = landingTop(current.slots, current.from, to);
      const bottom = top + element.offsetHeight;
      if (top < container.scrollTop) container.scrollTo({ top, behavior: 'smooth' });
      else if (bottom > container.scrollTop + container.clientHeight)
        container.scrollTo({ top: bottom - container.clientHeight, behavior: 'smooth' });
    }
  };

  return (
    <div
      ref={scroller}
      className="panel-body rail-sections"
      data-moving={moving ? moving.mode : undefined}
      onKeyDown={(event) => {
        if (drag.current?.mode !== 'keyboard' || event.key !== 'Escape') return;
        if (isImeComposing(event.nativeEvent)) return;
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      }}
      onBlur={(event) => {
        if (drag.current?.mode === 'keyboard' && !event.currentTarget.contains(event.relatedTarget))
          finish(true);
      }}
    >
      <span className="visually-hidden" id={groupId + '-reorder-hint'}>
        {t('rail.reorderHint')}
      </span>
      <span className="visually-hidden" role="status" aria-atomic="true" ref={live} />
      {content.map((panel) => {
        const id = panel.id;
        const expanded = preferences.expanded[id] ?? panel.initiallyExpanded ?? false;
        return (
          <RailCard
            key={id}
            panel={panel}
            context={context}
            expanded={expanded}
            headerId={groupId + '-' + id}
            hintId={groupId + '-reorder-hint'}
            held={moving?.id === id ? moving.mode : undefined}
            cardRef={(element) => {
              if (element) cards.current.set(id, element);
              else cards.current.delete(id);
            }}
            gripRef={(element) => {
              if (element) handles.current.set(id, element);
              else handles.current.delete(id);
            }}
            onToggle={() => {
              if (drag.current) return;
              setPreferences((current) => ({
                ...current,
                expanded: { ...current.expanded, [id]: !expanded },
              }));
            }}
            onGripClick={() => {
              pick(id);
            }}
            onGripKey={gripKey}
            onPress={onPress(id)}
          />
        );
      })}
    </div>
  );
}
