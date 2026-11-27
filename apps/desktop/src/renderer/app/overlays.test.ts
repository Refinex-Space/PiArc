import { describe, expect, it, vi } from 'vitest';

import { intersects, onOverlaysChange, registerOverlay, registeredOverlays } from './overlays.js';

describe('overlay registry (B1.5.2)', () => {
  it('lists registered overlays and tells listeners when they come and go', () => {
    const element = {} as Element;
    const listener = vi.fn();
    const stop = onOverlaysChange(listener);
    const unregister = registerOverlay(element);
    expect(registeredOverlays()).toContain(element);
    unregister();
    unregister();
    expect(registeredOverlays()).not.toContain(element);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  it('counts shared area only', () => {
    const view = { left: 0, top: 100, right: 400, bottom: 500 };
    expect(intersects(view, { left: 390, top: 90, right: 420, bottom: 110 })).toBe(true);
    expect(intersects(view, { left: 400, top: 120, right: 420, bottom: 140 })).toBe(false);
    expect(intersects(view, { left: 10, top: 60, right: 50, bottom: 100 })).toBe(false);
  });
});
