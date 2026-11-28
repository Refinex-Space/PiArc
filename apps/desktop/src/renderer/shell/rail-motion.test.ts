import { describe, expect, it } from 'vitest';

import { dropIndex, edgeScroll, landingTop, shiftOf, type Slot } from './rail-motion.js';

// A short card, a tall one and a short one, 8 px apart.
const slots: Slot[] = [
  { id: 'a', top: 0, height: 40 },
  { id: 'b', top: 48, height: 200 },
  { id: 'c', top: 256, height: 40 },
];

describe('dropIndex', () => {
  it('passes a card below once the held card’s bottom edge sinks past its middle', () => {
    // a (40 tall) held: its bottom is at top + 40; b's middle is 148, c's is 276.
    expect(dropIndex(slots, 0, 0)).toBe(0);
    expect(dropIndex(slots, 0, 107)).toBe(0);
    expect(dropIndex(slots, 0, 109)).toBe(1);
    expect(dropIndex(slots, 0, 237)).toBe(2);
  });
  it('passes a card above once the held card’s top edge rises past its middle', () => {
    expect(dropIndex(slots, 2, 256)).toBe(2);
    expect(dropIndex(slots, 2, 149)).toBe(2);
    expect(dropIndex(slots, 2, 147)).toBe(1);
    expect(dropIndex(slots, 2, 19)).toBe(0);
  });
  it('moves a tall card by its edges, not its far-away centre', () => {
    // b (200 tall) held: it passes a once its top rises above a's middle (20).
    expect(dropIndex(slots, 1, 30)).toBe(1);
    expect(dropIndex(slots, 1, 19)).toBe(0);
    // Sinking: its bottom (top + 200) passes c's middle (276) at top 77.
    expect(dropIndex(slots, 1, 75)).toBe(1);
    expect(dropIndex(slots, 1, 77)).toBe(2);
  });
});

describe('shiftOf', () => {
  it('opens the slot by moving the cards in between towards the held card’s old place', () => {
    expect([0, 1, 2].map((i) => shiftOf(i, 0, 2, 48))).toEqual([0, -48, -48]);
    expect([0, 1, 2].map((i) => shiftOf(i, 2, 0, 48))).toEqual([48, 48, 0]);
    expect([0, 1, 2].map((i) => shiftOf(i, 1, 1, 208))).toEqual([0, 0, 0]);
  });
});

describe('landingTop', () => {
  it('puts the held card where the opened slot is', () => {
    expect(landingTop(slots, 0, 0)).toBe(0);
    // Down: its bottom meets the bottom of the last card it passed.
    expect(landingTop(slots, 0, 2)).toBe(256);
    expect(landingTop(slots, 0, 1)).toBe(208);
    // Up: it takes the top of the card it passed.
    expect(landingTop(slots, 2, 0)).toBe(0);
    expect(landingTop(slots, 2, 1)).toBe(48);
  });
});

describe('edgeScroll', () => {
  it('scrolls faster the closer the pointer is to an edge, and not in between', () => {
    expect(edgeScroll(300, 0, 600)).toBe(0);
    expect(edgeScroll(40, 0, 600)).toBeLessThan(0);
    expect(edgeScroll(0, 0, 600)).toBe(-14);
    expect(edgeScroll(-30, 0, 600)).toBe(-14);
    expect(edgeScroll(560, 0, 600)).toBeGreaterThan(0);
    expect(edgeScroll(600, 0, 600)).toBe(14);
  });
});
