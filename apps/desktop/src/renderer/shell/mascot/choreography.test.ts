import { describe, expect, it } from 'vitest';

import {
  arrival,
  framesOf,
  nextFrames,
  pick,
  TRAVEL,
  type Behaviour,
  type Frame,
} from './choreography.js';
import { POSE_COLS, POSES, STAGE_ROWS, posePath } from './poses.js';

/** A seeded generator (mulberry32), so a failure repeats. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BEHAVIOURS: Behaviour[] = [
  'idle',
  'glance',
  'walk',
  'hops',
  'jump',
  'ibounce',
  'wave',
  'dance',
  'nap',
];

function checkFrames(frames: readonly Frame[]) {
  for (const f of frames) {
    expect(f.pose in POSES, f.pose).toBe(true);
    expect(f.ms).toBeGreaterThan(0);
    expect(Math.abs(f.x)).toBeLessThanOrEqual(TRAVEL);
    expect(Number.isInteger(f.x)).toBe(true);
    expect(f.lift).toBeGreaterThanOrEqual(0);
    expect(POSES[f.pose].length + f.lift).toBeLessThanOrEqual(STAGE_ROWS);
  }
}

describe('the mascot poses', () => {
  it('share one width and fit the stage', () => {
    for (const [name, rows] of Object.entries(POSES)) {
      expect(rows.length, name).toBeLessThanOrEqual(STAGE_ROWS);
      for (const row of rows) {
        expect(row, name).toMatch(/^[#.]+$/u);
        expect(row.length, name).toBe(POSE_COLS);
      }
    }
  });

  it('become paths that stand on the floor', () => {
    expect(posePath('idle', 0)).toMatch(/^M1 3h6v1h-6z/u);
    expect(posePath('idle', 6)).toContain(`M6 ${String(STAGE_ROWS - 1)}h3v1h-3z`);
  });
});

describe('the mascot choreography', () => {
  it('arrives from above and ends standing in the middle', () => {
    const frames = arrival();
    checkFrames(frames);
    expect(frames[0]?.lift).toBeGreaterThan(0);
    expect(frames.at(-1)).toMatchObject({ pose: 'idle', x: 0, lift: 0 });
  });

  it('keeps every behaviour on the stage from any spot, ending on the floor', () => {
    for (const behaviour of BEHAVIOURS) {
      for (let x = -TRAVEL; x <= TRAVEL; x += 1) {
        const frames = framesOf(behaviour, x, seeded(x + 40));
        checkFrames(frames);
        expect(frames.at(-1)?.lift, behaviour).toBe(0);
      }
    }
  });

  it('walks and hops sideways one block at a time', () => {
    for (const behaviour of ['walk', 'hops'] as const) {
      for (let seed = 1; seed < 30; seed += 1) {
        const frames = framesOf(behaviour, 0, seeded(seed));
        let at = 0;
        for (const f of frames) {
          expect(Math.abs(f.x - at), behaviour).toBeLessThanOrEqual(1);
          at = f.x;
        }
      }
    }
  });

  it('goes both ways from the middle and leans back from the edges', () => {
    const ends = new Set<number>();
    let backFromEdge = 0;
    for (let seed = 1; seed < 200; seed += 1) {
      const walked = framesOf('walk', 0, seeded(seed)).at(-1)?.x ?? 0;
      ends.add(Math.sign(walked));
      if ((framesOf('walk', TRAVEL, seeded(seed)).at(-1)?.x ?? TRAVEL) < TRAVEL) backFromEdge += 1;
    }
    expect(ends).toEqual(new Set([-1, 1]));
    expect(backFromEdge).toBeGreaterThan(150);
  });

  it('starts every run with an idle beat and picks every behaviour over time', () => {
    const random = seeded(7);
    const seen = new Set<Behaviour>();
    for (let i = 0; i < 2000; i += 1) seen.add(pick(random));
    expect(seen).toEqual(new Set(BEHAVIOURS));
    for (let seed = 1; seed < 50; seed += 1) {
      const frames = nextFrames(3, seeded(seed));
      expect(frames[0]).toMatchObject({ pose: 'idle', x: 3, lift: 0 });
      checkFrames(frames);
    }
  });
});
