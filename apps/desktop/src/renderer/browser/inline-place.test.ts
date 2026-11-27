import { describe, expect, it } from 'vitest';

import { placeBeside, scaleRect } from './inline-place.js';

const stage = { width: 600, height: 400 };
const card = { width: 280, height: 160 };

describe('placing the in-place card beside a selection', () => {
  it('goes below the selection when there is room', () => {
    expect(placeBeside({ x: 40, y: 30, width: 100, height: 40 }, card, stage)).toEqual({
      x: 40,
      y: 78,
      side: 'below',
    });
  });

  it('goes above when the space below is too short', () => {
    expect(placeBeside({ x: 40, y: 300, width: 100, height: 60 }, card, stage)).toEqual({
      x: 40,
      y: 132,
      side: 'above',
    });
  });

  it('goes to the right of a tall selection, then to its left', () => {
    expect(placeBeside({ x: 20, y: 20, width: 200, height: 360 }, card, stage)).toEqual({
      x: 228,
      y: 20,
      side: 'right',
    });
    expect(placeBeside({ x: 300, y: 20, width: 280, height: 360 }, card, stage)).toEqual({
      x: 12,
      y: 20,
      side: 'left',
    });
  });

  it('stays inside the stage, over the selection, when nothing else fits', () => {
    expect(placeBeside({ x: 0, y: 0, width: 600, height: 400 }, card, stage)).toEqual({
      x: 308,
      y: 228,
      side: 'inside',
    });
  });

  it('keeps the card within the stage edges', () => {
    const placed = placeBeside({ x: 520, y: 30, width: 70, height: 20 }, card, stage);
    expect(placed.side).toBe('below');
    expect(placed.x).toBe(stage.width - card.width - 12);
  });

  it('pins the card to the top left of a stage smaller than it', () => {
    expect(
      placeBeside({ x: 10, y: 10, width: 20, height: 20 }, card, { width: 200, height: 100 }),
    ).toEqual({ x: 12, y: 12, side: 'inside' });
  });
});

describe('scaling a selection into the shown image', () => {
  it('maps image pixels to the shown size', () => {
    expect(scaleRect({ x: 100, y: 50, width: 200, height: 80 }, 0.5)).toEqual({
      x: 50,
      y: 25,
      width: 100,
      height: 40,
    });
  });
});
