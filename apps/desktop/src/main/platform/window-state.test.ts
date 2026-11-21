import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CASCADE, WindowStateFile, parseWindowState, placeWindow } from './window-state.js';

const screen = { x: 0, y: 0, width: 1920, height: 1080 };
const second = { x: 1920, y: 0, width: 1280, height: 800 };
const min = { width: 960, height: 600 };

describe('window state', () => {
  it('round-trips through the file and rejects malformed content', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'piarc window 窗口 '));
    try {
      const file = WindowStateFile.in(dir);
      expect(file.load()).toBeUndefined();
      const bounds = { x: 100, y: 80, width: 1300, height: 820, maximized: true };
      file.save(bounds);
      expect(file.load()).toEqual(bounds);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(parseWindowState('{"main":{"x":1,"y":2,"width":0,"height":3}}')).toBeUndefined();
    expect(parseWindowState('{"main":{"x":1.5,"y":2,"width":10,"height":3}}')).toBeUndefined();
    expect(parseWindowState('not json')).toBeUndefined();
  });

  it('keeps a window that fits, on any display', () => {
    const saved = { x: 2000, y: 40, width: 1000, height: 700, maximized: false };
    expect(placeWindow(saved, [screen, second], min)).toEqual(saved);
  });

  it('cascades further windows and grows small ones to the minimum', () => {
    const saved = { x: 100, y: 100, width: 500, height: 400, maximized: false };
    expect(placeWindow(saved, [screen], min, CASCADE)).toEqual({
      x: 124,
      y: 124,
      width: 960,
      height: 600,
      maximized: false,
    });
  });

  it('brings back a window left on a display that is gone', () => {
    const saved = { x: 3500, y: 200, width: 1200, height: 900, maximized: false };
    expect(placeWindow(saved, [screen], min)).toEqual({
      x: 360,
      y: 90,
      width: 1200,
      height: 900,
      maximized: false,
    });
  });

  it('shrinks a window larger than the display and keeps the default without a save', () => {
    const saved = { x: 0, y: 0, width: 4000, height: 3000, maximized: true };
    expect(placeWindow(saved, [second], min)).toEqual({
      x: 1920,
      y: 0,
      width: 1280,
      height: 800,
      maximized: true,
    });
    expect(placeWindow(undefined, [screen], min)).toBeUndefined();
  });
});
