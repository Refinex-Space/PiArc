// The comment editor of the plan panel (ADR-0103): a small floating field next to the passage,
// opened by selecting text or by clicking a marked passage. Enter saves, Shift+Enter breaks the
// line, Esc closes; a press outside closes it while nothing was typed. It sits 8 px under the
// passage's last line, centred on it, flips above when there is no room and keeps 8 px inside
// the plan's area (a narrow panel makes it narrower rather than letting it cover the chat). The passage keeps its selection colour while the field has focus (the panel draws
// it as a custom highlight).
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useT } from '../app/app-context.js';
import { IconButton } from '../app/IconButton.js';
import { CommentAddIcon, TrashIcon } from '../shell/icons.js';
import { isImeComposing } from '../composer/ime-guard.js';

const GAP = 8;
const MARGIN = 8;
const WIDTH = 320;

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Where the popover goes for an anchor rectangle, kept inside `area` (the plan's area within the
 * window): its width (at most 320 px, less in a narrow area), left edge and top, and the side.
 */
export function popoverPlace(
  anchor: Box,
  height: number,
  area: Box,
): { left: number; top: number; width: number; side: 'below' | 'above' } {
  const width = Math.max(0, Math.min(WIDTH, area.right - area.left - 2 * MARGIN));
  const centre = (anchor.left + anchor.right) / 2;
  const left = Math.min(
    Math.max(area.left + MARGIN, centre - width / 2),
    area.right - MARGIN - width,
  );
  const below = anchor.bottom + GAP;
  if (below + height <= area.bottom - MARGIN || anchor.top - GAP - height < area.top + MARGIN) {
    return { left, width, top: Math.min(below, area.bottom - MARGIN - height), side: 'below' };
  }
  return { left, width, top: anchor.top - GAP - height, side: 'above' };
}

export function PlanCommentPopover({
  host,
  area,
  anchor,
  initial,
  editing,
  error,
  onSave,
  onDelete,
  onClose,
  onDismiss,
  onChange,
}: {
  /** The document the plan is in (a popped-out tool has its own). */
  readonly host: Document;
  /** The plan's area in the window's coordinates: the popover stays inside it. */
  readonly area: () => Box | undefined;
  /** The passage's last line (below) and first line (above), in the window's coordinates. */
  readonly anchor: () => { left: number; right: number; top: number; bottom: number } | undefined;
  readonly initial: string;
  /** An existing comment: the field starts with its text and offers delete. */
  readonly editing: boolean;
  readonly error?: string | undefined;
  readonly onSave: (text: string) => void;
  readonly onDelete?: (() => void) | undefined;
  readonly onClose: () => void;
  /** A press outside the field while nothing new was typed (defaults to `onClose`). */
  readonly onDismiss?: (() => void) | undefined;
  /** Whether the field holds text that differs from what it started with. */
  readonly onChange?: ((unsaved: boolean) => void) | undefined;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initial);
  const latest = useRef({ text, initial, dismiss: onDismiss ?? onClose });
  latest.current = { text, initial, dismiss: onDismiss ?? onClose };
  const [place, setPlace] = useState<{ left: number; top: number; width: number } | undefined>(
    undefined,
  );

  useLayoutEffect(() => {
    const element = box.current;
    const win = element?.ownerDocument.defaultView;
    if (element === null || win === null || win === undefined) return;
    let frame = 0;
    const measure = () => {
      const at = anchor();
      if (at === undefined) return;
      const view = { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight };
      const inside = area() ?? view;
      const next = popoverPlace(at, element.offsetHeight, {
        left: Math.max(view.left, inside.left),
        right: Math.min(view.right, inside.right),
        top: Math.max(view.top, inside.top),
        bottom: Math.min(view.bottom, inside.bottom),
      });
      setPlace((old) =>
        old?.left === next.left && old.top === next.top && old.width === next.width
          ? old
          : { left: next.left, top: next.top, width: next.width },
      );
    };
    const schedule = () => {
      win.cancelAnimationFrame(frame);
      frame = win.requestAnimationFrame(measure);
    };
    measure();
    field.current?.focus({ preventScroll: true });
    const resize = new win.ResizeObserver(schedule);
    resize.observe(element);
    win.addEventListener('scroll', schedule, true);
    win.addEventListener('resize', schedule);
    const press = (event: PointerEvent) => {
      if (event.target instanceof Node && element.contains(event.target)) return;
      const now = latest.current;
      if (!now.text.trim() || now.text === now.initial) now.dismiss();
    };
    element.ownerDocument.addEventListener('pointerdown', press, true);
    return () => {
      win.cancelAnimationFrame(frame);
      resize.disconnect();
      win.removeEventListener('scroll', schedule, true);
      win.removeEventListener('resize', schedule);
      element.ownerDocument.removeEventListener('pointerdown', press, true);
    };
  }, [anchor, area]);

  const save = () => {
    if (text.trim()) onSave(text);
  };
  return createPortal(
    <div
      ref={box}
      className="plan-comment-popover"
      role="dialog"
      aria-label={t('plan.comment.label')}
      data-testid="plan-comment-popover"
      data-placed={place !== undefined}
      style={
        place === undefined ? undefined : { left: place.left, top: place.top, width: place.width }
      }
    >
      <div className="plan-comment-row">
        {/* The popover is the field: no box or focus outline of its own inside it. */}
        <textarea
          ref={field}
          rows={1}
          data-focus-proxy
          value={text}
          placeholder={t('plan.comment.placeholder')}
          aria-label={t('plan.comment.placeholder')}
          data-testid="plan-comment-input"
          onChange={(event) => {
            setText(event.target.value);
            onChange?.(event.target.value.trim() !== '' && event.target.value !== initial);
          }}
          onKeyDown={(event) => {
            if (isImeComposing(event.nativeEvent)) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            } else if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
              event.preventDefault();
              if (!event.repeat) save();
            }
          }}
        />
        <span className="plan-comment-buttons">
          {editing && onDelete !== undefined ? (
            <IconButton
              size="xs"
              className="plan-comment-delete"
              label={t('plan.comment.delete')}
              data-testid="plan-comment-delete"
              onClick={onDelete}
            >
              <TrashIcon />
            </IconButton>
          ) : null}
          <IconButton
            size="xs"
            label={t('plan.comment.save')}
            keys="Enter"
            data-testid="plan-comment-add"
            disabled={!text.trim()}
            onClick={save}
          >
            <CommentAddIcon />
          </IconButton>
        </span>
      </div>
      {error ? (
        <p className="plan-comment-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>,
    host.body,
  );
}
