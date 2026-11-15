// The main process's routing table: route key → windows subscribed to it (architecture
// sections 7.6 and 8.3). Each window has one event port (a MessagePortMain in production).
// Batches are forwarded by route key as they are; the payload is never read.
import { performance } from 'node:perf_hooks';

import type { EventBatch, EventPortMessage } from '../../shared/ipc.js';
import type { ForwardObservation, RouterStats } from '../../shared/test-hooks.js';

/** The sending end of a window's event channel. */
export interface EventPort {
  postMessage(message: EventPortMessage): void;
  close(): void;
}

interface WindowChannel {
  readonly port: EventPort;
  readonly routes: Set<string>;
}

export class EventRouter {
  readonly #windows = new Map<number, WindowChannel>();
  readonly #subscribers = new Map<string, Set<number>>();
  #observer: ((observation: ForwardObservation) => void) | undefined;
  #deliveries = 0;
  #batches = 0;
  #unrouted = 0;

  /**
   * Gives window `windowId` a new event port. A previous port of the same window (the page
   * reloaded) is closed and its subscriptions are dropped.
   */
  connect(windowId: number, port: EventPort): void {
    this.disconnect(windowId);
    this.#windows.set(windowId, { port, routes: new Set() });
  }

  /**
   * Forgets window `windowId` and closes its port. With `port`, only when that port is
   * still the window's current one (a late close event of a replaced port is ignored).
   */
  disconnect(windowId: number, port?: EventPort): void {
    const channel = this.#windows.get(windowId);
    if (channel === undefined || (port !== undefined && channel.port !== port)) {
      return;
    }
    this.#windows.delete(windowId);
    for (const route of channel.routes) {
      this.#removeSubscriber(route, windowId);
    }
    channel.port.close();
  }

  /** Routes `route` to window `windowId`. False when the window has no event port. */
  subscribe(windowId: number, route: string): boolean {
    const channel = this.#windows.get(windowId);
    if (channel === undefined) {
      return false;
    }
    channel.routes.add(route);
    let windows = this.#subscribers.get(route);
    if (windows === undefined) {
      windows = new Set();
      this.#subscribers.set(route, windows);
    }
    windows.add(windowId);
    return true;
  }

  /** Stops routing `route` to window `windowId`. */
  unsubscribe(windowId: number, route: string): void {
    this.#windows.get(windowId)?.routes.delete(route);
    this.#removeSubscriber(route, windowId);
  }

  /**
   * Posts each window one message with the batches of the routes it subscribed to. Batches
   * nobody subscribed to are dropped: routing is the only decision made here.
   */
  forward(batches: readonly EventBatch[]): void {
    const started = this.#observer === undefined ? 0 : performance.now();
    const perWindow = new Map<number, EventBatch[]>();
    for (const batch of batches) {
      const windows = this.#subscribers.get(batch.route);
      if (windows === undefined) {
        this.#unrouted += 1;
        continue;
      }
      for (const windowId of windows) {
        const list = perWindow.get(windowId);
        if (list === undefined) {
          perWindow.set(windowId, [batch]);
        } else {
          list.push(batch);
        }
      }
    }
    for (const [windowId, list] of perWindow) {
      const channel = this.#windows.get(windowId);
      try {
        channel?.port.postMessage({ batches: list });
      } catch (error) {
        console.error(`[core] failed to post events to window ${String(windowId)}`, error);
      }
    }
    this.#deliveries += 1;
    this.#batches += batches.length;
    if (this.#observer !== undefined) {
      let bytes = 0;
      let largestBatchBytes = 0;
      for (const batch of batches) {
        bytes += batch.payload.byteLength;
        largestBatchBytes = Math.max(largestBatchBytes, batch.payload.byteLength);
      }
      this.#observer({
        durationMs: performance.now() - started,
        batches: batches.length,
        bytes,
        largestBatchBytes,
        windows: perWindow.size,
      });
    }
  }

  /**
   * Posts `message` on window `windowId`'s port (a pulled terminal frame). False when the
   * window has no port (it reloaded or closed meanwhile).
   */
  postToWindow(windowId: number, message: EventPortMessage): boolean {
    const channel = this.#windows.get(windowId);
    if (channel === undefined) {
      return false;
    }
    try {
      channel.port.postMessage(message);
      return true;
    } catch (error) {
      console.error(`[core] failed to post to window ${String(windowId)}`, error);
      return false;
    }
  }

  /** Routes window `windowId` currently receives, sorted. */
  routesOf(windowId: number): string[] {
    return [...(this.#windows.get(windowId)?.routes ?? [])].sort();
  }

  /** Measures every forward from now on; `undefined` stops measuring. */
  observe(observer: ((observation: ForwardObservation) => void) | undefined): void {
    this.#observer = observer;
  }

  stats(): RouterStats {
    return {
      deliveries: this.#deliveries,
      batches: this.#batches,
      unrouted: this.#unrouted,
      windows: this.#windows.size,
    };
  }

  #removeSubscriber(route: string, windowId: number): void {
    const windows = this.#subscribers.get(route);
    if (windows === undefined) {
      return;
    }
    windows.delete(windowId);
    if (windows.size === 0) {
      this.#subscribers.delete(route);
    }
  }
}
