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

/** Cell size and pitch in the 20-unit view box. */
const CELL = 4;
const PITCH = 5;

export type Activity = 'think' | 'tool' | 'blocked';

export function ActivityMark({
  activity,
  size = 16,
}: {
  readonly activity: Activity;
  /** CSS px: 16 on the working line, 14 beside a session title. */
  readonly size?: 14 | 16;
}) {
  return (
    <svg
      className="activity-mark"
      data-activity={activity}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      {CELLS.map(([column, row], index) => (
        <rect
          key={index}
          className="activity-mark-cell"
          x={0.5 + column * PITCH}
          y={0.5 + row * PITCH}
          width={CELL}
          height={CELL}
          rx="1"
          style={{ '--cell': index } as CSSProperties}
        />
      ))}
    </svg>
  );
}
