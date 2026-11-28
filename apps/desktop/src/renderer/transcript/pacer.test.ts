import { describe, expect, it } from 'vitest';

import { STREAMING } from './constants.js';
import { revealLength } from './pacer.js';

const FRAME = 1000 / 60;

/** Simulates frames while text arrives at `charsPerSecond`; returns the largest lag seen. */
function simulate(charsPerSecond: number, seconds: number): { maxLag: number; endLag: number } {
  const full = 'x'.repeat(Math.ceil(charsPerSecond * seconds));
  let visible = 0;
  let maxLag = 0;
  let received = 0;
  for (let time = 0; time < seconds * 1000; time += FRAME) {
    received = Math.min(full.length, Math.floor(((time + FRAME) / 1000) * charsPerSecond));
    visible = revealLength(full.slice(0, received), visible, FRAME);
    maxLag = Math.max(maxLag, received - visible);
  }
  return { maxLag, endLag: received - visible };
}

describe('revealLength', () => {
  it('trails a 100 token/s stream (about 400 chars/s) by a few frames only', () => {
    const { maxLag } = simulate(400, 5);
    // About revealTauMs of text, plus one frame of rounding.
    expect(maxLag).toBeLessThanOrEqual(Math.ceil((400 * (STREAMING.revealTauMs + FRAME)) / 1000));
  });

  it('never trails by more than maxBacklogChars, even for a burst', () => {
    const text = 'y'.repeat(10_000);
    const next = revealLength(text, 0, FRAME);
    expect(text.length - next).toBeLessThan(STREAMING.maxBacklogChars);
  });

  it('keeps moving at the minimum speed for a small backlog', () => {
    const next = revealLength('abc', 0, FRAME);
    expect(next).toBeGreaterThanOrEqual(1);
    expect(revealLength('abc', 3, FRAME)).toBe(3);
  });

  it('does not split a surrogate pair', () => {
    const text = 'a🚀b';
    expect(revealLength(text, 0, 0.001)).toBe(1);
    expect(revealLength(text, 1, 0.001)).toBe(3);
  });
});
