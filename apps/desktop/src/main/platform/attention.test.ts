// W1: a system notification must stay referenced until it is clicked, closed or fails. On
// Windows a collected Notification no longer receives `click`: the user clicked a toast, Windows
// brought PiArc forward, and the session did not open.
import { describe, expect, it, vi } from 'vitest';

const { FakeNotification } = vi.hoisted(() => {
  class FakeNotification {
    static created: FakeNotification[] = [];
    static isSupported(): boolean {
      return true;
    }
    readonly listeners = new Map<string, () => void>();
    shown = false;
    constructor(readonly options: { title: string; body: string }) {
      FakeNotification.created.push(this);
    }
    on(event: string, listener: () => void): this {
      this.listeners.set(event, listener);
      return this;
    }
    show(): void {
      this.shown = true;
    }
    emit(event: string): void {
      this.listeners.get(event)?.();
    }
  }
  return { FakeNotification };
});

const { createFromBitmap } = vi.hoisted(() => ({ createFromBitmap: vi.fn(() => ({})) }));

vi.mock('electron', () => ({
  app: { dock: undefined, setBadgeCount: vi.fn() },
  nativeImage: { createFromBitmap },
  Notification: FakeNotification,
}));

import type { BrowserWindow } from 'electron';

import { Translator } from '../../shared/i18n/index.js';
import { Attention } from './attention.js';

function background(): BrowserWindow {
  return {
    isDestroyed: () => false,
    isFocused: () => false,
    flashFrame: vi.fn(),
    once: vi.fn(),
  } as unknown as BrowserWindow;
}

describe('Attention', () => {
  it('keeps each notification until it is clicked or fails, and a click opens it', () => {
    const opened: string[] = [];
    const attention = new Attention('win32', (id) => opened.push(id));
    const t = new Translator('en');
    for (const sessionId of ['a', 'b', 'c']) {
      attention.notify(background(), { kind: 'completed', sessionId, title: sessionId }, t, true);
    }
    expect(FakeNotification.created.map((n) => n.shown)).toEqual([true, true, true]);
    expect(attention.heldNotifications()).toBe(3);
    const [a, b, c] = FakeNotification.created;
    a?.emit('click');
    expect(opened).toEqual(['a']);
    // Closed toasts stay clickable in the notification center.
    b?.emit('close');
    expect(attention.heldNotifications()).toBe(2);
    c?.emit('failed');
    expect(attention.heldNotifications()).toBe(1);
  });

  it('keeps at most 32 notifications', () => {
    const attention = new Attention('win32', () => undefined);
    const t = new Translator('en');
    for (let i = 0; i < 40; i += 1) {
      attention.notify(
        background(),
        { kind: 'completed', sessionId: String(i), title: '' },
        t,
        true,
      );
    }
    expect(attention.heldNotifications()).toBe(32);
  });

  it('draws the taskbar count as a smooth dot that Windows scales down', () => {
    const attention = new Attention('win32', () => undefined);
    const window = {
      isDestroyed: () => false,
      setOverlayIcon: vi.fn(),
    } as unknown as BrowserWindow;
    attention.setCount(window, 2, new Translator('en'));
    const [pixels, options] = createFromBitmap.mock.calls[0] as unknown as [
      Buffer,
      { width: number; height: number; scaleFactor?: number },
    ];
    // W1: a 16 px dot without edge coverage showed as a jagged block on a scaled display.
    expect(options).toEqual({ width: 32, height: 32, scaleFactor: 2 });
    const alphas = new Set<number>();
    for (let i = 3; i < pixels.length; i += 4) alphas.add(pixels[i] ?? 0);
    expect([...alphas].some((a) => a > 0 && a < 255)).toBe(true);
  });
});
