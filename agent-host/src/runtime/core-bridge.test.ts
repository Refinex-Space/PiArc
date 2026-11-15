import { afterEach, describe, expect, it, vi } from 'vitest';

import { AhpError } from '../protocol/errors.js';
import { CoreBridge } from './core-bridge.js';

interface Sent {
  id: number;
  method: string;
  params: unknown;
}

function bridge(timeoutMs = 50): { bridge: CoreBridge; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    bridge: new CoreBridge((message) => sent.push(message as Sent), {
      defaultTimeoutMs: timeoutMs,
    }),
  };
}

async function failure(promise: Promise<unknown>): Promise<AhpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AhpError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the request to fail');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CoreBridge', () => {
  it('resolves with the result of the matching response', async () => {
    const { bridge: b, sent } = bridge();
    const pending = b.request('trust/get', { path: '/w' });
    expect(sent).toEqual([{ jsonrpc: '2.0', id: 1, method: 'trust/get', params: { path: '/w' } }]);
    expect(b.handleResponse({ jsonrpc: '2.0', id: 1, result: { trusted: true } })).toBe(true);
    await expect(pending).resolves.toEqual({ trusted: true });
    expect(b.pendingCount).toBe(0);
  });

  it('rejects with the kind of an error response', async () => {
    const { bridge: b } = bridge();
    const pending = b.request('host/hello', {});
    b.handleResponse({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32000,
        message: 'major mismatch',
        data: {
          kind: 'protocolVersionMismatch',
          retryable: false,
          details: { local: '1.0', remote: '2.0' },
        },
      },
    });
    const error = await failure(pending);
    expect(error.kind).toBe('protocolVersionMismatch');
    expect(error.details).toEqual({ local: '1.0', remote: '2.0' });
  });

  it('times out with a retryable timeout error', async () => {
    vi.useFakeTimers();
    const { bridge: b } = bridge(30_000);
    const pending = failure(b.request('trust/get', {}));
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await pending;
    expect(error.kind).toBe('timeout');
    expect(error.retryable).toBe(true);
    expect(b.handleResponse({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false);
  });

  it('waits without limit when timeoutMs is null, until the signal cancels it', async () => {
    vi.useFakeTimers();
    const { bridge: b } = bridge(10);
    const controller = new AbortController();
    const pending = failure(
      b.request('policy/evaluate', {}, { timeoutMs: null, signal: controller.signal }),
    );
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(b.pendingCount).toBe(1);
    controller.abort('turn interrupted');
    expect((await pending).kind).toBe('uncertain');
    expect(b.pendingCount).toBe(0);
  });

  it('fails waiting and later requests once the connection closed', async () => {
    const { bridge: b, sent } = bridge();
    const pending = failure(b.request('trust/get', {}));
    b.close('Core closed the connection');
    expect((await pending).kind).toBe('uncertain');
    expect((await failure(b.request('trust/get', {}))).kind).toBe('uncertain');
    expect(sent).toHaveLength(1);
  });

  it('rejects a malformed result of a typed request', async () => {
    const { bridge: b } = bridge();
    const pending = failure(
      b.requestTyped('trust/get', {}, (result) =>
        typeof result === 'object' && result !== null && 'trusted' in result ? result : undefined,
      ),
    );
    b.handleResponse({ jsonrpc: '2.0', id: 1, result: { trust: 'yes' } });
    expect((await pending).kind).toBe('invalidRequest');
  });
});
