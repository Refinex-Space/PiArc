import { describe, expect, it } from 'vitest';

import type { EventBatch } from '../../shared/ipc.js';
import { ProbeCounter } from './probe-counter.js';

const encoder = new TextEncoder();

function batch(route: string, seq: number, events: unknown[]): EventBatch {
  return { route, seq, payload: encoder.encode(JSON.stringify(events)) };
}

describe('ProbeCounter', () => {
  it('counts batches, events and bytes per route and stream', () => {
    const counter = new ProbeCounter();
    const first = batch('demo', 1, [
      { source: 1, seq: 1, pad: '' },
      { source: 1, seq: 2, pad: '' },
    ]);
    const second = batch('demo', 2, [{ source: 1, seq: 3, pad: '' }]);
    counter.record(first);
    counter.record(second);
    expect(counter.snapshot().routes.demo).toEqual({
      batches: 2,
      events: 3,
      bytes: first.payload.byteLength + second.payload.byteLength,
      largestBatchBytes: first.payload.byteLength,
      batchSeqErrors: 0,
      eventSeqErrors: 0,
      streams: { '1': { count: 3, lastSeq: 3 } },
      otherEvents: [],
      malformedBatches: 0,
    });
  });

  it('flags a missing batch and a missing or repeated event', () => {
    const counter = new ProbeCounter();
    counter.record(batch('demo', 1, [{ source: 1, seq: 1 }]));
    counter.record(batch('demo', 3, [{ source: 1, seq: 3 }]));
    counter.record(batch('demo', 4, [{ source: 1, seq: 3 }]));
    const route = counter.snapshot().routes.demo;
    expect(route?.batchSeqErrors).toBe(1);
    expect(route?.eventSeqErrors).toBe(2);
  });

  it('checks each stream of a route on its own', () => {
    const counter = new ProbeCounter();
    counter.record(
      batch('demo', 1, [
        { source: 1, seq: 1 },
        { source: 2, seq: 1 },
        { source: 1, seq: 2 },
      ]),
    );
    expect(counter.snapshot().routes.demo?.streams).toEqual({
      '1': { count: 2, lastSeq: 2 },
      '2': { count: 1, lastSeq: 1 },
    });
    expect(counter.snapshot().routes.demo?.eventSeqErrors).toBe(0);
  });

  it('keeps unnumbered events such as errors for inspection', () => {
    const counter = new ProbeCounter();
    const error = { code: -32603, message: 'boom', data: { kind: 'internalError' } };
    counter.record(batch('core/errors', 1, [error]));
    expect(counter.snapshot().routes['core/errors']?.otherEvents).toEqual([error]);
  });

  it('counts payloads that are not a JSON array as malformed', () => {
    const counter = new ProbeCounter();
    counter.record({ route: 'x', seq: 1, payload: encoder.encode('{"not":"an array"}') });
    counter.record({ route: 'x', seq: 2, payload: encoder.encode('not json') });
    expect(counter.snapshot().routes.x?.malformedBatches).toBe(2);
  });

  it('starts over after reset', () => {
    const counter = new ProbeCounter();
    counter.record(batch('demo', 1, [{ source: 1, seq: 1 }]));
    counter.reset();
    expect(counter.snapshot()).toEqual({ routes: {} });
  });
});
