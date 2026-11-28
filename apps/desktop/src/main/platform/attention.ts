// System notifications and the count of sessions that need the user (architecture section
// 8.8, ADR-0018 item 6, I43). The renderer decides which sessions need the user (it holds
// Core's session snapshot); this module shows them the platform's way:
//
// - a system notification when the window is not in front and notifications are on;
// - always with the Dock bounce (macOS) or a taskbar flash (Windows): on macOS Electron reports
//   `show` even when the user turned PiArc's notifications off (S6), so the program cannot tell
//   whether a banner appeared; the renderer adds its own in-app reminder for the same reason;
// - the count as the Dock badge (macOS) or a taskbar overlay icon (Windows).
//
// T42 (FR-SY-03): a session waiting for approval gets action buttons. A card Core marked
// `notificationAllow` offers "Allow once" and "Deny"; any other (critical deletion, outside the
// sandbox, protected path, too long to read in a notification) only "Open". A button answers
// through Core's approval ledger exactly like the card (`answerApproval`, with
// `via: notification`); an answer that was not applied tells the window. Electron's `actions`
// work on macOS (S6: notifications show under ad-hoc signing once allowed) and as Windows toast
// buttons; the system notification itself sits behind `NotificationPort`, which tests replace.
import { app, nativeImage, Notification, type BrowserWindow, type NativeImage } from 'electron';

import { COLORS } from '../../shared/design-tokens.js';
import type { AppEvent, AttentionNotice, NotificationApproval } from '../../shared/ipc.js';
import type { AttentionObservation } from '../../shared/test-hooks.js';
import type { Translator } from '../../shared/i18n/index.js';

/** What a test can observe (development builds' test hooks). */
export type AttentionRecord = AttentionObservation;

/** Notifications kept for their `click`: more than this many are let go, oldest first. */
const HELD_NOTIFICATIONS = 32;

/** One shown system notification. */
export interface ShownNotification {
  onClick(listener: () => void): void;
  onFailed(listener: () => void): void;
  /** A button was pressed: its index in `actions`. */
  onAction(listener: (index: number) => void): void;
  show(): void;
}

/** System notifications (Electron's, or a test double). */
export interface NotificationPort {
  supported(): boolean;
  create(options: {
    readonly title: string;
    readonly body: string;
    readonly actions: readonly string[];
  }): ShownNotification;
}

/** Electron's notifications: `actions` are macOS buttons and Windows toast buttons. */
export const ELECTRON_NOTIFICATIONS: NotificationPort = {
  supported: () => Notification.isSupported(),
  create: ({ title, body, actions }) => {
    const notification = new Notification({
      title,
      body,
      ...(actions.length === 0
        ? {}
        : { actions: actions.map((text) => ({ type: 'button' as const, text })) }),
    });
    return {
      onClick: (listener) => notification.on('click', listener),
      onFailed: (listener) => notification.on('failed', listener),
      onAction: (listener) =>
        notification.on('action', (details) => {
          listener(details.actionIndex);
        }),
      show: () => {
        notification.show();
      },
    };
  },
};

/** What the attention needs besides the notifications (T42). */
export interface AttentionOptions {
  readonly notifications?: NotificationPort;
  /** Core's `answerApproval` (an `ApprovalAnswer` as JSON); resolves to `{ status }` JSON. */
  readonly answer?: (answer: string) => Promise<string>;
  /** Tells the main window something (an answer that was not applied). */
  readonly tell?: (event: AppEvent) => void;
}

/** The longest command or path a notification shows. */
const SUMMARY_CHARS = 160;

export class Attention {
  private overlay: NativeImage | undefined;
  /**
   * Shown notifications. A notification that is garbage collected no longer receives `click`
   * on Windows, where a toast stays clickable in the notification center after it closes (W1).
   */
  private readonly held = new Set<ShownNotification>();
  /** Action handlers of the newest notification with buttons (test hooks). */
  private lastActions: ((index: number) => Promise<void>) | undefined;
  private options: AttentionOptions;
  private readonly record: {
    notified: {
      kind: string;
      title: string;
      body: string;
      shown: boolean;
      actions: readonly string[];
    }[];
    bounces: number;
    count: number;
  } = { notified: [], bounces: 0, count: 0 };

  constructor(
    private readonly platform: string,
    /** Opens a session in the main window (a notification was clicked). */
    private readonly openSession: (sessionId: string) => void,
    options: AttentionOptions = {},
  ) {
    this.options = options;
  }

  /** Whether the system shows notifications at all (the settings page explains if not). */
  notificationsSupported(): boolean {
    return (this.options.notifications ?? ELECTRON_NOTIFICATIONS).supported();
  }

  /** Connects the approval answers once Core is up (T42). */
  connect(options: AttentionOptions): void {
    this.options = { ...this.options, ...options };
  }

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
    const approval = notice.kind === 'awaiting' ? notice.approval : undefined;
    const body =
      approval === undefined
        ? translator.t(notice.kind === 'awaiting' ? 'notify.awaitingBody' : 'notify.completedBody')
        : translator.t('notify.approvalBody', {
            tool: approval.tool,
            summary: cut(approval.summary),
          });
    const actions =
      approval === undefined
        ? []
        : approval.allow
          ? [translator.t('notify.allowOnce'), translator.t('notify.deny')]
          : [translator.t('notify.open')];
    const port = this.options.notifications ?? ELECTRON_NOTIFICATIONS;
    const shown = notificationsEnabled && port.supported();
    if (shown) {
      const notification = port.create({ title, body, actions });
      notification.onClick(() => {
        this.held.delete(notification);
        this.openSession(notice.sessionId);
      });
      notification.onFailed(() => {
        this.held.delete(notification);
      });
      if (approval !== undefined) {
        const act = (index: number): Promise<void> => {
          this.held.delete(notification);
          return this.act(notice.sessionId, approval, index);
        };
        notification.onAction((index) => {
          void act(index);
        });
        this.lastActions = act;
      }
      this.held.add(notification);
      for (const oldest of this.held) {
        if (this.held.size <= HELD_NOTIFICATIONS) break;
        this.held.delete(oldest);
      }
      notification.show();
    }
    this.record.notified.push({ kind: notice.kind, title, body, shown, actions });
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

  /**
   * A notification button: "Allow once" (0) or "Deny" (1) answer through Core's ledger, with
   * `via: notification`; "Open" (the only button of a card a notification may not allow) opens
   * the session. An answer that was not applied tells the window.
   */
  private async act(session: string, approval: NotificationApproval, index: number): Promise<void> {
    if (!approval.allow) {
      this.openSession(session);
      return;
    }
    const answer = this.options.answer;
    if (answer === undefined || (index !== 0 && index !== 1)) {
      this.openSession(session);
      return;
    }
    let status = 'failed';
    try {
      const reply: unknown = JSON.parse(
        await answer(
          JSON.stringify({
            requestId: approval.requestId,
            sessionId: approval.sessionId,
            revision: approval.revision,
            connectionEpoch: approval.connectionEpoch,
            decision: index === 0 ? 'allowOnce' : 'deny',
            via: 'notification',
          }),
        ),
      );
      if (typeof reply === 'object' && reply !== null && 'status' in reply) {
        status = String(reply.status);
      }
    } catch {
      status = 'failed';
    }
    if (status !== 'applied') {
      this.options.tell?.({ type: 'approvalNotice', sessionId: session, status });
    }
  }

  /** Presses a button of the newest notification with buttons (test hooks). */
  async pressAction(index: number): Promise<void> {
    if (this.lastActions === undefined) throw new Error('no notification with actions');
    await this.lastActions(index);
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

/** A command or path cut to what a notification shows. */
function cut(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > SUMMARY_CHARS || line !== text ? `${line.slice(0, SUMMARY_CHARS)}…` : line;
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
