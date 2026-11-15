import { describe, expect, it } from 'vitest';

import type { EventBatch, EventPortMessage } from '../../shared/ipc.js';
import type { ForwardObservation } from '../../shared/test-hooks.js';
import { EventRouter, type EventPort } from './router.js';

class RecordingPort implements EventPort {
  readonly messages: EventPortMessage[] = [];
  closed = false;
  postMessage(message: EventPortMessage): void {
    this.messages.push(message);
  }
  close(): void {
    this.closed = true;
  }
  routes(): string[] {
    return this.messages.flatMap((m) => m.batches.map((b) => `${b.route}#${String(b.seq)}`));
  }
}

function batch(route: string, seq: number, bytes = 4): EventBatch {
  return { route, seq, payload: new Uint8Array(bytes) };
}

describe('EventRouter', () => {
  it('forwards each batch only to the windows subscribed to its route', () => {
    const router = new EventRouter();
    const a = new RecordingPort();
    const b = new RecordingPort();
    router.connect(1, a);
    router.connect(2, b);
    router.subscribe(1, 'alpha');
    router.subscribe(2, 'beta');
    router.subscribe(2, 'shared');
    router.subscribe(1, 'shared');

    router.forward([batch('alpha', 1), batch('beta', 1), batch('shared', 1), batch('none', 1)]);

    expect(a.routes()).toEqual(['alpha#1', 'shared#1']);
    expect(b.routes()).toEqual(['beta#1', 'shared#1']);
    expect(a.messages).toHaveLength(1);
    expect(router.stats()).toEqual({ deliveries: 1, batches: 4, unrouted: 1, windows: 2 });
  });

  it('passes the batch objects through unchanged', () => {
    const router = new EventRouter();
    const port = new RecordingPort();
    router.connect(1, port);
    router.subscribe(1, 'alpha');
    const sent = batch('alpha', 7, 3);
    router.forward([sent]);
    expect(port.messages[0]?.batches[0]).toBe(sent);
  });

  it('sends nothing to a window without subscriptions', () => {
    const router = new EventRouter();
    const port = new RecordingPort();
    router.connect(1, port);
    router.forward([batch('alpha', 1)]);
    expect(port.messages).toEqual([]);
  });

  it('stops forwarding a route after unsubscribe', () => {
    const router = new EventRouter();
    const port = new RecordingPort();
    router.connect(1, port);
    router.subscribe(1, 'alpha');
    router.forward([batch('alpha', 1)]);
    router.unsubscribe(1, 'alpha');
    router.forward([batch('alpha', 2)]);
    expect(port.routes()).toEqual(['alpha#1']);
    expect(router.routesOf(1)).toEqual([]);
  });

  it('refuses subscriptions from a window that has no port', () => {
    const router = new EventRouter();
    expect(router.subscribe(9, 'alpha')).toBe(false);
  });

  it('replaces the port of a reloaded window and drops its old subscriptions', () => {
    const router = new EventRouter();
    const before = new RecordingPort();
    const after = new RecordingPort();
    router.connect(1, before);
    router.subscribe(1, 'alpha');
    router.connect(1, after);
    router.forward([batch('alpha', 1)]);
    expect(before.closed).toBe(true);
    expect(after.messages).toEqual([]);
    expect(router.routesOf(1)).toEqual([]);
  });

  it('ignores a late close of a replaced port', () => {
    const router = new EventRouter();
    const before = new RecordingPort();
    const after = new RecordingPort();
    router.connect(1, before);
    router.connect(1, after);
    router.subscribe(1, 'alpha');
    router.disconnect(1, before);
    router.forward([batch('alpha', 1)]);
    expect(after.routes()).toEqual(['alpha#1']);
  });

  it('forgets a disconnected window', () => {
    const router = new EventRouter();
    const port = new RecordingPort();
    router.connect(1, port);
    router.subscribe(1, 'alpha');
    router.disconnect(1);
    router.forward([batch('alpha', 1)]);
    expect(port.closed).toBe(true);
    expect(port.messages).toEqual([]);
    expect(router.stats().windows).toBe(0);
  });

  it('keeps forwarding to the other windows when one port throws', () => {
    const router = new EventRouter();
    const broken: EventPort = {
      postMessage: () => {
        throw new Error('port gone');
      },
      close: () => undefined,
    };
    const healthy = new RecordingPort();
    router.connect(1, broken);
    router.connect(2, healthy);
    router.subscribe(1, 'alpha');
    router.subscribe(2, 'alpha');
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      router.forward([batch('alpha', 1)]);
    } finally {
      console.error = original;
    }
    expect(healthy.routes()).toEqual(['alpha#1']);
    expect(errors).toHaveLength(1);
  });

  it('reports sizes and duration to an observer', () => {
    const router = new EventRouter();
    const port = new RecordingPort();
    router.connect(1, port);
    router.subscribe(1, 'alpha');
    const seen: ForwardObservation[] = [];
    router.observe((observation) => seen.push(observation));
    router.forward([batch('alpha', 1, 10), batch('beta', 1, 30)]);
    router.observe(undefined);
    router.forward([batch('alpha', 2, 10)]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ batches: 2, bytes: 40, largestBatchBytes: 30, windows: 1 });
    expect(seen[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
