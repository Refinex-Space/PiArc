import { afterEach, describe, expect, it, vi } from 'vitest';

import { CoreBridge } from '../runtime/core-bridge.js';
import { refusal } from './policy.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('permission preflight', () => {
  it('times out if Core never answers and rejects a late pending notification and response', async () => {
    vi.useFakeTimers();
    const bridge = new CoreBridge(() => undefined, { defaultTimeoutMs: 100 });
    const wait = refusal(bridge, 's', '/project', {
      tool: 'Bash',
      toolCallId: 'c',
      input: { command: 'npm test' },
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(wait).resolves.toContain('no response within 100 ms');
    expect(bridge.awaitingApproval('s', 'c')).toBe(false);
    expect(bridge.handleResponse({ jsonrpc: '2.0', id: 1, result: { allowed: true } })).toBe(false);
  });

  it('waits without a fixed limit only for the approval Core actually opened', async () => {
    vi.useFakeTimers();
    const bridge = new CoreBridge(() => undefined, { defaultTimeoutMs: 100 });
    const wait = refusal(bridge, 's', '/project', {
      tool: 'Write',
      toolCallId: 'c',
      input: { path: '@main.ts', content: 'ok' },
    });
    expect(bridge.awaitingApproval('other', 'c')).toBe(false);
    expect(bridge.awaitingApproval('s', 'other')).toBe(false);
    expect(bridge.awaitingApproval('s', 'c')).toBe(true);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(bridge.pendingCount).toBe(1);
    bridge.handleResponse({
      jsonrpc: '2.0',
      id: 1,
      result: { allowed: false, reason: 'Please use the test fixture.' },
    });
    await expect(wait).resolves.toBe('Please use the test fixture.');
  });
});
