// T13-A11: the Agent Host treats `trust/get` as untrusted on a timeout, an error from Core and
// a result it cannot parse; and the takeover hook answers Pi's resource loader with it.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CoreBridge } from '../runtime/core-bridge.js';
import { askCoreTrust, takeOverProjectTrust } from './project-trust.js';

interface Sent {
  id: number;
  method: string;
  params: unknown;
}

function setup(timeoutMs = 1000): { bridge: CoreBridge; sent: Sent[]; logs: string[] } {
  const sent: Sent[] = [];
  const bridge = new CoreBridge((message) => sent.push(message as Sent), {
    defaultTimeoutMs: timeoutMs,
  });
  return { bridge, sent, logs: [] };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('askCoreTrust', () => {
  it('is trusted only for a well-formed positive answer', async () => {
    const { bridge, sent, logs } = setup();
    const asked = askCoreTrust(bridge, '/work/项目 a', (line) => logs.push(line));
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'trust/get', params: { path: '/work/项目 a' } },
    ]);
    bridge.handleResponse({ jsonrpc: '2.0', id: 1, result: { trusted: true } });
    await expect(asked).resolves.toBe(true);
    expect(logs).toEqual([]);

    const denied = askCoreTrust(bridge, '/w', (line) => logs.push(line));
    bridge.handleResponse({ jsonrpc: '2.0', id: 2, result: { trusted: false } });
    await expect(denied).resolves.toBe(false);
  });

  it('is untrusted when Core does not answer in time', async () => {
    vi.useFakeTimers();
    const { bridge, logs } = setup(30_000);
    const asked = askCoreTrust(bridge, '/w', (line) => logs.push(line));
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(asked).resolves.toBe(false);
    expect(logs[0]).toContain('treating it as untrusted');
    expect(logs[0]).toContain('no response within 30000 ms');
  });

  it('is untrusted when Core answers with an error', async () => {
    const { bridge, logs } = setup();
    const asked = askCoreTrust(bridge, '/w', (line) => logs.push(line));
    bridge.handleResponse({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32603,
        message: 'database locked',
        data: { kind: 'internalError', retryable: false },
      },
    });
    await expect(asked).resolves.toBe(false);
    expect(logs[0]).toContain('database locked');
  });

  it.each([
    ['a string instead of a boolean', { trusted: 'yes' }],
    ['a missing field', {}],
    ['null', null],
    ['a list', [true]],
    ['a number', 1],
  ])('is untrusted when the result is %s', async (_name, result) => {
    const { bridge, logs } = setup();
    const asked = askCoreTrust(bridge, '/w', (line) => logs.push(line));
    bridge.handleResponse({ jsonrpc: '2.0', id: 1, result });
    await expect(asked).resolves.toBe(false);
    expect(logs).toHaveLength(1);
  });

  it('is untrusted when the connection to Core is gone', async () => {
    const { bridge, logs } = setup();
    const asked = askCoreTrust(bridge, '/w', (line) => logs.push(line));
    bridge.close('stdin closed');
    await expect(asked).resolves.toBe(false);
    await expect(askCoreTrust(bridge, '/w', (line) => logs.push(line))).resolves.toBe(false);
    expect(logs).toHaveLength(2);
  });
});

describe('takeOverProjectTrust', () => {
  it('answers the resource loader with the decision and records it', async () => {
    const asked: string[] = [];
    const takeover = takeOverProjectTrust('/w', (cwd) => {
      asked.push(cwd);
      return Promise.resolve(true);
    });
    expect(takeover.trusted()).toBe(false);
    const resolve = takeover.reloadOptions.resolveProjectTrust;
    expect(resolve).toBeDefined();
    await expect(
      resolve?.({ extensionsResult: { extensions: [], errors: [] } } as never),
    ).resolves.toBe(true);
    expect(takeover.trusted()).toBe(true);
    expect(asked).toEqual(['/w']);
  });

  it('is untrusted when the question itself throws', async () => {
    const takeover = takeOverProjectTrust('/w', () => Promise.reject(new Error('bug')));
    await expect(
      takeover.reloadOptions.resolveProjectTrust?.({
        extensionsResult: { extensions: [], errors: [] },
      } as never),
    ).resolves.toBe(false);
    expect(takeover.trusted()).toBe(false);
  });
});
