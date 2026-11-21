// The find bar's arithmetic (T34): Core searches the screen and scrollback
// (`terminalSearch`, rows counted from the top of the scrollback, newest match first); the
// view highlights the matches that are visible and jumps to one by scrolling the viewport so
// it shows. Kept free of the DOM so it can be tested on its own.
import type { TerminalMatchInfo } from '../../shared/ipc.js';
import type { Highlight } from './vendor/ghostty-web/renderer.js';

/** The viewport: its first row in scrollback rows, its size. */
export interface Viewport {
  readonly offset: number;
  readonly rows: number;
  readonly cols: number;
}

/**
 * The highlights of `matches` on the visible rows, by viewport row. A match that wraps onto
 * following rows covers the rest of its first row, the rows in between, and its last row up
 * to its end column. `current` (an index into `matches`) is drawn as the current match.
 */
export function highlightsIn(
  matches: readonly TerminalMatchInfo[],
  current: number | undefined,
  viewport: Viewport,
): Map<number, Highlight[]> {
  const rows = new Map<number, Highlight[]>();
  const last = viewport.offset + viewport.rows - 1;
  matches.forEach((match, index) => {
    if (match.end.row < viewport.offset || match.start.row > last) return;
    for (
      let row = Math.max(match.start.row, viewport.offset);
      row <= Math.min(match.end.row, last);
      row += 1
    ) {
      const start = row === match.start.row ? match.start.col : 0;
      const end = row === match.end.row ? match.end.col : viewport.cols - 1;
      const y = row - viewport.offset;
      const list = rows.get(y) ?? [];
      list.push({ start, end, current: index === current });
      rows.set(y, list);
    }
  });
  return rows;
}

/**
 * The viewport row (from the top of the scrollback) that shows `match` near the middle, or
 * `undefined` when it is already fully visible.
 */
export function scrollFor(match: TerminalMatchInfo, viewport: Viewport): number | undefined {
  const last = viewport.offset + viewport.rows - 1;
  if (match.start.row >= viewport.offset && match.end.row <= last) return undefined;
  return Math.max(0, match.start.row - Math.floor(viewport.rows / 2));
}

/**
 * The next match index going `direction` (+1 older, -1 newer, as Core lists newest first),
 * wrapping around; the newest when there is no current one.
 */
export function step(
  count: number,
  current: number | undefined,
  direction: 1 | -1,
): number | undefined {
  if (count === 0) return undefined;
  if (current === undefined) return 0;
  return (current + direction + count) % count;
}
