// The log view's commit graph (design addendum H1.3): lanes assigned from parents in the
// topological order Core returns, newest first. A lane waits for the commit it points at; a
// commit takes the leftmost lane waiting for it (or a free one), its first parent continues that
// lane, and further parents join the lane already waiting for them or open a new one. Freed
// lanes are reused from the left so lines stay straight. Parents not loaded yet keep their lane
// open to the bottom of the last row.

/** A line in one row: through the whole row, from the top into the dot, or from the dot down. */
export interface GraphLine {
  readonly kind: 'through' | 'in' | 'out';
  /** The column at the top (`through`, `in`) or at the dot (`out`). */
  readonly from: number;
  /** The column at the bottom (`through`, `out`) or at the dot (`in`). */
  readonly to: number;
  /** The lane's color index (0–7). */
  readonly color: number;
}

export interface GraphRow {
  /** The dot's column. */
  readonly column: number;
  readonly color: number;
  /** Columns the row needs. */
  readonly width: number;
  readonly lines: readonly GraphLine[];
  /** A merge commit (more than one parent). */
  readonly merge: boolean;
}

/** Lane colors cycle through this many tokens. */
export const LANE_COLORS = 8;

interface Lane {
  readonly sha: string;
  readonly color: number;
}

/** The graph rows of `commits` (each with its id and parents), in the same order. */
export function graphRows(
  commits: readonly { readonly sha: string; readonly parents: readonly string[] }[],
): GraphRow[] {
  const lanes: (Lane | undefined)[] = [];
  let nextColor = 0;
  const open = (sha: string, color?: number): number => {
    const lane = { sha, color: color ?? nextColor++ % LANE_COLORS };
    const free = lanes.findIndex((l) => l === undefined);
    if (free >= 0) {
      lanes[free] = lane;
      return free;
    }
    lanes.push(lane);
    return lanes.length - 1;
  };
  const rows: GraphRow[] = [];
  for (const commit of commits) {
    const before = [...lanes];
    const waiting = before.flatMap((l, i) => (l?.sha === commit.sha ? [i] : []));
    const column = waiting[0] ?? open(commit.sha);
    const color = lanes[column]?.color ?? 0;
    const lines: GraphLine[] = [];
    before.forEach((lane, i) => {
      if (lane === undefined) return;
      lines.push(
        lane.sha === commit.sha
          ? { kind: 'in', from: i, to: column, color: lane.color }
          : { kind: 'through', from: i, to: i, color: lane.color },
      );
    });
    // The lanes that ended here close; the commit's own lane continues with its first parent.
    for (const i of waiting) lanes[i] = undefined;
    const [first, ...others] = commit.parents;
    if (first !== undefined) {
      lanes[column] = { sha: first, color };
      lines.push({ kind: 'out', from: column, to: column, color });
    } else {
      lanes[column] = undefined;
    }
    for (const parent of others) {
      const existing = lanes.findIndex((l) => l?.sha === parent);
      const to = existing >= 0 ? existing : open(parent);
      lines.push({ kind: 'out', from: column, to, color: lanes[to]?.color ?? color });
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === undefined) lanes.pop();
    const width = Math.max(
      column + 1,
      ...lines.map((l) => Math.max(l.from, l.to) + 1),
      lanes.length,
    );
    rows.push({ column, color, width, lines, merge: commit.parents.length > 1 });
  }
  return rows;
}
