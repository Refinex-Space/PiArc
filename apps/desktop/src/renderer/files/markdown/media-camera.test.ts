import { expect, it } from 'vitest';
import { constrain, diagramSize, place, stepZoom, zoomAround } from './media-camera.js';
it('preserves a viewport point during pointer zoom and stops a pan before the entire image disappears', () => {
  const view = { width: 900, height: 600 },
    natural = { width: 1800, height: 1200 },
    point = { x: 310, y: 240 };
  const base = place(natural, view, 0, 'window', 1),
    next = zoomAround(base, 1, point, point, natural, view);
  expect((point.x - next.x) / next.zoom).toBeCloseTo((point.x - base.x) / base.zoom);
  expect((point.y - next.y) / next.zoom).toBeCloseTo((point.y - base.y) / base.zoom);
  expect(constrain({ ...next, x: -5000, y: 5000 }, natural, view)).toMatchObject({
    x: -924,
    y: 24,
  });
  expect(stepZoom(0.9, 1)).toBe(1);
  expect(stepZoom(1.1, -1)).toBe(1);
  expect(stepZoom(64, 1)).toBe(64);
});
it('fits the rotated bounds, limits raster upscaling and fits an arbitrarily long valid diagram', () => {
  const viewport = { width: 840, height: 600 },
    size = { width: 120, height: 360 };
  expect(place(size, viewport, 0, 'window', 1).zoom).toBe(1);
  expect(place(size, viewport, 1, 'width', 2).zoom).toBeCloseTo(792 / 360);
  expect(place({ width: 150000, height: 500 }, viewport, 0, 'window', 2).zoom).toBeLessThan(1 / 32);
  expect(diagramSize('<svg width="100%" viewBox="-8 -2 3120.5 986"><g/></svg>')).toEqual({
    width: 3120.5,
    height: 986,
  });
  expect(diagramSize('<svg viewBox="0 0 NaN 30"/>')).toBeUndefined();
  expect(diagramSize('<svg><svg viewBox="0 0 5 6"/></svg>')).toBeUndefined();
});
