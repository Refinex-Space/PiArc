// Where the in-place card of a selection goes on the frozen page (design addendum B3.1, B3.4):
// beside the picked element or the drawn region, never over the panel's edges. All values are
// CSS pixels of the stage that shows the page's still frame.

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Placement {
  readonly x: number;
  readonly y: number;
  /** Where the card ended up relative to the selection. */
  readonly side: 'below' | 'above' | 'right' | 'left' | 'inside';
}

/** Space kept between the card and the stage's edges. */
const EDGE = 12;
/** Space between the selection and the card. */
const GAP = 8;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}

/**
 * The card's top left corner: below the selection, else above it, else to its right, else to its
 * left, else inside it at its bottom right corner; always within the stage when it fits there.
 */
export function placeBeside(anchor: Rect, card: Size, stage: Size): Placement {
  const maxX = stage.width - card.width - EDGE;
  const maxY = stage.height - card.height - EDGE;
  const alongX = clamp(anchor.x, EDGE, maxX);
  const alongY = clamp(anchor.y, EDGE, maxY);
  const below = anchor.y + anchor.height + GAP;
  if (below <= maxY) return { x: alongX, y: below, side: 'below' };
  const above = anchor.y - GAP - card.height;
  if (above >= EDGE) return { x: alongX, y: above, side: 'above' };
  const right = anchor.x + anchor.width + GAP;
  if (right <= maxX) return { x: right, y: alongY, side: 'right' };
  const left = anchor.x - GAP - card.width;
  if (left >= EDGE) return { x: left, y: alongY, side: 'left' };
  return {
    x: Math.max(EDGE, Math.min(anchor.x + anchor.width - card.width - EDGE, maxX)),
    y: Math.max(EDGE, Math.min(anchor.y + anchor.height - card.height - EDGE, maxY)),
    side: 'inside',
  };
}

/** `rect` multiplied by `scale` (image pixels to shown pixels). */
export function scaleRect(rect: Rect, scale: number): Rect {
  return {
    x: rect.x * scale,
    y: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}
