import { describe, expect, it } from 'vitest';

import {
  CdpProxy,
  type PageDebugger,
  type ProxySpace,
  type ProxyTab,
  type TabChange,
} from './cdp-proxy.js';

type Listener = (event: unknown, method: string, params: unknown, sessionId: string) => void;

class FakeDebugger implements PageDebugger {
  readonly sent: { method: string; params?: object; sessionId?: string }[] = [];
  readonly listeners = new Set<Listener>();
  sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown> {
    this.sent.push({
      method,
      ...(params === undefined ? {} : { params }),
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    return Promise.resolve({ echoed: method });
  }
  on(_event: 'message', listener: Listener): void {
    this.listeners.add(listener);
  }
  removeListener(_event: 'message', listener: Listener): void {
    this.listeners.delete(listener);
  }
  fire(method: string, params: unknown, sessionId = ''): void {
    for (const listener of this.listeners) listener({}, method, params, sessionId);
  }
}

function fixture() {
  const tabs: ProxyTab[] = [{ targetId: 'T1', url: 'http://localhost:5173/', title: 'App' }];
  const debuggers = new Map<string, FakeDebugger>([['T1', new FakeDebugger()]]);
  const watchers = new Set<(change: TabChange) => void>();
  const refused: string[] = [];
  const tainted: string[] = [];
  const out: Record<string, unknown>[] = [];
  const space: ProxySpace = {
    tabs: () => tabs,
    debuggerOf: (id) => {
      const found = debuggers.get(id);
      return found === undefined ? Promise.reject(new Error('gone')) : Promise.resolve(found);
    },
    createTab: (url) => {
      const tab = { targetId: `T${String(tabs.length + 1)}`, url, title: '' };
      tabs.push(tab);
      debuggers.set(tab.targetId, new FakeDebugger());
      for (const watch of watchers) watch({ kind: 'created', tab });
      return Promise.resolve(tab);
    },
    closeTab: (id) => {
      const index = tabs.findIndex((t) => t.targetId === id);
      if (index < 0) return Promise.resolve(false);
      tabs.splice(index, 1);
      for (const watch of watchers) watch({ kind: 'destroyed', targetId: id });
      return Promise.resolve(true);
    },
    activate: () => undefined,
    watch: (listener) => {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
    stagedFile: () => false,
    refused: (method) => refused.push(method),
    tainted: (targetId) => tainted.push(targetId),
  };
  const proxy = new CdpProxy(space, (m) => out.push(JSON.parse(m) as Record<string, unknown>), {
    protocolVersion: '1.3',
    product: 'Chrome/140',
  });
  const call = async (message: object) => {
    await proxy.handle(JSON.stringify(message));
    return out.at(-1);
  };
  return { proxy, out, call, refused, tainted, debuggers, tabs };
}

describe('CdpProxy', () => {
  it('lists only the Space tabs and attaches with a virtual session', async () => {
    const f = fixture();
    const targets = await f.call({ id: 1, method: 'Target.getTargets' });
    expect(targets).toMatchObject({
      id: 1,
      result: { targetInfos: [{ targetId: 'T1', type: 'page', attached: false }] },
    });
    const attach = await f.call({
      id: 2,
      method: 'Target.attachToTarget',
      params: { targetId: 'T1', flatten: true },
    });
    const sessionId = (attach?.result as { sessionId: string }).sessionId;
    expect(sessionId).toMatch(/^PIARC/);
    const evaluated = await f.call({
      id: 3,
      method: 'Runtime.evaluate',
      params: { expression: '1' },
      sessionId,
    });
    expect(evaluated).toEqual({ id: 3, result: { echoed: 'Runtime.evaluate' }, sessionId });
    expect(f.debuggers.get('T1')?.sent).toEqual([
      { method: 'Runtime.evaluate', params: { expression: '1' } },
    ]);
    // Script ran in the page: the user hears it on takeover (B2.5.4).
    expect(f.tainted).toEqual(['T1']);
  });

  it('refuses methods outside the policy and records them', async () => {
    const f = fixture();
    const attach = await f.call({
      id: 1,
      method: 'Target.attachToTarget',
      params: { targetId: 'T1' },
    });
    const sessionId = (attach?.result as { sessionId: string }).sessionId;
    const cookies = await f.call({ id: 2, method: 'Network.getAllCookies', sessionId });
    expect(cookies).toMatchObject({ id: 2, error: { code: -32000 }, sessionId });
    expect((cookies?.error as { message: string }).message).toContain('PIARC_CDP_METHOD_REFUSED');
    const browser = await f.call({ id: 3, method: 'Browser.setDownloadBehavior', params: {} });
    expect(browser).toMatchObject({ id: 3, error: { code: -32000 } });
    expect(f.refused).toEqual(['Network.getAllCookies', 'Browser.setDownloadBehavior']);
    expect(f.debuggers.get('T1')?.sent).toEqual([]);
  });

  it('answers unknown targets and sessions as Chromium does', async () => {
    const f = fixture();
    expect(
      await f.call({ id: 1, method: 'Target.attachToTarget', params: { targetId: 'other' } }),
    ).toMatchObject({
      error: { message: 'No target with given id found' },
    });
    expect(await f.call({ id: 2, method: 'Page.enable', sessionId: 'forged' })).toMatchObject({
      error: { code: -32001 },
    });
  });

  it('forwards page events and maps frame sessions to virtual ids', async () => {
    const f = fixture();
    const attach = await f.call({
      id: 1,
      method: 'Target.attachToTarget',
      params: { targetId: 'T1' },
    });
    const page = (attach?.result as { sessionId: string }).sessionId;
    const auto = await f.call({
      id: 2,
      method: 'Target.setAutoAttach',
      params: { autoAttach: true },
      sessionId: page,
    });
    expect(auto).toMatchObject({ id: 2 });
    expect(f.debuggers.get('T1')?.sent.at(-1)).toEqual({
      method: 'Target.setAutoAttach',
      params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: false },
    });
    const debug = f.debuggers.get('T1');
    debug?.fire('Page.loadEventFired', { timestamp: 1 });
    expect(f.out.at(-1)).toEqual({
      method: 'Page.loadEventFired',
      params: { timestamp: 1 },
      sessionId: page,
    });
    debug?.fire('Target.attachedToTarget', { sessionId: 'CHILD', targetInfo: { type: 'iframe' } });
    const announced = f.out.at(-1) as { params: { sessionId: string }; sessionId: string };
    expect(announced.sessionId).toBe(page);
    const frame = announced.params.sessionId;
    expect(frame).not.toBe('CHILD');
    await f.call({ id: 3, method: 'DOM.getDocument', sessionId: frame });
    expect(debug?.sent.at(-1)).toEqual({ method: 'DOM.getDocument', sessionId: 'CHILD' });
    debug?.fire('Runtime.executionContextCreated', { context: { id: 9 } }, 'CHILD');
    expect(f.out.at(-1)).toMatchObject({
      method: 'Runtime.executionContextCreated',
      sessionId: frame,
    });
  });

  it('creates, discovers and closes tabs of the Space', async () => {
    const f = fixture();
    await f.call({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } });
    expect(f.out[0]).toMatchObject({
      method: 'Target.targetCreated',
      params: { targetInfo: { targetId: 'T1' } },
    });
    const created = await f.call({
      id: 2,
      method: 'Target.createTarget',
      params: { url: 'https://example.com/' },
    });
    expect(created).toEqual({ id: 2, result: { targetId: 'T2' } });
    expect(
      f.out.some((m) => m.method === 'Target.targetCreated' && JSON.stringify(m).includes('T2')),
    ).toBe(true);
    const closed = await f.call({
      id: 3,
      method: 'Target.closeTarget',
      params: { targetId: 'T2' },
    });
    expect(closed).toEqual({ id: 3, result: { success: true } });
    expect(f.out.some((m) => m.method === 'Target.targetDestroyed')).toBe(true);
  });

  it('stops sending after dispose', async () => {
    const f = fixture();
    await f.call({ id: 1, method: 'Target.attachToTarget', params: { targetId: 'T1' } });
    const count = f.out.length;
    f.proxy.dispose();
    f.debuggers.get('T1')?.fire('Page.loadEventFired', {});
    expect(f.out.length).toBe(count);
    expect(f.debuggers.get('T1')?.listeners.size).toBe(0);
  });
});
