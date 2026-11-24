// The main windows' position and size (architecture section 7.3): saved in the user data
// directory's `window-state.json` when a main window moves, resizes or closes, and used for
// the next main window, also after a restart. The placement functions are pure.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** A window's normal (not maximized) rectangle and whether it was maximized. */
export interface WindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly maximized: boolean;
}

/** A display's work area. */
export interface Area {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** First workbench size in device-independent pixels, before fitting the display. */
export const MAIN_WINDOW_DEFAULT = { width: 1200, height: 800 } as const;

/** The file name in the user data directory. */
export const WINDOW_STATE_FILE = 'window-state.json';

/** How far each further window is moved from the last one. */
export const CASCADE = 24;

/** Pixels of a window that must lie on some display for it to be reachable. */
const VISIBLE = 64;

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) < 1_000_000;
}

/** The saved bounds in `text`, or `undefined` when they are missing or malformed. */
export function parseWindowState(text: string): WindowBounds | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || !('main' in value)) return undefined;
  const main: unknown = value.main;
  if (typeof main !== 'object' || main === null) return undefined;
  const b = main as Record<string, unknown>;
  if (!integer(b.x) || !integer(b.y) || !integer(b.width) || !integer(b.height)) return undefined;
  if (b.width <= 0 || b.height <= 0) return undefined;
  return {
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    maximized: b.maximized === true,
  };
}

function overlap(a: Area, b: Area): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/**
 * Where a window goes: `saved` moved by `offset` (cascading windows), its size at least
 * `min` and at most the display's; a window that would not show `VISIBLE` pixels on any
 * display is centered on the first one. A fresh workbench starts centered on that display,
 * with a further window cascaded only as far as it still fits.
 */
export function placeWindow(
  saved: WindowBounds | undefined,
  areas: readonly Area[],
  min: { readonly width: number; readonly height: number },
  offset = 0,
): WindowBounds | undefined {
  const primary = areas[0];
  if (primary === undefined) return undefined;
  const moved = saved && { ...saved, x: saved.x + offset, y: saved.y + offset };
  const target =
    (moved &&
      areas.find((area) => {
        const o = overlap(area, moved);
        return o.width >= VISIBLE && o.height >= VISIBLE;
      })) ??
    primary;
  const size = moved ?? MAIN_WINDOW_DEFAULT;
  const width = Math.min(Math.max(size.width, min.width), target.width);
  const height = Math.min(Math.max(size.height, min.height), target.height);
  if (moved) {
    const visible = overlap(target, { ...moved, width, height });
    if (visible.width >= VISIBLE && visible.height >= VISIBLE) return { ...moved, width, height };
  }
  const centered = (room: number) =>
    Math.min(room, Math.max(0, Math.round(room / 2) + (saved ? 0 : offset)));
  return {
    x: target.x + centered(target.width - width),
    y: target.y + centered(target.height - height),
    width,
    height,
    maximized: saved?.maximized ?? false,
  };
}

/** Reads and writes `window-state.json`; a write replaces the file atomically. */
export class WindowStateFile {
  constructor(private readonly file: string) {}

  static in(userData: string): WindowStateFile {
    return new WindowStateFile(path.join(userData, WINDOW_STATE_FILE));
  }

  load(): WindowBounds | undefined {
    try {
      return parseWindowState(readFileSync(this.file, 'utf8'));
    } catch {
      return undefined;
    }
  }

  save(bounds: WindowBounds): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${String(process.pid)}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ main: bounds }, null, 2)}\n`);
      renameSync(temporary, this.file);
    } catch (error) {
      console.warn('[window] cannot save the window state', error);
    }
  }
}
