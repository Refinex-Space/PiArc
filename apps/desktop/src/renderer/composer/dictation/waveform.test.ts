import { describe, expect, it } from 'vitest';

import { loudness } from './Waveform.js';

describe('loudness', () => {
  it('draws speech at microphone levels well above the floor (decibel scale)', () => {
    expect(loudness(0)).toBe(0);
    expect(loudness(Number.NaN)).toBe(0);
    expect(loudness(1)).toBe(1);
    expect(loudness(2)).toBe(1);
    // Quiet speech (-40 dBFS) still shows; ordinary speech (-20 dBFS) fills most of the height.
    expect(loudness(0.01)).toBeGreaterThan(0.25);
    expect(loudness(0.1)).toBeGreaterThan(0.6);
    // Background noise near -60 dBFS stays on the floor.
    expect(loudness(0.001)).toBe(0);
  });

  it('rises with the level', () => {
    const levels = [0.002, 0.005, 0.02, 0.05, 0.2, 0.5];
    const drawn = levels.map(loudness);
    expect([...drawn].sort((a, b) => a - b)).toEqual(drawn);
  });
});
