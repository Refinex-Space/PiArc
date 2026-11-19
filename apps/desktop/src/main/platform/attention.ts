// System notifications and the count of sessions that need the user (architecture section
// 8.8, ADR-0018 item 6, I43). The renderer decides which sessions need the user (it holds
// Core's session snapshot); this module shows them the platform's way:
//
// - a system notification when the window is not in front and notifications are on;
// - always with the Dock bounce (macOS) or a taskbar flash (Windows): on macOS Electron reports
//   `show` even when the user turned PiArc's notifications off (S6), so the program cannot tell
//   whether a banner appeared; the renderer adds its own in-app reminder for the same reason;
// - the count as the Dock badge (macOS) or a taskbar overlay icon (Windows).
import { app, nativeImage, Notification, type BrowserWindow, type NativeImage } from 'electron';

import { COLORS } from '../../shared/design-tokens.js';
import type { AttentionNotice } from '../../shared/ipc.js';
import type { AttentionObservation } from '../../shared/test-hooks.js';
import type { Translator } from '../../shared/i18n/index.js';

/** What a test can observe (development builds' test hooks). */
export type AttentionRecord = AttentionObservation;

/** Notifications kept for their `click`: more than this many are let go, oldest first. */
const HELD_NOTIFICATIONS = 32;

export class Attention {
  private overlay: NativeImage | undefined;
  /**
   * Shown notifications. A notification that is garbage collected no longer receives `click`
   * on Windows, where a toast stays clickable in the notification center after it closes (W1).
   */
  private readonly held = new Set<Notification>();
  private readonly record: {
    notified: { kind: string; title: string; body: string; shown: boolean }[];
    bounces: number;
    count: number;
  } = { notified: [], bounces: 0, count: 0 };

  constructor(
    private readonly platform: string,
    /** Opens a session in the main window (a notification was clicked). */
    private readonly openSession: (sessionId: string) => void,
  ) {}

  /** Tells the user `notice` needs them, the way the platform allows. */
  notify(
    window: BrowserWindow,
    notice: AttentionNotice,
    translator: Translator,
    notificationsEnabled: boolean,
  ): void {
    if (window.isDestroyed() || window.isFocused()) {
      return;
    }
    const title = translator.t(
      notice.kind === 'completed'
        ? 'notify.completed'
        : notice.kind === 'awaiting'
          ? 'notify.awaiting'
          : 'notify.failed',
      { title: notice.title },
    );
    const body = translator.t(
      notice.kind === 'awaiting' ? 'notify.awaitingBody' : 'notify.completedBody',
    );
    const shown = notificationsEnabled && Notification.isSupported();
    if (shown) {
      const notification = new Notification({ title, body });
      notification.on('click', () => {
        this.held.delete(notification);
        this.openSession(notice.sessionId);
      });
      notification.on('failed', () => {
        this.held.delete(notification);
      });
      this.held.add(notification);
      for (const oldest of this.held) {
        if (this.held.size <= HELD_NOTIFICATIONS) break;
        this.held.delete(oldest);
      }
      notification.show();
    }
    this.record.notified.push({ kind: notice.kind, title, body, shown });
    if (this.platform === 'darwin') {
      app.dock?.bounce('informational');
    } else {
      window.flashFrame(true);
      window.once('focus', () => {
        window.flashFrame(false);
      });
    }
    this.record.bounces += 1;
  }

  /** Shows `count` sessions that need the user on the Dock icon or the taskbar button. */
  setCount(window: BrowserWindow | undefined, count: number, translator: Translator): void {
    this.record.count = count;
    if (this.platform === 'darwin') {
      app.setBadgeCount(count);
      return;
    }
    if (window === undefined || window.isDestroyed()) {
      return;
    }
    if (count === 0) {
      window.setOverlayIcon(null, '');
      return;
    }
    this.overlay ??= badgeImage();
    window.setOverlayIcon(this.overlay, translator.t('workspace.count', { count }));
  }

  /** How many shown notifications are kept for their `click` (unit tests). */
  heldNotifications(): number {
    return this.held.size;
  }

  /** For the test hooks. */
  observed(): AttentionRecord {
    return { ...this.record, notified: [...this.record.notified] };
  }
}

/**
 * The dot in the "running" status color for the Windows taskbar overlay (BGRA pixels): drawn at
 * twice the 16 px overlay size with smooth edges, so Windows scales it down on any display. A
 * 16 px dot with hard edges showed as a jagged block on a scaled display (W1).
 */
function badgeImage(): NativeImage {
  const size = 32;
  const samples = 4;
  const radius = size / 2 - 1;
  const pixels = Buffer.alloc(size * size * 4);
  const color = COLORS.light['agentStatus.running'];
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // The share of the pixel inside the circle, from samples × samples points.
      let inside = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const dx = x + (sx + 0.5) / samples - size / 2;
          const dy = y + (sy + 0.5) / samples - size / 2;
          if (dx * dx + dy * dy <= radius * radius) inside += 1;
        }
      }
      const alpha = inside / (samples * samples);
      const at = (y * size + x) * 4;
      // Premultiplied, as Chromium's bitmaps are.
      pixels[at] = Math.round((b ?? 0) * alpha);
      pixels[at + 1] = Math.round((g ?? 0) * alpha);
      pixels[at + 2] = Math.round((r ?? 0) * alpha);
      pixels[at + 3] = Math.round(0xff * alpha);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
}
