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
    readonly listeners = new Map<string, (...args: unknown[]) => void>();
    shown = false;
    constructor(
      readonly options: {
        title: string;
        body: string;
        actions?: { type: string; text: string }[];
      },
    ) {
      FakeNotification.created.push(this);
    }
    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, listener);
      return this;
    }
    show(): void {
      this.shown = true;
    }
    emit(event: string, ...args: unknown[]): void {
      this.listeners.get(event)?.(...args);
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
import type { AppEvent, NotificationApproval } from '../../shared/ipc.js';
import { Attention, type NotificationPort, type ShownNotification } from './attention.js';

/** A notification port that records what it showed and lets a test press its buttons. */
function fakePort(): {
  port: NotificationPort;
  shown: { title: string; body: string; actions: readonly string[]; press: (i: number) => void }[];
} {
  const shown: {
    title: string;
    body: string;
    actions: readonly string[];
    press: (i: number) => void;
  }[] = [];
  const port: NotificationPort = {
    supported: () => true,
    create: ({ title, body, actions }) => {
      let action: (index: number) => void = () => undefined;
      const notification: ShownNotification = {
        onClick: () => undefined,
        onFailed: () => undefined,
        onAction: (listener) => {
          action = listener;
        },
        show: () => undefined,
      };
      shown.push({
        title,
        body,
        actions,
        press: (i) => {
          action(i);
        },
      });
      return notification;
    },
  };
  return { port, shown };
}

const CARD: NotificationApproval = {
  requestId: 'req-1',
  sessionId: '019a8f3e-5b2c-7d41-9e60-3f1a2b4c5d6e',
  revision: 3,
  connectionEpoch: 7,
  tool: 'Bash',
  summary: 'npm test',
  allow: true,
};

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

  it('answers from a notification through the ledger and reports an answer that did not apply', async () => {
    const { port, shown } = fakePort();
    const answers: Record<string, unknown>[] = [];
    const told: AppEvent[] = [];
    let status = 'applied';
    const attention = new Attention('darwin', () => undefined, {
      notifications: port,
      answer: (json) => {
        answers.push(JSON.parse(json) as Record<string, unknown>);
        return Promise.resolve(JSON.stringify({ status }));
      },
      tell: (event) => told.push(event),
    });
    const t = new Translator('en');
    const notice = { kind: 'awaiting' as const, sessionId: 'main-1', title: 'Fix', approval: CARD };
    attention.notify(background(), notice, t, true);
    expect(shown[0]?.actions).toEqual(['Allow once', 'Deny']);
    expect(shown[0]?.body).toBe('Bash: npm test');
    await attention.pressAction(0);
    expect(answers[0]).toEqual({
      requestId: 'req-1',
      sessionId: CARD.sessionId,
      revision: 3,
      connectionEpoch: 7,
      decision: 'allowOnce',
      via: 'notification',
    });
    expect(told).toEqual([]);
    // The card was answered first: the ledger refuses the notification's answer.
    status = 'stale';
    attention.notify(background(), notice, t, true);
    shown[1]?.press(1);
    await vi.waitFor(() => {
      expect(told).toEqual([{ type: 'approvalNotice', sessionId: 'main-1', status: 'stale' }]);
    });
    expect(answers[1]?.decision).toBe('deny');
    expect(attention.observed().notified.at(-1)?.actions).toEqual(['Allow once', 'Deny']);
  });

  it('only opens a request a notification may not allow', async () => {
    const { port, shown } = fakePort();
    const opened: string[] = [];
    const answer = vi.fn(() => Promise.resolve('{"status":"applied"}'));
    const attention = new Attention('win32', (id) => opened.push(id), {
      notifications: port,
      answer,
    });
    const long = 'rm -rf build && ' + 'x'.repeat(300);
    attention.notify(
      background(),
      {
        kind: 'awaiting',
        sessionId: 'main-2',
        title: 'Clean',
        approval: { ...CARD, summary: long, allow: false },
      },
      new Translator('en'),
      true,
    );
    expect(shown[0]?.actions).toEqual(['Open']);
    expect(shown[0]?.body.length).toBeLessThan(200);
    await attention.pressAction(0);
    expect(opened).toEqual(['main-2']);
    expect(answer).not.toHaveBeenCalled();
  });

  it('gives Electron the buttons and reads the pressed one (macOS buttons, Windows toasts)', () => {
    FakeNotification.created = [];
    const answer = vi.fn(() => Promise.resolve('{"status":"applied"}'));
    const attention = new Attention('win32', () => undefined, { answer });
    attention.notify(
      background(),
      { kind: 'awaiting', sessionId: 'main-3', title: 'Test', approval: CARD },
      new Translator('zh-CN'),
      true,
    );
    const created = FakeNotification.created[0];
    expect(created?.options.actions).toEqual([
      { type: 'button', text: '允许本次' },
      { type: 'button', text: '拒绝' },
    ]);
    created?.emit('action', { actionIndex: 1, selectionIndex: -1 });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(JSON.parse((answer.mock.calls[0] as unknown as [string])[0])).toMatchObject({
      decision: 'deny',
      via: 'notification',
    });
  });
});
