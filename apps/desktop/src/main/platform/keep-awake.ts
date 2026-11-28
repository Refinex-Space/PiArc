// Keeps the computer awake while the agent works (ADR-0109): while the preference
// `power.keepAwake` is on (the default) and at least one session is in a turn, one Electron
// power save blocker of type `prevent-app-suspension` is held, so idle system sleep does not
// cut a long turn short; the display still sleeps on the system's schedule, and closing the lid
// or choosing Sleep still sleeps. The running count is Core's `core/activity` (the tray's), so
// background commands and terminals alone do not hold it.
import { powerSaveBlocker } from 'electron';

/** The two calls of Electron's `powerSaveBlocker` the controller makes. */
export interface PowerBlocker {
  start(): number;
  stop(id: number): void;
}

export const ELECTRON_POWER_BLOCKER: PowerBlocker = {
  start: () => powerSaveBlocker.start('prevent-app-suspension'),
  stop: (id) => {
    powerSaveBlocker.stop(id);
  },
};

export class KeepAwake {
  private readonly blocker: PowerBlocker;
  private enabled: boolean;
  private running = 0;
  private id: number | undefined;
  private disposed = false;

  constructor(blocker: PowerBlocker, enabled: boolean) {
    this.blocker = blocker;
    this.enabled = enabled;
  }

  /** The preference changed. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.reconcile();
  }

  /** Core reported how many sessions are in a turn. */
  setRunning(running: number): void {
    this.running = running;
    this.reconcile();
  }

  /** Whether the blocker is held now. */
  held(): boolean {
    return this.id !== undefined;
  }

  /** Releases the blocker for good (the app is quitting). */
  dispose(): void {
    this.disposed = true;
    this.reconcile();
  }

  private reconcile(): void {
    const wanted = !this.disposed && this.enabled && this.running > 0;
    if (wanted && this.id === undefined) {
      try {
        this.id = this.blocker.start();
      } catch (error) {
        // The system may have no power service (a headless CI runner): work goes on, unheld.
        console.warn('[keep-awake] could not prevent system sleep', error);
      }
    } else if (!wanted && this.id !== undefined) {
      const id = this.id;
      this.id = undefined;
      this.blocker.stop(id);
    }
  }
}
