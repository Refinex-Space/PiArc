import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ WebContentsView: Object }));

const { fitDevice, splitForDevtools, toDips } = await import('./view-host.js');

describe('toDips', () => {
  it('scales by the page zoom and rounds', () => {
    expect(toDips({ x: 10.4, y: 20.6, width: 300.2, height: 200.5 }, 1.25)).toEqual({
      x: 13,
      y: 26,
      width: 375,
      height: 251,
    });
    expect(toDips({ x: 0, y: 0, width: -5, height: 10 }, 1).width).toBe(0);
  });
});

describe('fitDevice', () => {
  const area = { x: 100, y: 50, width: 400, height: 600 };

  it('scales a large device down and centers it', () => {
    const { rect, scale } = fitDevice(area, { width: 800, height: 600 });
    expect(scale).toBe(0.5);
    expect(rect).toEqual({ x: 100, y: 200, width: 400, height: 300 });
  });

  it('never scales a small device up', () => {
    const { rect, scale } = fitDevice(area, { width: 200, height: 300 });
    expect(scale).toBe(1);
    expect(rect).toEqual({ x: 200, y: 200, width: 200, height: 300 });
  });
});

describe('splitForDevtools', () => {
  it('docks DevTools under the page', () => {
    const { page, devtools } = splitForDevtools({ x: 0, y: 40, width: 500, height: 1000 });
    expect(page).toEqual({ x: 0, y: 40, width: 500, height: 600 });
    expect(devtools).toEqual({ x: 0, y: 640, width: 500, height: 400 });
  });
});
