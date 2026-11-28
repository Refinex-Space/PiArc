// Pointer, wheel and links of a terminal view (T34). Every press, drag and release goes to
// Core in device pixels of the canvas: a program that tracks the mouse gets it, otherwise it
// becomes a selection (libghostty-vt's gesture; a double click selects a word, a triple click a
// line, Shift extends) that comes back in the frames. The wheel goes the same way (scrollback,
// or arrow keys on the alternate screen). Mod+click (⌘ on macOS, Ctrl elsewhere) opens the link
// under the pointer, an OSC 8 hyperlink or a plain URL, after the owner shows its address and
// asks (the main process confirms again before `shell.openExternal`).
import type { TerminalLinkInfo, TerminalMouseMessage } from '../../shared/ipc.js';
import type { FrameCell } from './frame/decoder.js';
import { urlAt } from './links.js';
import type { CellSpan } from './vendor/ghostty-web/renderer.js';

/** While a drag is above or below the canvas, how often the selection scrolls one row. */
export const AUTOSCROLL_MS = 50;

/** Most wheel steps one wheel event sends. */
const MAX_WHEEL_STEPS = 50;

export interface PointerHost {
  readonly platform: 'mac' | 'other';
  attached(): boolean;
  /** Device pixels per CSS pixel. */
  ratio(): number;
  /** Cell size in device pixels. */
  cell(): { width: number; height: number };
  size(): { cols: number; rows: number };
  row(y: number): readonly FrameCell[];
  focus(): void;
  mouse(event: TerminalMouseMessage): void;
  linkAt(col: number, row: number): Promise<TerminalLinkInfo | null>;
  hover(link: (CellSpan & { readonly row: number }) | null): void;
  open(uri: string): void;
}

/** DOM button (0 left, 1 middle, 2 right) → Core button (1 left, 2 right, 3 middle). */
const BUTTONS: Readonly<Record<number, number>> = { 0: 1, 1: 3, 2: 2 };

function mods(event: MouseEvent): number {
  return (
    (event.shiftKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.altKey ? 4 : 0) |
    (event.metaKey ? 8 : 0)
  );
}

/** Wires `canvas`; returns the function that unwires it. */
export function attachPointer(host: PointerHost, canvas: HTMLCanvasElement): () => void {
  const target = canvas.ownerDocument.defaultView ?? window;
  let held: number | undefined;
  let last: { x: number; y: number; mods: number } | undefined;
  let autoscroll = 0;
  let wheel = 0;
  let hoverKey = '';

  const linkModifier = (event: MouseEvent) =>
    host.platform === 'mac' ? event.metaKey : event.ctrlKey;

  /** Pointer position in device pixels of the canvas. */
  const at = (event: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const ratio = host.ratio();
    return { x: (event.clientX - rect.left) * ratio, y: (event.clientY - rect.top) * ratio };
  };
  const cellOf = (point: { x: number; y: number }) => {
    const { width, height } = host.cell();
    const { cols, rows } = host.size();
    return {
      col: Math.max(0, Math.min(cols - 1, Math.floor(point.x / width))),
      row: Math.max(0, Math.min(rows - 1, Math.floor(point.y / height))),
    };
  };

  const stopAutoscroll = () => {
    target.clearInterval(autoscroll);
    autoscroll = 0;
  };
  /** Keeps a drag outside the canvas scrolling, one row per tick, by repeating its motion. */
  const updateAutoscroll = (point: { y: number }) => {
    const outside = point.y < 0 || point.y > canvas.height;
    if (outside && autoscroll === 0) {
      autoscroll = target.setInterval(() => {
        if (held !== undefined && last !== undefined) {
          host.mouse({ action: 'motion', button: held, mods: last.mods, x: last.x, y: last.y });
        }
      }, AUTOSCROLL_MS);
    } else if (!outside) {
      stopAutoscroll();
    }
  };

  const openLink = async (event: MouseEvent) => {
    const { col, row } = cellOf(at(event));
    const hyperlink = await host.linkAt(col, row).catch(() => null);
    const uri = hyperlink?.uri ?? urlAt(host.row(row), col)?.uri;
    if (uri !== undefined) host.open(uri);
  };

  const showLink = async (event: MouseEvent) => {
    const { col, row } = cellOf(at(event));
    const key = `${String(col)}:${String(row)}`;
    if (key === hoverKey) return;
    hoverKey = key;
    const plain = urlAt(host.row(row), col);
    if (plain !== undefined) {
      host.hover({ row, start: plain.start, end: plain.end });
      return;
    }
    const hyperlink = await host.linkAt(col, row).catch(() => null);
    if (hoverKey !== key) return;
    host.hover(hyperlink === null ? null : { row, start: hyperlink.start, end: hyperlink.end });
  };
  const clearLink = () => {
    if (hoverKey !== '') {
      hoverKey = '';
      host.hover(null);
    }
  };

  // Mouse events, not pointer events: `detail` of a press is the platform's click count
  // (double and triple clicks), which pointer events leave at 0. While a button is held the
  // window gets the moves and the release, so a drag may leave the canvas.
  const onDown = (event: MouseEvent) => {
    if (!host.attached()) return;
    host.focus();
    if (event.button === 0 && linkModifier(event)) {
      event.preventDefault();
      void openLink(event);
      return;
    }
    const button = BUTTONS[event.button];
    if (button === undefined || held !== undefined) return;
    event.preventDefault();
    target.addEventListener('mousemove', onMove);
    target.addEventListener('mouseup', onUp);
    held = button;
    const point = at(event);
    last = { ...point, mods: mods(event) };
    host.mouse({
      action: 'press',
      button,
      mods: mods(event),
      ...point,
      clicks: Math.max(1, Math.min(3, event.detail)),
    });
  };
  const onMove = (event: MouseEvent) => {
    if (!host.attached()) return;
    if (held === undefined) {
      if (linkModifier(event)) void showLink(event);
      else clearLink();
      return;
    }
    const point = at(event);
    last = { ...point, mods: mods(event) };
    host.mouse({ action: 'motion', button: held, mods: mods(event), ...point });
    updateAutoscroll(point);
  };
  const onUp = (event: MouseEvent) => {
    stopAutoscroll();
    target.removeEventListener('mousemove', onMove);
    target.removeEventListener('mouseup', onUp);
    if (held === undefined || !host.attached()) return;
    const button = held;
    held = undefined;
    host.mouse({ action: 'release', button, mods: mods(event), ...at(event) });
  };
  const onHover = (event: MouseEvent) => {
    if (held === undefined && host.attached()) onMove(event);
  };
  const onWheel = (event: WheelEvent) => {
    if (!host.attached()) return;
    event.preventDefault();
    const { height } = host.cell();
    const ratio = host.ratio();
    const delta =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * height
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * height * host.size().rows
          : event.deltaY * ratio;
    wheel += delta;
    const steps = Math.trunc(wheel / height);
    if (steps === 0) return;
    wheel -= steps * height;
    const point = at(event);
    const button = steps < 0 ? 4 : 5;
    for (let i = 0; i < Math.min(Math.abs(steps), MAX_WHEEL_STEPS); i += 1) {
      host.mouse({ action: 'press', button, mods: mods(event), ...point });
    }
  };
  const onKeyModifier = (event: KeyboardEvent) => {
    if (event.key === 'Meta' || event.key === 'Control') clearLink();
  };

  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mousemove', onHover);
  canvas.addEventListener('mouseleave', clearLink);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  target.addEventListener('keyup', onKeyModifier);
  return () => {
    stopAutoscroll();
    canvas.removeEventListener('mousedown', onDown);
    canvas.removeEventListener('mousemove', onHover);
    canvas.removeEventListener('mouseleave', clearLink);
    target.removeEventListener('mousemove', onMove);
    target.removeEventListener('mouseup', onUp);
    canvas.removeEventListener('wheel', onWheel);
    target.removeEventListener('keyup', onKeyModifier);
  };
}
