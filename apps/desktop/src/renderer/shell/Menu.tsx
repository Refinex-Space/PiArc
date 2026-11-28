import { documentWindow, useSurfaceDocument } from '../app/surface-document.js';
// A small popup menu (sidebar row and group actions): opens from its button or with a right
// click, arrow keys move, Enter or a click runs an item, Escape or a click outside closes it.
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
  type CSSProperties,
} from 'react';

import { useT } from '../app/app-context.js';
import { useOverlayRect } from '../app/overlays.js';
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon } from './icons.js';
import { revealListOption } from '../app/list-navigation.js';
import { isImeComposing } from '../composer/ime-guard.js';

export type MenuItem = {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly selected?: boolean;
  readonly testId?: string;
  readonly danger?: boolean;
  /** Shown but not selectable; `hint` says why. */
  readonly disabled?: boolean;
  /** A second line under the label. */
  readonly hint?: string;
  readonly tooltip?: string;
  readonly shortcut?: string;
  /** A submenu the filter searches: a query lists its matching items in its place, each with
   * this item's label in front of its hint. */
  readonly searchable?: boolean;
} & (
  | { readonly submenu: readonly MenuItem[]; readonly run?: never }
  | { readonly submenu?: never; readonly run: () => void }
);

interface MenuPoint {
  readonly x: number;
  readonly y: number;
  readonly above?: boolean;
  /** `x` is the menu's right edge (a menu opened under a button at the end of a toolbar). */
  readonly end?: boolean;
  /** The other edge and usable width for a submenu beside its parent. */
  readonly cascade?: {
    readonly leftEdge: number;
    readonly rightRoom: number;
    readonly maxWidth: number;
  };
  readonly anchor?: HTMLElement;
}

export function useMenu() {
  const [open, setOpen] = useState<MenuPoint | null>(null);
  const close = useCallback(() => {
    setOpen(null);
  }, []);
  return {
    open,
    openAt: (x: number, y: number, anchor?: HTMLElement) => {
      setOpen(anchor ? { x, y, anchor } : { x, y });
    },
    openAbove: (button: HTMLElement) => {
      const rect = button.getBoundingClientRect();
      setOpen({ x: rect.left, y: rect.top - 4, above: true });
    },
    /** Under `button`, the menu's right edge on the button's, whatever the menu's width. */
    openBelowEnd: (button: HTMLElement) => {
      const rect = button.getBoundingClientRect();
      setOpen({ x: rect.right, y: rect.bottom + 4, end: true, anchor: button });
    },
    close,
  };
}

export function MenuPopup({
  items: choices,
  at,
  numbered = false,
  heading,
  filterLabel,
  branch,
  backLabel,
  onClose,
  label,
  testId,
}: {
  readonly items: readonly MenuItem[];
  readonly numbered?: boolean;
  readonly at: MenuPoint;
  readonly heading?: string;
  readonly filterLabel?: string;
  readonly backLabel?: string;
  readonly branch?: {
    readonly group: string;
    readonly dismiss: () => void;
    readonly keyboard: boolean;
  };
  readonly onClose: () => void;
  readonly label: string;
  readonly testId?: string;
}) {
  const ownerDoc = useSurfaceDocument();
  const win = documentWindow(ownerDoc);
  const ref = useRef<HTMLDivElement>(null);
  // A menu over the preview's page would be hidden behind it (B1.5.2).
  useOverlayRect(ref);
  const [active, setActive] = useState(backLabel && choices.length ? 1 : 0);
  const [query, setQuery] = useState('');
  const filter = useRef<HTMLInputElement>(null);
  const filteredItems = useRef<HTMLDivElement>(null);
  const back: MenuItem | undefined = backLabel
    ? { id: 'back-to-parent', label: backLabel, icon: <ChevronLeftIcon />, run: onClose }
    : undefined;
  const needle = query.trim().toLowerCase();
  const matches = (item: MenuItem) =>
    `${item.label} ${item.hint ?? ''}`.toLowerCase().includes(needle);
  const filtered = needle
    ? choices.flatMap((item): MenuItem[] => {
        if (!item.searchable || !item.submenu) return matches(item) ? [item] : [];
        return item.submenu.flatMap((child): MenuItem[] => {
          if (child.submenu) return [];
          const found: MenuItem = {
            ...child,
            hint: child.hint ? `${item.label} · ${child.hint}` : item.label,
          };
          return matches(found) ? [found] : [];
        });
      })
    : choices;
  const items = back ? [back, ...filtered] : filtered;
  const id = useId();
  const group = branch?.group ?? id;
  const dismiss = branch?.dismiss ?? onClose;
  const [child, setChild] = useState<{
    id: string;
    at: MenuPoint;
    keyboard: boolean;
    replacesParent: boolean;
  }>();
  const [left, setLeft] = useState(at.x);
  const [top, setTop] = useState(at.y);
  useLayoutEffect(() => {
    const width = ref.current?.getBoundingClientRect().width ?? 0;
    setLeft(at.cascade && width > at.cascade.rightRoom ? at.cascade.leftEdge - width : at.x);
  }, [at, choices, win]);
  const returnToParent = useRef(false);
  const closeChild = useCallback(() => {
    returnToParent.current = true;
    setChild(undefined);
  }, []);
  useLayoutEffect(() => {
    if (!child && returnToParent.current) {
      returnToParent.current = false;
      (filter.current ?? ref.current)?.focus();
    }
  }, [child]);
  const activeChild = child && items.find((item) => item.id === child.id);
  const openChild = (item: MenuItem, index: number, interaction: 'hover' | 'click' | 'key') => {
    if (!item.submenu || item.disabled) return;
    const anchor = ownerDoc.getElementById(`${id}-${String(index)}`);
    const menu = ref.current;
    if (!anchor || !menu) return;
    const row = anchor.getBoundingClientRect(),
      panel = menu.getBoundingClientRect();
    const css = win.getComputedStyle(menu);
    const gap = parseFloat(css.getPropertyValue('--piarc-space-1')) || 4;
    const inset = parseFloat(css.getPropertyValue('--piarc-space-2')) || 8;
    const rightRoom = win.innerWidth - inset - panel.right - gap;
    const leftRoom = panel.left - gap - inset;
    const maxWidth = Math.max(leftRoom, rightRoom);
    const replacesParent = maxWidth < (parseFloat(css.minWidth) || 128);
    // A compact replacement is a navigation action. Hover can still inspect sibling rows.
    if (replacesParent && interaction === 'hover') return;
    setChild({
      id: item.id,
      replacesParent,
      keyboard: interaction !== 'hover',
      at: replacesParent
        ? { x: panel.left, y: panel.top }
        : {
            x: panel.right + gap,
            y: row.top - menu.clientTop - (parseFloat(css.paddingTop) || 0),
            cascade: { leftEdge: panel.left - gap, rightRoom, maxWidth },
          },
    });
  };
  // Closing gives the focus back to what had it, when nothing else took it (an item that opens
  // a rename field keeps that field focused): otherwise it falls to the page body (R5).
  useEffect(() => {
    const previous = ownerDoc.activeElement;
    return () => {
      const now = ownerDoc.activeElement;
      if (
        (now === null || now === ownerDoc.body) &&
        (previous instanceof HTMLElement || previous instanceof win.HTMLElement)
      ) {
        if (previous.isConnected) previous.focus();
      }
    };
  }, [ownerDoc, win]);
  useEffect(() => {
    if (!branch || branch.keyboard) (filter.current ?? ref.current)?.focus();
    const away = (event: MouseEvent) => {
      if (
        !(event.target instanceof Element || event.target instanceof win.Element) ||
        event.target.closest<HTMLElement>('[data-menu-tree]')?.dataset.menuTree !== group
      ) {
        dismiss();
      }
    };
    win.addEventListener('mousedown', away, true);
    win.addEventListener('blur', dismiss);
    return () => {
      win.removeEventListener('mousedown', away, true);
      win.removeEventListener('blur', dismiss);
    };
  }, [branch?.keyboard, dismiss, group, win]);
  useEffect(() => {
    const repositioned = (event: Event) => {
      if (
        (event.target instanceof Element || event.target instanceof win.Element) &&
        event.target.closest<HTMLElement>('[data-menu-tree]')?.dataset.menuTree === group
      )
        return;
      // A roving tab can scroll into place just after its keyboard menu opens.
      // Keep that menu anchored and ignore scrolls from unrelated panels.
      if (at.anchor?.isConnected && event.type === 'scroll') {
        if (event.target instanceof win.Element && !event.target.contains(at.anchor)) return;
        const rect = at.anchor.getBoundingClientRect();
        setLeft(at.end === true ? rect.right : rect.left);
        setTop(rect.bottom);
        return;
      }
      dismiss();
    };
    win.addEventListener('resize', repositioned);
    ownerDoc.addEventListener('scroll', repositioned, true);
    return () => {
      win.removeEventListener('resize', repositioned);
      ownerDoc.removeEventListener('scroll', repositioned, true);
    };
  }, [at, dismiss, group, win, ownerDoc]);
  const run = (item: MenuItem | undefined, keyboard = true) => {
    if (item !== undefined && item.disabled !== true) {
      if (item === back) onClose();
      else if (item.submenu) openChild(item, items.indexOf(item), keyboard ? 'key' : 'click');
      else {
        dismiss();
        item.run();
      }
    }
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isImeComposing(event.nativeEvent)) {
      return;
    }
    if (event.target === filter.current && [' ', 'Home', 'End'].includes(event.key)) return;
    if (numbered && /^[1-9]$/u.test(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      run(items[Number(event.key) - 1]);
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (event.target === filter.current) filteredItems.current?.focus();
        setChild(undefined);
        if (items.length === 0) break;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = (active + step + items.length) % items.length;
        setActive(next);
        revealListOption(ownerDoc.getElementById(`${id}-${String(next)}`));
        break;
      }
      case 'ArrowRight': {
        const item = items[active];
        if (!item?.submenu) return;
        openChild(item, active, 'key');
        break;
      }
      case 'ArrowLeft':
        if (!branch) return;
        onClose();
        break;
      case 'Home':
      case 'End': {
        const next = event.key === 'Home' ? 0 : Math.max(0, items.length - 1);
        setActive(next);
        revealListOption(ownerDoc.getElementById(`${id}-${String(next)}`));
        break;
      }
      case 'Enter':
      case ' ':
        run(items[active]);
        break;
      case 'Escape':
        if (child) closeChild();
        else onClose();
        break;
      case 'Tab':
        dismiss();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  // Percentages in translate resolve against the rendered menu, including gaps and wrapped hints.
  const style: CSSProperties = {
    transform: `translate(clamp(var(--menu-edge), calc(${String(left)}px - ${at.end === true ? '100%' : '0%'}), calc(100vw - 100% - var(--menu-edge))), clamp(var(--menu-edge), calc(${String(top)}px - ${at.above === true ? '100%' : '0%'}), calc(100vh - 100% - var(--menu-edge))))`,
    ...(at.cascade ? { maxWidth: `min(23rem, ${String(at.cascade.maxWidth)}px)` } : {}),
  };
  const ChildMenu = child?.replacesParent ? CompactSubmenu : MenuPopup;
  const activeId = items[active] ? `${id}-${String(active)}` : undefined;
  const rows = items.map((item, i) => (
    <div
      key={item.id}
      id={`${id}-${String(i)}`}
      role="menuitem"
      data-tooltip={item.tooltip}
      aria-description={item.tooltip}
      tabIndex={-1}
      aria-disabled={item.disabled === true ? true : undefined}
      aria-describedby={item.hint === undefined ? undefined : `${id}-${String(i)}-hint`}
      className={`menu-item${i === active ? ' is-active' : ''}${item.danger === true ? ' is-danger' : ''}${item.disabled === true ? ' is-disabled' : ''}`}
      aria-haspopup={item.submenu ? 'menu' : undefined}
      aria-expanded={item.submenu ? child?.id === item.id : undefined}
      aria-current={item.selected === true ? 'true' : undefined}
      data-testid={item.testId ?? `menu-${item.id}`}
      onMouseEnter={() => {
        setActive(i);
        if (item.submenu) openChild(item, i, 'hover');
        else setChild(undefined);
      }}
      onClick={() => {
        run(item, false);
      }}
    >
      <span className="menu-item-line">
        {item.icon}
        <span className="menu-item-text">{item.label}</span>
        {item.selected === true && <CheckIcon />}
        {item.submenu && <ChevronRightIcon />}
        {item.shortcut && (
          <span className="menu-shortcut" aria-hidden="true">
            {item.shortcut}
          </span>
        )}
        {numbered && (
          <span className="menu-shortcut" aria-hidden="true">
            {i + 1}
          </span>
        )}
      </span>
      {item.hint !== undefined && (
        <span id={`${id}-${String(i)}-hint`} className="menu-item-hint">
          {item.hint}
        </span>
      )}
    </div>
  ));
  return (
    <>
      <div
        ref={ref}
        data-menu-tree={group}
        hidden={!!child?.replacesParent && !!activeChild?.submenu}
        className="interactive-list menu"
        data-tooltip-side="end"
        role={filterLabel === undefined ? 'menu' : 'dialog'}
        aria-label={label}
        tabIndex={-1}
        style={style}
        onKeyDown={onKeyDown}
        data-testid={testId}
        aria-activedescendant={filterLabel === undefined ? activeId : undefined}
      >
        {filterLabel !== undefined && (
          <input
            ref={filter}
            className="menu-filter"
            aria-label={filterLabel}
            placeholder={filterLabel}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
              setChild(undefined);
            }}
          />
        )}
        {heading !== undefined && (
          <div className="menu-heading" role="presentation">
            {heading}
          </div>
        )}
        {filterLabel !== undefined ? (
          <div
            role="menu"
            aria-label={label}
            tabIndex={-1}
            ref={filteredItems}
            aria-activedescendant={activeId}
          >
            {rows}
          </div>
        ) : (
          rows
        )}
      </div>
      {child && activeChild?.submenu && (
        <ChildMenu
          key={child.id}
          at={child.at}
          label={activeChild.label}
          items={activeChild.submenu}
          onClose={closeChild}
          branch={{ group, dismiss, keyboard: child.keyboard }}
        />
      )}
    </>
  );
}

function CompactSubmenu(props: ComponentProps<typeof MenuPopup>) {
  const t = useT();
  return <MenuPopup {...props} backLabel={t('nav.back')} />;
}

/** A button that opens a menu below itself. */
export function MenuButton({
  label,
  items,
  testId,
  children,
}: {
  readonly label: string;
  readonly items: readonly MenuItem[];
  readonly testId?: string;
  readonly children: ReactNode;
}) {
  const menu = useMenu();
  return (
    <>
      <button
        type="button"
        className="icon-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu.open !== null}
        data-testid={testId}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          menu.openAt(box.left, box.bottom + 4);
        }}
      >
        {children}
      </button>
      {menu.open !== null && (
        <MenuPopup items={items} at={menu.open} onClose={menu.close} label={label} />
      )}
    </>
  );
}

/** Name a selector with the displayed value first so speech input and readers can use it. */
export function choiceName(value: string, purpose: string): string {
  return value === purpose ? value : `${value} · ${purpose}`;
}

/** A compact choice or action menu attached to a button in the composer or environment card. */
export function ChoiceButton({
  label,
  valueLabel,
  children,
  items,
  testId,
  disabled,
  value,
  heading,
  filterLabel,
  onOpen,
  above = true,
  className = '',
  buttonRef,
}: {
  readonly label: string;
  readonly valueLabel?: string;
  readonly children: ReactNode;
  readonly items: readonly MenuItem[];
  readonly testId?: string;
  readonly disabled?: boolean;
  readonly heading?: string;
  /** Adds a search field with this label above the items. */
  readonly filterLabel?: string;
  readonly value?: string | undefined;
  readonly above?: boolean;
  readonly className?: string;
  readonly onOpen?: () => void;
  readonly buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  const menu = useMenu();
  return (
    <>
      <button
        type="button"
        className={`choice-button ${className}`}
        title={label}
        aria-label={valueLabel === undefined ? undefined : choiceName(valueLabel, label)}
        aria-haspopup="menu"
        aria-expanded={menu.open !== null}
        disabled={disabled}
        value={value}
        ref={buttonRef}
        data-testid={testId}
        onClick={(event) => {
          onOpen?.();
          if (above) menu.openAbove(event.currentTarget);
          else {
            const box = event.currentTarget.getBoundingClientRect();
            menu.openAt(box.left, box.bottom + 4);
          }
        }}
      >
        {children}
      </button>
      {menu.open && (
        <MenuPopup
          label={label}
          {...(heading ? { heading } : {})}
          {...(filterLabel ? { filterLabel } : {})}
          at={menu.open}
          items={items}
          onClose={menu.close}
        />
      )}
    </>
  );
}
