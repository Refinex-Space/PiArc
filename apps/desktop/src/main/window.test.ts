import { expect, it, vi } from 'vitest';

import { createMainWindow } from './window.js';

const { constructed } = vi.hoisted(() => ({ constructed: vi.fn() }));
vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(options: unknown) {
      constructed(options);
    }
    once = vi.fn();
    webContents = { on: vi.fn() };
  },
}));

it('uses the desktop reference size and only reduces the minimum when placement fitted a smaller work area', () => {
  createMainWindow('preload.cjs');
  expect(constructed).toHaveBeenLastCalledWith(
    expect.objectContaining({
      width: 1200,
      height: 800,
      minWidth: 960,
      minHeight: 600,
    }),
  );
  createMainWindow('preload.cjs', { width: 1150, height: 540 });
  expect(constructed).toHaveBeenLastCalledWith(
    expect.objectContaining({
      width: 1150,
      height: 540,
      minWidth: 960,
      minHeight: 540,
    }),
  );
  createMainWindow('preload.cjs', { width: 760, height: 530 });
  expect(constructed).toHaveBeenLastCalledWith(
    expect.objectContaining({
      width: 760,
      height: 530,
      minWidth: 760,
      minHeight: 530,
    }),
  );
});
