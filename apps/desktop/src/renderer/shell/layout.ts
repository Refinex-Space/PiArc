// Presentation state of the window layout (architecture section 8.3, rule 2): sidebar width and
// collapse, the right rail's width and the dock's height. Kept per window in local storage (a
// convenience: an empty or blocked storage gives the defaults), never sent to Core.

/** Sidebar width bounds (architecture section 8.2). */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 420;

export interface Layout {
  readonly sidebarWidth: number;
  readonly sidebarCollapsed: boolean;
  readonly railWidth: number;
  readonly dockHeight: number;
}

export const DEFAULT_LAYOUT: Layout = {
  sidebarWidth: 264,
  sidebarCollapsed: false,
  railWidth: 300,
  dockHeight: 240,
};

const KEY = 'piarc.layout.v1';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clampSidebar(width: number): number {
  return clamp(width, SIDEBAR_MIN, SIDEBAR_MAX);
}

/** The layout saved by this window's last session, else the defaults. */
export function loadLayout(storage: Pick<Storage, 'getItem'> | undefined): Layout {
  try {
    const text = storage?.getItem(KEY);
    if (text === null || text === undefined) {
      return DEFAULT_LAYOUT;
    }
    const saved: unknown = JSON.parse(text);
    if (typeof saved !== 'object' || saved === null) {
      return DEFAULT_LAYOUT;
    }
    const value = saved as Partial<Record<keyof Layout, unknown>>;
    const number = (v: unknown, fallback: number) =>
      typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    return {
      sidebarWidth: clampSidebar(number(value.sidebarWidth, DEFAULT_LAYOUT.sidebarWidth)),
      sidebarCollapsed: value.sidebarCollapsed === true,
      railWidth: clamp(number(value.railWidth, DEFAULT_LAYOUT.railWidth), 240, 560),
      dockHeight: clamp(number(value.dockHeight, DEFAULT_LAYOUT.dockHeight), 120, 800),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function saveLayout(storage: Pick<Storage, 'setItem'> | undefined, layout: Layout): void {
  try {
    storage?.setItem(KEY, JSON.stringify(layout));
  } catch {
    // Storage may be blocked or full: the layout is a convenience.
  }
}

/** `window.localStorage`, or `undefined` where reading it throws. */
export function localStore(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
