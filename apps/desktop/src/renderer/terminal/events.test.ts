// W3: a refused subscription to a terminal's route is retried while the terminal is followed
// (a session terminal is in Core's task list before Core can answer for it).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { onTerminalEvents, SUBSCRIBE_RETRY_MS } from './events.js';

type Callback = (batch: { payload: Uint8Array }) => void;

function stubPiarc(refusals: number) {
  const calls: string[] = [];
  let callback: Callback | undefined;
  const api = {
    subscribeEvents: (route: string, cb: Callback) => {
      calls.push(route);
      if (calls.length <= refusals) {
        return Promise.reject(new Error(`This page is not allowed to observe ${route}`));
      }
      callback = cb;
      return Promise.resolve();
    },
    unsubscribeEvents: () => Promise.resolve(),
  };
  vi.stubGlobal('window', { piarc: api });
  return { calls, emit: (events: unknown) => callback?.({ payload: encode(events) }) };
}

function encode(events: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(events));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('onTerminalEvents', () => {
  it('retries a refused subscription and then delivers', async () => {
    vi.useFakeTimers();
    const piarc = stubPiarc(2);
    const seen: string[] = [];
    const stop = onTerminalEvents(7, (event) => seen.push(event.type));
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MS * 3);
    expect(piarc.calls).toEqual(['term/7', 'term/7', 'term/7']);
    piarc.emit([{ type: 'output' }]);
    expect(seen).toEqual(['output']);
    stop();
  });

  it('stops retrying once nobody follows the terminal', async () => {
    vi.useFakeTimers();
    const piarc = stubPiarc(100);
    const stop = onTerminalEvents(8, () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(SUBSCRIBE_RETRY_MS * 10);
    expect(piarc.calls).toEqual(['term/8']);
  });
});
