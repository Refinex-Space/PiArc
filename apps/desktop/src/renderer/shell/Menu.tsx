// A small popup menu (sidebar row and group actions): opens from its button or with a right
// click, arrow keys move, Enter or a click runs an item, Escape or a click outside closes it.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { isImeComposing } from '../composer/ime-guard.js';

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly danger?: boolean;
  readonly run: () => void;
}

export function useMenu() {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  return {
    open,
    openAt: (x: number, y: number) => {
      setOpen({ x, y });
    },
    close: () => {
      setOpen(null);
    },
  };
}

export function MenuPopup({
  items,
  at,
  numbered = false,
  onClose,
  label,
  testId,
}: {
  readonly items: readonly MenuItem[];
  readonly numbered?: boolean;
  readonly at: { x: number; y: number };
  readonly onClose: () => void;
  readonly label: string;
  readonly testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const id = useId();
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
    ref.current?.focus();
    const away = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) {
        onClose();
      }
    };
    window.addEventListener('mousedown', away, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', away, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  const run = (item: MenuItem | undefined) => {
    if (item !== undefined) {
      onClose();
      item.run();
    }
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isImeComposing(event.nativeEvent)) {
      return;
    }
    if (numbered && /^[1-9]$/u.test(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      run(items[Number(event.key) - 1]);
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        setActive((i) => (i + 1) % items.length);
        break;
      case 'ArrowUp':
        setActive((i) => (i - 1 + items.length) % items.length);
        break;
      case 'Enter':
      case ' ':
        run(items[active]);
        break;
      case 'Escape':
      case 'Tab':
        onClose();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  // Keep the menu inside the window.
  const style = {
    left: Math.min(at.x, window.innerWidth - 200),
    top: Math.min(at.y, window.innerHeight - 32 * items.length - 16),
  };
  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={style}
      onKeyDown={onKeyDown}
      data-testid={testId}
      aria-activedescendant={`${id}-${String(active)}`}
    >
      {items.map((item, i) => (
        <div
          key={item.id}
          id={`${id}-${String(i)}`}
          role="menuitem"
          tabIndex={-1}
          className={`menu-item${i === active ? ' is-active' : ''}${item.danger === true ? ' is-danger' : ''}`}
          data-testid={`menu-${item.id}`}
          onMouseEnter={() => {
            setActive(i);
          }}
          onClick={() => {
            run(item);
          }}
        >
          {numbered ? `${String(i + 1)} · ` : null}
          {item.label}
        </div>
      ))}
    </div>
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
