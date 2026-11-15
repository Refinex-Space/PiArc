// The main-process test hooks (src/main/core/test-hooks.ts) as L4 tests and the S2
// benchmark see them through Playwright's `electronApp.evaluate`. They exist only when the
// loaded Core is a development build. Test-only: no product feature uses them.

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
}

declare global {
  var __piarcTestHooks: PiarcTestHooks | undefined;
}
