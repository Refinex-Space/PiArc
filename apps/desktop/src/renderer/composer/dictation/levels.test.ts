import { describe, expect, it } from 'vitest';

import { BAR_MS, Levels, MAX_BARS } from './levels.js';

describe('Levels', () => {
  it('folds windows into one bar per BAR_MS with the loudest bucket', () => {
    const levels = new Levels();
    levels.push(40, 0.2, [0.1, 0.3], 0);
    levels.push(80, 0.1, [0.05], 40);
    levels.push(120, 0.4, [], 80);
    expect(levels.last(2)).toEqual([0.3, 0.4]);
    expect(levels.last(4)).toEqual([0, 0, 0.3, 0.4]);
  });

  it('ignores reports older than the last and keeps at most MAX_BARS', () => {
    const levels = new Levels();
    levels.push(80, 0.5, [], 0);
    const version = levels.version;
    levels.push(40, 0.9, [], 1);
    expect(levels.version).toBe(version);
    for (let i = 1; i <= MAX_BARS + 10; i += 1) levels.push(80 + i * BAR_MS, 0.1, [], i);
    expect(levels.last(MAX_BARS + 5).slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
  });

  it('glides between reports on the wall clock, at most one window ahead', () => {
    const levels = new Levels();
    expect(levels.drift(0)).toBe(0);
    levels.push(120, 0.1, [], 1000);
    // The second bar holds 40 ms of its 80: half a bar still to come.
    expect(levels.drift(1000)).toBeCloseTo(-0.5);
    expect(levels.drift(1020)).toBeCloseTo(-0.25);
    expect(levels.drift(1040)).toBeCloseTo(0);
    // No report after that: the picture stops instead of running ahead.
    expect(levels.drift(5000)).toBeCloseTo(0);
    // The next report continues from where the glide was, without a jump.
    levels.push(160, 0.1, [], 1040);
    expect(levels.drift(1040)).toBeCloseTo(0);
    levels.push(200, 0.1, [], 1080);
    expect(levels.drift(1080)).toBeCloseTo(-0.5);
  });

  it('starts over when cleared', () => {
    const levels = new Levels();
    levels.push(400, 0.5, [], 0);
    levels.clear();
    expect(levels.last(2)).toEqual([0, 0]);
    levels.push(40, 0.2, [], 0);
    expect(levels.last(1)).toEqual([0.2]);
  });
});
