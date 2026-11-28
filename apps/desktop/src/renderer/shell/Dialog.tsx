// A modal dialog: focus moves into it when it opens and back when it closes, Tab stays inside,
// Escape cancels (unless an input method is composing). A dialog whose content changes in place
// (`focusKey`) moves focus to the new content: the control that had it is gone.
import { useEffect, useRef, type ReactNode } from 'react';

import { documentWindow, useSurfaceDocument } from '../app/surface-document.js';
import { isImeComposing } from '../composer/ime-guard.js';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function Dialog({
  labelledBy,
  onCancel,
  children,
  testId,
  wide = false,
  className,
  focusKey,
  dismissOnBackdrop = false,
}: {
  readonly labelledBy: string;
  readonly onCancel: () => void;
  readonly children: ReactNode;
  readonly testId?: string;
  readonly wide?: boolean;
  readonly className?: string;
  /** Changes when the content is replaced in place. */
  readonly focusKey?: string;
  readonly dismissOnBackdrop?: boolean;
}) {
  const ownerDoc = useSurfaceDocument();
  const ref = useRef<HTMLDivElement>(null);
  const backdropPress = useRef(false);
  useEffect(() => {
    const active = ownerDoc.activeElement;
    const previous =
      active instanceof HTMLElement || active instanceof documentWindow(ownerDoc).HTMLElement
        ? active
        : null;
    return () => {
      previous?.focus();
    };
  }, [ownerDoc]);
  useEffect(() => {
    const dialog = ref.current;
    const first =
      dialog?.querySelector<HTMLElement>('[data-autofocus]') ??
      dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialog)?.focus();
  }, [focusKey]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event.nativeEvent)) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== 'Tab' || ref.current === null) {
      return;
    }
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    if (event.shiftKey && ownerDoc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && ownerDoc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div
      className="scrim"
      role="presentation"
      onPointerDown={(event) => {
        backdropPress.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (dismissOnBackdrop && backdropPress.current && event.target === event.currentTarget)
          onCancel();
        backdropPress.current = false;
      }}
    >
      <div
        ref={ref}
        className={['dialog', wide && 'dialog-wide', className].filter(Boolean).join(' ')}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={labelledBy}
        data-testid={testId}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}
