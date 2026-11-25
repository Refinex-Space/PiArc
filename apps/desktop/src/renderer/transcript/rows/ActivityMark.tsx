// The working mark (ADR-0078): PiArc's own P and i, drawn as ten cells of a 4 × 4 grid that light
// up in the order a pen would draw the letters (the stem, the bowl, then the i). The rhythm says
// what the turn is doing: a slow wave while the model thinks, a quick one while a tool runs, and a
// held mark breathing in the warning ink while the turn waits for the user. CSS animates it
// (session.css); under reduced motion the mark stands still.
import type { CSSProperties } from 'react';

/** The cells in drawing order, as [column, row] of the 4 × 4 grid. */
const CELLS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 0],
  [2, 0],
  [2, 1],
  [1, 2],
  [3, 2],
  [3, 3],
];

/** Cell pitch in a 20-unit square; a cell is four fifths of it. */
const PITCH = 5;
const VIEW = 20;

export type Activity = 'think' | 'tool' | 'blocked';

export function ActivityMark({
  activity,
  size = 16,
}: {
  readonly activity: Activity;
  /** CSS px: 16 on the working line, 14 beside a session title. */
  readonly size?: 14 | 16;
}) {
  // HTML cells, not SVG: the browser runs their opacity animations on the compositor, so the
  // mark costs the main thread nothing while a reply streams.
  return (
    <span
      className="activity-mark"
      data-activity={activity}
      style={{ '--mark-size': `${String(size)}px` } as CSSProperties}
      aria-hidden="true"
    >
      {CELLS.map(([column, row], index) => (
        <span
          key={index}
          className="activity-mark-cell"
          style={
            {
              '--cell': index,
              left: `${String(((column * PITCH) / VIEW) * 100)}%`,
              top: `${String(((row * PITCH) / VIEW) * 100)}%`,
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
}
