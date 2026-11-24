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
} from 'react';

import { CheckIcon, ChevronRightIcon } from './icons.js';
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
} & (
  | { readonly submenu: readonly MenuItem[]; readonly run?: never }
  | { readonly submenu?: never; readonly run: () => void }
);

interface MenuPoint {
  readonly x: number;
  readonly y: number;
  readonly above?: boolean;
  readonly flipLeft?: number;
}

export function useMenu() {
  const [open, setOpen] = useState<MenuPoint | null>(null);
  const close = useCallback(() => {
    setOpen(null);
  }, []);
  return {
    open,
    openAt: (x: number, y: number) => {
      setOpen({ x, y });
    },
    openAbove: (button: HTMLElement) => {
      const rect = button.getBoundingClientRect();
      setOpen({ x: rect.left, y: rect.top - 4, above: true });
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
  onClose,
  label,
  testId,
}: {
  readonly items: readonly MenuItem[];
  readonly numbered?: boolean;
  readonly at: MenuPoint;
  readonly heading?: string;
  readonly filterLabel?: string;
  readonly branch?: {
    readonly group: string;
    readonly dismiss: () => void;
    readonly keyboard: boolean;
  };
  readonly onClose: () => void;
  readonly label: string;
  readonly testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');
  const filter = useRef<HTMLInputElement>(null);
  const filteredItems = useRef<HTMLDivElement>(null);
  const items = query.trim()
    ? choices.filter((item) =>
        `${item.label} ${item.hint ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : choices;
  const id = useId();
  const group = branch?.group ?? id;
  const dismiss = branch?.dismiss ?? onClose;
  const [child, setChild] = useState<{ id: string; at: MenuPoint; keyboard: boolean }>();
  const [left, setLeft] = useState(at.x);
  useLayoutEffect(() => {
    const width = ref.current?.offsetWidth ?? 0;
    setLeft(
      at.flipLeft !== undefined && at.x + width > window.innerWidth ? at.flipLeft - width : at.x,
    );
  }, [at, choices]);
  const closeChild = useCallback(() => {
    setChild(undefined);
    (filter.current ?? ref.current)?.focus();
  }, []);
  const activeChild = child && items.find((item) => item.id === child.id);
  const openChild = (item: MenuItem, index: number, keyboard: boolean) => {
    if (!item.submenu || item.disabled) return;
    const anchor = document.getElementById(`${id}-${String(index)}`);
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setChild({ id: item.id, at: { x: rect.right, y: rect.top, flipLeft: rect.left }, keyboard });
  };
  // Closing gives the focus back to what had it, when nothing else took it (an item that opens
  // a rename field keeps that field focused): otherwise it falls to the page body (R5).
  useEffect(() => {
    const previous = document.activeElement;
    return () => {
      const now = document.activeElement;
      if ((now === null || now === document.body) && previous instanceof HTMLElement) {
        if (previous.isConnected) previous.focus();
      }
    };
  }, []);
  useEffect(() => {
    if (!branch || branch.keyboard) (filter.current ?? ref.current)?.focus();
    const away = (event: MouseEvent) => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest<HTMLElement>('[data-menu-tree]')?.dataset.menuTree !== group
      ) {
        dismiss();
      }
    };
    window.addEventListener('mousedown', away, true);
    window.addEventListener('blur', dismiss);
    return () => {
      window.removeEventListener('mousedown', away, true);
      window.removeEventListener('blur', dismiss);
    };
  }, [branch?.keyboard, dismiss, group]);
  useEffect(() => {
    const repositioned = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest<HTMLElement>('[data-menu-tree]')?.dataset.menuTree === group
      )
        return;
      dismiss();
    };
    window.addEventListener('resize', repositioned);
    document.addEventListener('scroll', repositioned, true);
    return () => {
      window.removeEventListener('resize', repositioned);
      document.removeEventListener('scroll', repositioned, true);
    };
  }, [dismiss, group]);
  const run = (item: MenuItem | undefined, keyboard = true) => {
    if (item !== undefined && item.disabled !== true) {
      if (item.submenu) openChild(item, items.indexOf(item), keyboard);
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
        revealListOption(document.getElementById(`${id}-${String(next)}`));
        break;
      }
      case 'ArrowRight': {
        const item = items[active];
        if (!item?.submenu) return;
        openChild(item, active, true);
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
        revealListOption(document.getElementById(`${id}-${String(next)}`));
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
  const style = {
    transform: `translate(clamp(0px, ${String(left)}px, calc(100vw - 100%)), clamp(0px, calc(${String(at.y)}px - ${at.above === true ? '100%' : '0%'}), calc(100vh - 100%)))`,
  };
  const activeId = items[active] ? `${id}-${String(active)}` : undefined;
  const rows = items.map((item, i) => (
    <div
      key={item.id}
      id={`${id}-${String(i)}`}
      role="menuitem"
      title={item.tooltip}
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
        if (item.submenu) openChild(item, i, false);
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
        className="interactive-list menu"
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
        <MenuPopup
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
          at={menu.open}
          items={items}
          onClose={menu.close}
        />
      )}
    </>
  );
}
