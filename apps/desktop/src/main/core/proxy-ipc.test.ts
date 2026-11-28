import { describe, expect, it, vi } from 'vitest';

import { proxyFromRules, SystemProxy } from './proxy-ipc.js';

describe('the system proxy (ADR-0082)', () => {
  it('takes the first proxy Node can use from Chromium’s answer', () => {
    expect(proxyFromRules('PROXY 127.0.0.1:7897; DIRECT')).toBe('http://127.0.0.1:7897');
    expect(proxyFromRules('HTTPS proxy.example.com:443')).toBe('https://proxy.example.com:443');
    expect(proxyFromRules('DIRECT')).toBeNull();
    expect(proxyFromRules('SOCKS5 127.0.0.1:1080; PROXY 10.0.0.2:3128')).toBe(
      'http://10.0.0.2:3128',
    );
    expect(proxyFromRules('SOCKS5 127.0.0.1:1080; DIRECT')).toBeNull();
    expect(proxyFromRules('')).toBeNull();
  });

  it('tells Core what it resolved, again on focus only after a while', async () => {
    const setSystemProxy = vi.fn();
    const resolveProxy = vi.fn().mockResolvedValue('PROXY 127.0.0.1:7897; DIRECT');
    let now = 1_000_000;
    const proxy = new SystemProxy({ setSystemProxy }, { resolveProxy }, () => now);
    await expect(proxy.detect()).resolves.toBe('http://127.0.0.1:7897');
    expect(setSystemProxy).toHaveBeenLastCalledWith('http://127.0.0.1:7897');
    proxy.focused();
    expect(resolveProxy).toHaveBeenCalledTimes(1);
    now += 31_000;
    resolveProxy.mockResolvedValue('DIRECT');
    proxy.focused();
    await vi.waitFor(() => {
      expect(setSystemProxy).toHaveBeenLastCalledWith(null);
    });
  });
});
