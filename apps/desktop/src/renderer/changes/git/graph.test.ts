import { describe, expect, it } from 'vitest';

import { graphRows, type GraphRow } from './graph.js';

const c = (sha: string, ...parents: string[]) => ({ sha, parents });

/** Lines as `kind from→to`, sorted, for compact assertions. */
function lines(row: GraphRow | undefined): string[] {
  return (row?.lines ?? []).map((l) => `${l.kind} ${String(l.from)}→${String(l.to)}`).sort();
}

describe('commit graph', () => {
  it('keeps a linear history in one lane', () => {
    const rows = graphRows([c('c', 'b'), c('b', 'a'), c('a')]);
    expect(rows.map((r) => r.column)).toEqual([0, 0, 0]);
    expect(lines(rows[0])).toEqual(['out 0→0']);
    expect(lines(rows[1])).toEqual(['in 0→0', 'out 0→0']);
    // The root commit ends its lane.
    expect(lines(rows[2])).toEqual(['in 0→0']);
    expect(new Set(rows.map((r) => r.color)).size).toBe(1);
  });

  it('opens a lane for a merged branch and closes it at the fork point', () => {
    // m merges b2 (feature) into a2 (main); both started from base.
    const rows = graphRows([
      c('m', 'a2', 'b2'),
      c('b2', 'b1'),
      c('a2', 'base'),
      c('b1', 'base'),
      c('base'),
    ]);
    expect(rows[0]?.merge).toBe(true);
    expect(lines(rows[0])).toEqual(['out 0→0', 'out 0→1']);
    expect(rows[1]?.column).toBe(1);
    expect(lines(rows[1])).toEqual(['in 1→1', 'out 1→1', 'through 0→0']);
    expect(rows[2]?.column).toBe(0);
    expect(rows[3]?.column).toBe(1);
    // Both lanes wait for `base`: they meet in its dot.
    expect(rows[4]?.column).toBe(0);
    expect(lines(rows[4])).toEqual(['in 0→0', 'in 1→0']);
    expect(rows[4]?.width).toBe(2);
    expect(rows[1]?.color).not.toBe(rows[0]?.color);
  });

  it('joins a merge parent to the lane already waiting for it', () => {
    // Two branch tips, then a merge of the second into a commit the first also reaches.
    const rows = graphRows([c('x', 'p'), c('y', 'q', 'p'), c('q', 'p'), c('p')]);
    expect(rows[1]?.column).toBe(1);
    expect(lines(rows[1])).toEqual(['out 1→0', 'out 1→1', 'through 0→0']);
    expect(rows[3]?.column).toBe(0);
  });

  it('draws an octopus merge with one lane per parent', () => {
    const rows = graphRows([c('o', 'a', 'b', 'd'), c('a'), c('b'), c('d')]);
    expect(lines(rows[0])).toEqual(['out 0→0', 'out 0→1', 'out 0→2']);
    expect(rows.slice(1).map((r) => r.column)).toEqual([0, 1, 2]);
  });

  it('reuses freed lanes from the left and keeps unloaded parents open', () => {
    const rows = graphRows([c('t1', 'x'), c('t2', 'y'), c('x', 'z'), c('t3', 'w')]);
    // `x` ends lane 0's wait and continues with `z`; t3 opens a lane in the first free slot.
    expect(rows[1]?.column).toBe(1);
    expect(rows[3]?.column).toBe(2);
    expect(lines(rows[3])).toEqual(['out 2→2', 'through 0→0', 'through 1→1']);
  });
});
