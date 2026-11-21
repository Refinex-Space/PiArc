// The main-process test hooks (src/main/core/test-hooks.ts) as L4 tests and the S2
// benchmark see them through Playwright's `electronApp.evaluate`. They exist only when the
// loaded Core is a development build. Test-only: no product feature uses them.

import type { LaunchTarget } from './ipc.js';

/**
 * Event-loop delay percentiles of the main process, in milliseconds, as
 * `monitorEventLoopDelay` reports them: each value is the interval between two samples, so it
 * includes `resolutionMs` on top of the delay itself.
 */
export interface LoopDelaySummary {
  readonly resolutionMs: number;
  readonly p50: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
  readonly samples: number;
}

/** Measurements of one forwarded Core delivery. */
export interface ForwardObservation {
  /** Time spent posting the delivery to every subscribed window. */
  readonly durationMs: number;
  readonly batches: number;
  /** Payload bytes of the delivery's batches. */
  readonly bytes: number;
  /** Payload bytes of the largest batch. */
  readonly largestBatchBytes: number;
  /** Windows that received a message. */
  readonly windows: number;
}

/** Running totals of the main process's event router. */
export interface RouterStats {
  readonly deliveries: number;
  readonly batches: number;
  /** Batches no window was subscribed to. */
  readonly unrouted: number;
  readonly windows: number;
}

/** Terminal frames the main process returned to windows (T10). Mutable counters owned by main. */
export interface TerminalForwardStats {
  /** `requestTerminalFrame` calls. */
  requests: number;
  /** Frames returned to windows. */
  frames: number;
  /** Bytes of those frames. */
  bytes: number;
  /** Requests Core failed. */
  errors: number;
}

/** Counters of one terminal in Core (T10 measurements). */
export interface TerminalCoreStats {
  readonly bytesRead: number;
  readonly reads: number;
  readonly vtWriteMicros: number;
  readonly frames: number;
  readonly emptyFrames: number;
  readonly frameBytes: number;
  readonly frameMicros: number;
  readonly rowsWithCells: number;
  readonly rowsReused: number;
}

/** What a test runs in a terminal it creates through the hooks. */
export interface TestTerminalOptions {
  readonly cols: number;
  readonly rows: number;
  readonly cellWidth?: number;
  readonly cellHeight?: number;
  /** Program instead of the login shell, for example `cat` or `sh`. */
  readonly program?: string;
  readonly args?: string[];
  /** Absolute working directory. */
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

/**
 * The testing exports of Core the hooks hand out. A subset of the generated
 * src/main/core/native/piarc-core.testing.d.ts; the main process assigns the real runtime
 * to it, so a signature change there fails type checking here.
 */
export interface TestCoreApi {
  readonly state: string;
  startDemoSource(options: {
    route: string;
    eventsPerSecond: number;
    padBytes?: number;
    maxEvents?: number;
  }): number;
  stopDemoSource(id: number): Promise<{ id: number; emitted: number }>;
  echo(route: string, payload: string): void;
  eventStats(): {
    queued: number;
    deliveries: number;
    batches: number;
    delivered: number;
    lost: number;
  };
  triggerPanic(): void;
  spawnPanickingTask(): void;
  /** The visible screen of a terminal from libghostty-vt's formatter. */
  terminalText(id: number): Promise<string>;
  terminalStats(id: number): TerminalCoreStats;
  /** What a terminal shows, as JSON text (`TerminalInfo`: size, title, sharing, …). */
  terminalInfo(id: number): string;
  /** Microseconds from writing `byte` straight to the PTY until its echo was read back. */
  terminalProbeEcho(id: number, byte: number): Promise<number>;
  /**
   * Starts the packaged app's Agent Host as production does, holds one conversation and
   * resolves with the report as JSON (`piarc_core::host_probe::ProbeReport`, S6).
   */
  agentHostProbe(options: {
    resourcesDir: string;
    workspace: string;
    dataDir: string;
    provider: string;
    model: string;
    prompt: string;
    timeoutMs?: number;
  }): Promise<string>;
  /**
   * The keychain probe of the S6 checklist (`piarc_core::keychain_probe`): `write`, `read` or
   * `delete` a probe vault in `dir`; resolves with the report as JSON.
   */
  keychainProbe(action: 'write' | 'read' | 'delete', dir: string): Promise<string>;
}

/** One event of a test notification (`Notification` in the main process, S6). */
export interface NotificationProbeEvent {
  readonly type: 'show' | 'failed' | 'click' | 'close';
  /** Milliseconds after `show()` was called. */
  readonly atMs: number;
  /** The error text of `failed`. */
  readonly detail?: string;
}

export interface PiarcTestHooks {
  /** The loaded `.node` file. */
  readonly modulePath: string;
  readonly core: TestCoreApi;
  routerStats(): RouterStats;
  /** Routes the window with this `webContents.id` receives. */
  routesOf(webContentsId: number): string[];
  /** Opens another app window on `hash` (for example `#/event-probe`); resolves its id. */
  openWindow(hash: string): Promise<number>;
  /** Calls `core.echo` `calls` times and returns each call's duration in milliseconds. */
  measureEcho(route: string, payload: string, calls: number): number[];
  startLoopDelay(): void;
  stopLoopDelay(): LoopDelaySummary;
  /** Records every forwarded delivery until `stopForwardTimings`. */
  startForwardTimings(): void;
  stopForwardTimings(): ForwardObservation[];
  /**
   * Starts a terminal owned by the window with this `webContents.id` (so its page can use it
   * through `window.piarc`) and resolves its id. Unlike `window.piarc.createTerminal`, the
   * program, arguments and environment are the test's choice.
   */
  createTerminal(webContentsId: number, options: TestTerminalOptions): Promise<number>;
  /** Counters of the frames the main process returned. */
  terminalForwardStats(): TerminalForwardStats;
  /**
   * Shows a system notification and resolves after `waitMs` with whether notifications are
   * supported and the events it emitted (S6: ad-hoc signed builds on macOS).
   */
  showNotification(
    title: string,
    body: string,
    waitMs: number,
  ): Promise<{ supported: boolean; events: NotificationProbeEvent[] }>;
  /** What the attention module did (T18): notifications, Dock bounces, the badge count. */
  attention(): AttentionObservation;
  /** Makes the next call on IPC `channel` fail with `message` before it reaches Core (T18). */
  failNext(channel: string, message: string): void;
  /** Makes the next answer on IPC `channel` reach the window `ms` after Core gave it. */
  holdNext(channel: string, ms: number): void;
  /** The tray's title, tooltip, menu item ids and counts (T35); undefined before it exists. */
  tray(): TrayObservation | undefined;
  /** Routes a launch target as a link or a second start would (T35). */
  launch(target: LaunchTarget): void;
  /** Quits as the menu and the tray do: asks first when work is running (T35). */
  quit(): void;
  /** `webContents.id` of each open main window (T35). */
  mainWindows(): number[];
}

/** See `src/main/platform/tray.ts`. */
export interface TrayObservation {
  readonly title: string;
  readonly tooltip: string;
  readonly items: readonly string[];
  readonly activity: {
    readonly running: number;
    readonly awaiting: number;
    readonly awaitingSessions: readonly { readonly id: string; readonly title?: string }[];
  };
}

/** See `src/main/platform/attention.ts`. */
export interface AttentionObservation {
  readonly notified: readonly { kind: string; title: string; body: string; shown: boolean }[];
  readonly bounces: number;
  readonly count: number;
}

declare global {
  var __piarcTestHooks: PiarcTestHooks | undefined;
}
