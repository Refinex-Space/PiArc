import { describe, expect, it } from 'vitest';

import { OutboundQueue, type FrameSink, type OutboundStats } from './outbound.js';

/** A sink whose backpressure the test controls. */
class FakeSink implements FrameSink {
  readonly frames: Record<string, unknown>[] = [];
  blocked = false;
  #drain: (() => void) | undefined;

  write(chunk: Uint8Array): boolean {
    const text = new TextDecoder().decode(chunk);
    expect(text.endsWith('\n')).toBe(true);
    this.frames.push(JSON.parse(text) as Record<string, unknown>);
    return !this.blocked;
  }

  once(_event: 'drain', listener: () => void): void {
    this.#drain = listener;
  }

  drain(): void {
    this.blocked = false;
    const listener = this.#drain;
    this.#drain = undefined;
    listener?.();
  }
}

/** The frame's params; `{}` for responses, which have none. */
function params(frame: Record<string, unknown>): Record<string, unknown> {
  return (frame.params ?? {}) as Record<string, unknown>;
}

function queue(
  sink: FrameSink,
  maxQueuedBytes?: number,
): { q: OutboundQueue; overflows: OutboundStats[] } {
  const overflows: OutboundStats[] = [];
  const q = new OutboundQueue(sink, {
    ...(maxQueuedBytes === undefined ? {} : { maxQueuedBytes }),
    onOverflow: (stats) => overflows.push(stats),
  });
  return { q, overflows };
}

describe('OutboundQueue', () => {
  it('numbers session events per session from 1 without gaps and keeps their order', () => {
    const sink = new FakeSink();
    const { q } = queue(sink);
    q.sendSessionEvent('a', 'turn/started', { turnId: 't1' });
    q.sendSessionEvent('b', 'turn/started', { turnId: 't2' });
    q.sendMessage({ jsonrpc: '2.0', id: 1, result: {} });
    q.sendDelta('a', 'item/agentMessage/delta', 'm#0', { turnId: 't1', itemId: 'm#0' }, 'x');
    q.sendSessionEvent('a', 'turn/completed', { turnId: 't1', status: 'completed' });
    const a = sink.frames.filter((f) => params(f).sessionId === 'a');
    expect(a.map((f) => params(f).seq)).toEqual([1, 2, 3]);
    expect(a.map((f) => f.method)).toEqual([
      'turn/started',
      'item/agentMessage/delta',
      'turn/completed',
    ]);
    expect(
      sink.frames.filter((f) => params(f).sessionId === 'b').map((f) => params(f).seq),
    ).toEqual([1]);
    expect(sink.frames[2]).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('merges waiting deltas of one item while the reader is slow and loses no text', async () => {
    const sink = new FakeSink();
    const { q } = queue(sink);
    q.sendSessionEvent('s', 'item/started', { turnId: 't', item: { itemId: 'm#0' } });
    sink.blocked = true;
    q.sendDelta('s', 'item/agentMessage/delta', 'm#0', { turnId: 't', itemId: 'm#0' }, 'first ');
    const deltas = Array.from({ length: 10_000 }, (_, i) => `d${String(i)} `);
    for (const delta of deltas) {
      q.sendDelta('s', 'item/agentMessage/delta', 'm#0', { turnId: 't', itemId: 'm#0' }, delta);
    }
    q.sendSessionEvent('s', 'item/completed', { turnId: 't' });
    expect(q.stats().queuedFrames).toBe(2);
    const waiting = q.stats().queuedBytes;
    expect(waiting).toBeLessThan(deltas.join('').length + 1_000);
    sink.drain();
    await q.flushed();
    const text = sink.frames
      .filter((f) => f.method === 'item/agentMessage/delta')
      .map((f) => params(f).delta)
      .join('');
    expect(text).toBe(`first ${deltas.join('')}`);
    expect(sink.frames.map((f) => params(f).seq)).toEqual([1, 2, 3, 4]);
    expect(q.stats()).toMatchObject({ queuedFrames: 0, queuedBytes: 0 });
    expect(q.stats().peakBytes).toBe(waiting);
  });

  it('starts a new frame for a delta whose predecessor was already written', () => {
    const sink = new FakeSink();
    const { q } = queue(sink);
    q.sendDelta('s', 'item/agentMessage/delta', 'm#0', { itemId: 'm#0' }, 'one');
    q.sendDelta('s', 'item/agentMessage/delta', 'm#0', { itemId: 'm#0' }, 'two');
    expect(sink.frames.map((f) => params(f).delta)).toEqual(['one', 'two']);
  });

  it('does not merge across another event of the same session or another item', () => {
    const sink = new FakeSink();
    const { q } = queue(sink);
    sink.blocked = true;
    q.sendSessionEvent('s', 'turn/started', { turnId: 't' });
    q.sendDelta('s', 'item/agentMessage/delta', 'm#0', { itemId: 'm#0' }, 'a');
    q.sendDelta('s', 'item/agentMessage/delta', 'm#1', { itemId: 'm#1' }, 'b');
    q.sendSessionEvent('s', 'item/completed', { itemId: 'm#1' });
    q.sendDelta('s', 'item/agentMessage/delta', 'm#1', { itemId: 'm#1' }, 'c');
    q.sendDelta('other', 'item/agentMessage/delta', 'm#1', { itemId: 'm#1' }, 'd');
    q.sendDelta('s', 'item/agentMessage/delta', 'm#1', { itemId: 'm#1' }, 'e');
    sink.drain();
    expect(
      sink.frames.map(
        (f) => `${String(params(f).sessionId)}:${String(params(f).delta ?? f.method)}`,
      ),
    ).toEqual(['s:turn/started', 's:a', 's:b', 's:item/completed', 's:ce', 'other:d']);
  });

  it('continues numbering after the last seq Core saw', () => {
    const sink = new FakeSink();
    const { q } = queue(sink);
    q.continueSeq('s', 41);
    q.sendSessionEvent('s', 'turn/started', { turnId: 't' });
    q.continueSeq('s', 7);
    q.sendSessionEvent('s', 'turn/completed', { turnId: 't' });
    expect(sink.frames.map((f) => params(f).seq)).toEqual([42, 43]);
  });

  it('reports an overflow once when waiting frames exceed the ceiling', () => {
    const sink = new FakeSink();
    const { q, overflows } = queue(sink, 4_096);
    sink.blocked = true;
    q.sendMessage({ jsonrpc: '2.0', method: 'log', params: { line: 'first' } });
    for (let i = 0; i < 100; i += 1) {
      q.sendSessionEvent('s', 'item/started', {
        turnId: 't',
        item: { itemId: `i${String(i)}`, text: 'x'.repeat(100) },
      });
    }
    expect(overflows).toHaveLength(1);
    expect(overflows[0]?.queuedBytes).toBeGreaterThan(4_096);
  });

  it('resolves flushed() only after the sink drained', async () => {
    const sink = new FakeSink();
    const { q } = queue(sink);
    sink.blocked = true;
    q.sendMessage({ jsonrpc: '2.0', id: 1, result: {} });
    q.sendMessage({ jsonrpc: '2.0', id: 2, result: {} });
    let flushed = false;
    const done = q.flushed().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    expect(sink.frames).toHaveLength(1);
    sink.drain();
    await done;
    expect(sink.frames).toHaveLength(2);
  });
});
