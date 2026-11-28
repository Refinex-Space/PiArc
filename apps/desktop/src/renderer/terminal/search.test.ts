import { describe, expect, it } from 'vitest';

import { highlightsIn, scrollFor, step } from './search.js';

const match = (row: number, start: number, endRow: number, end: number) => ({
  start: { row, col: start },
  end: { row: endRow, col: end },
});

describe('find bar arithmetic', () => {
  it('highlights the visible matches by viewport row, splitting wrapped ones', () => {
    const viewport = { offset: 100, rows: 3, cols: 10 };
    const rows = highlightsIn(
      [match(101, 2, 101, 4), match(99, 8, 100, 1), match(102, 7, 103, 3), match(50, 0, 50, 2)],
      0,
      viewport,
    );
    expect(Object.fromEntries(rows)).toEqual({
      0: [{ start: 0, end: 1, current: false }],
      1: [{ start: 2, end: 4, current: true }],
      2: [{ start: 7, end: 9, current: false }],
    });
  });

  it('scrolls only when the match is not fully visible', () => {
    const viewport = { offset: 100, rows: 10, cols: 80 };
    expect(scrollFor(match(105, 0, 105, 3), viewport)).toBeUndefined();
    expect(scrollFor(match(40, 0, 40, 3), viewport)).toBe(35);
    expect(scrollFor(match(2, 0, 2, 3), viewport)).toBe(0);
    expect(scrollFor(match(109, 70, 110, 3), viewport)).toBe(104);
  });

  it('steps through matches in both directions, wrapping around', () => {
    expect(step(0, undefined, 1)).toBeUndefined();
    expect(step(3, undefined, 1)).toBe(0);
    expect(step(3, 0, 1)).toBe(1);
    expect(step(3, 2, 1)).toBe(0);
    expect(step(3, 0, -1)).toBe(2);
  });
});
