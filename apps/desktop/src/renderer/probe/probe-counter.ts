// Counts the batches the probe page receives and checks their order: per route the batch
// numbers, per numbered stream (`{"source", "seq"}` events) the event numbers must each be
// consecutive.
import type { EventBatch } from '../../shared/ipc.js';
import type { ProbeSnapshot, RouteSnapshot, StreamSnapshot } from '../../shared/event-probe.js';

/** How many unnumbered events (echo, errors) a route keeps for inspection. */
const KEPT_OTHER_EVENTS = 20;

interface MutableRoute {
  batches: number;
  events: number;
  bytes: number;
  largestBatchBytes: number;
  lastBatchSeq: number;
  batchSeqErrors: number;
  eventSeqErrors: number;
  streams: Map<string, { count: number; lastSeq: number }>;
  otherEvents: unknown[];
  malformedBatches: number;
}

function numbered(event: unknown): { source: string; seq: number } | undefined {
  if (
    typeof event === 'object' &&
    event !== null &&
    'source' in event &&
    typeof event.source === 'number' &&
    'seq' in event &&
    typeof event.seq === 'number'
  ) {
    return { source: String(event.source), seq: event.seq };
  }
  return undefined;
}

export class ProbeCounter {
  readonly #routes = new Map<string, MutableRoute>();
  readonly #decoder = new TextDecoder();

  record(batch: EventBatch): void {
    const route = this.#route(batch.route);
    route.batches += 1;
    route.bytes += batch.payload.byteLength;
    route.largestBatchBytes = Math.max(route.largestBatchBytes, batch.payload.byteLength);
    if (batch.seq !== route.lastBatchSeq + 1) {
      route.batchSeqErrors += 1;
    }
    route.lastBatchSeq = batch.seq;
    let events: unknown;
    try {
      events = JSON.parse(this.#decoder.decode(batch.payload));
    } catch {
      route.malformedBatches += 1;
      return;
    }
    if (!Array.isArray(events)) {
      route.malformedBatches += 1;
      return;
    }
    for (const event of events as unknown[]) {
      route.events += 1;
      const id = numbered(event);
      if (id === undefined) {
        route.otherEvents.push(event);
        if (route.otherEvents.length > KEPT_OTHER_EVENTS) {
          route.otherEvents.shift();
        }
        continue;
      }
      const stream = route.streams.get(id.source) ?? { count: 0, lastSeq: 0 };
      if (id.seq !== stream.lastSeq + 1) {
        route.eventSeqErrors += 1;
      }
      stream.count += 1;
      stream.lastSeq = id.seq;
      route.streams.set(id.source, stream);
    }
  }

  snapshot(): ProbeSnapshot {
    const routes: Record<string, RouteSnapshot> = {};
    for (const [name, route] of this.#routes) {
      const streams: Record<string, StreamSnapshot> = {};
      for (const [source, stream] of route.streams) {
        streams[source] = { ...stream };
      }
      routes[name] = {
        batches: route.batches,
        events: route.events,
        bytes: route.bytes,
        largestBatchBytes: route.largestBatchBytes,
        batchSeqErrors: route.batchSeqErrors,
        eventSeqErrors: route.eventSeqErrors,
        streams,
        otherEvents: [...route.otherEvents],
        malformedBatches: route.malformedBatches,
      };
    }
    return { routes };
  }

  reset(): void {
    this.#routes.clear();
  }

  #route(name: string): MutableRoute {
    let route = this.#routes.get(name);
    if (route === undefined) {
      route = {
        batches: 0,
        events: 0,
        bytes: 0,
        largestBatchBytes: 0,
        lastBatchSeq: 0,
        batchSeqErrors: 0,
        eventSeqErrors: 0,
        streams: new Map(),
        otherEvents: [],
        malformedBatches: 0,
      };
      this.#routes.set(name, route);
    }
    return route;
  }
}
