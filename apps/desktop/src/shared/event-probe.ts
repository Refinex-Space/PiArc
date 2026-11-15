// The event probe page (renderer, `#/event-probe`) and what it exposes to L4 tests and the
// S2 benchmark as `window.__piarcEventProbe`. Test-only: no product feature uses it.

/** Hash that opens the probe page instead of the app shell. */
export const EVENT_PROBE_HASH = '#/event-probe';

/** Counters of one numbered stream (a demo source) within a route. */
export interface StreamSnapshot {
  /** Events received. */
  readonly count: number;
  /** Highest `seq` received. */
  readonly lastSeq: number;
}

/** What the probe saw on one route. */
export interface RouteSnapshot {
  readonly batches: number;
  readonly events: number;
  /** Payload bytes received. */
  readonly bytes: number;
  readonly largestBatchBytes: number;
  /** Batches whose `seq` was not the previous one plus 1. */
  readonly batchSeqErrors: number;
  /** Numbered events whose `seq` was not the previous one of their stream plus 1. */
  readonly eventSeqErrors: number;
  /** Numbered streams by source id. */
  readonly streams: Readonly<Record<string, StreamSnapshot>>;
  /** Events without a source and seq (echo and error events), the last few kept. */
  readonly otherEvents: readonly unknown[];
  /** Payloads that were not a JSON array. */
  readonly malformedBatches: number;
}

export interface ProbeSnapshot {
  readonly routes: Readonly<Record<string, RouteSnapshot>>;
}

export interface EventProbeApi {
  /** Subscribes `routes` through `window.piarc.subscribeEvents`. */
  subscribe(routes: readonly string[]): Promise<void>;
  unsubscribe(route: string): Promise<void>;
  snapshot(): ProbeSnapshot;
  reset(): void;
}

declare global {
  /** Present on the probe page only (set by src/renderer/probe/EventProbe.tsx). */
  var __piarcEventProbe: EventProbeApi | undefined;
}
