// Ported from ego-browser package/ego-browser/src/driver/page-waits.test.mjs (ego-lite commit
// 56589ea8, MIT, see LICENSE). PiArc: Vitest; typed services built with fakeCdp, a RefMap instead
// of a bare Map.

import { expect, test } from 'vitest';

import { fakeCdp } from '../../testing.js';
import type { CdpObject } from '../cdp-types.js';
import { RefMap } from '../ref-map.js';
import { waitForLoadStateInPage, waitForSelectorInPage, waitForURLInPage } from './page-waits.js';

type WaitServices = Parameters<typeof waitForSelectorInPage>[0];

interface ServiceParts {
  cdp?: (
    method: string,
    params: CdpObject,
    sessionId: string | undefined,
    timeoutMs: number | undefined,
  ) => unknown;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pageNetworkSessions?: WaitServices['pageNetworkSessions'];
  ensureNetworkTracking?: WaitServices['ensureNetworkTracking'];
  networkActivity?: WaitServices['networkActivity'];
}

function waitServices(parts: ServiceParts): WaitServices {
  const unexpected = (name: string) => () => {
    throw new Error(`unexpected service call: ${name}`);
  };
  const cdp = parts.cdp;
  return {
    cdp: fakeCdp(
      cdp ??
        ((method) => {
          throw new Error(`unexpected CDP method: ${method}`);
        }),
    ),
    now: parts.now,
    sleep: parts.sleep,
    pageNetworkSessions: parts.pageNetworkSessions ?? unexpected('pageNetworkSessions'),
    ensureNetworkTracking: parts.ensureNetworkTracking ?? unexpected('ensureNetworkTracking'),
    networkActivity: parts.networkActivity ?? unexpected('networkActivity'),
  };
}

function timeoutError(message: string): Error {
  return Object.assign(new Error(message), { code: 'EGO_CDP_REQUEST_TIMEOUT' });
}

test('waitForSelectorInPage refreshes iframe sessions while it polls', async () => {
  let now = 0;
  let discoveries = 0;
  const services = waitServices({
    cdp(method, _params, sessionId) {
      if (method === 'Runtime.evaluate') {
        return sessionId === 'session:frame-current'
          ? { result: { objectId: 'object:ready' } }
          : { result: { type: 'undefined' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: true } };
      }
      if (method === 'Runtime.releaseObject') return {};
      throw new Error(`unexpected CDP method: ${method}`);
    },
    now: () => now,
    sleep(ms) {
      now += ms;
      return Promise.resolve();
    },
  });
  const getIframeSessions = () => {
    discoveries += 1;
    return Promise.resolve(
      discoveries === 1
        ? new Map<string, string>()
        : new Map([['frame-current', 'session:frame-current']]),
    );
  };

  expect(
    await waitForSelectorInPage(
      services,
      'session:page',
      new RefMap(),
      '#ready',
      { state: 'visible', timeout: 2_000 },
      getIframeSessions,
    ),
  ).toBe(true);
  expect(discoveries).toBe(2);
});

test('waitForSelectorInPage retries when a discovered iframe disappears during resolution', async () => {
  let now = 0;
  let discoveries = 0;
  const services = waitServices({
    cdp(method, _params, sessionId) {
      if (method === 'Runtime.evaluate' && sessionId === 'session:frame-stale') {
        throw new Error('Frame with the given frameId is not found.');
      }
      if (method === 'Runtime.evaluate') {
        return sessionId === 'session:frame-current'
          ? { result: { objectId: 'object:ready' } }
          : { result: { type: 'undefined' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: true } };
      }
      if (method === 'Runtime.releaseObject') return {};
      throw new Error(`unexpected CDP method: ${method}`);
    },
    now: () => now,
    sleep(ms) {
      now += ms;
      return Promise.resolve();
    },
  });
  const getIframeSessions = () => {
    discoveries += 1;
    return Promise.resolve(
      discoveries === 1
        ? new Map([['frame-stale', 'session:frame-stale']])
        : new Map([['frame-current', 'session:frame-current']]),
    );
  };

  expect(
    await waitForSelectorInPage(
      services,
      'session:page',
      new RefMap(),
      '#ready',
      { state: 'visible', timeout: 500 },
      getIframeSessions,
    ),
  ).toBe(true);
  expect(discoveries).toBe(2);
});

test('waitForSelectorInPage rethrows a lost page session instead of reporting hidden', async () => {
  let now = 0;
  const services = waitServices({
    cdp() {
      throw new Error('Target closed');
    },
    now: () => now,
    sleep(ms) {
      now += ms;
      return Promise.resolve();
    },
  });

  await expect(
    waitForSelectorInPage(
      services,
      'session:page',
      new RefMap(),
      '#spinner',
      { state: 'hidden', timeout: 500 },
      () => Promise.resolve(new Map<string, string>()),
    ),
  ).rejects.toThrow(/Target closed/);
});

for (const [state, interruptedMethod] of [
  ['visible', 'Runtime.evaluate'],
  ['hidden', 'Runtime.callFunctionOn'],
] as const) {
  test(`waitForSelectorInPage retries context changes before reporting ${state}`, async () => {
    let now = 0;
    let discoveries = 0;
    let interrupted = false;
    let visibilityChecks = 0;
    const services = waitServices({
      cdp(method) {
        if (method === interruptedMethod && !interrupted) {
          interrupted = true;
          throw new Error('Cannot find context with specified id');
        }
        if (method === 'Runtime.evaluate') {
          return { result: { objectId: 'object:ready' } };
        }
        if (method === 'Runtime.callFunctionOn') {
          visibilityChecks += 1;
          return { result: { value: state === 'visible' } };
        }
        if (method === 'Runtime.releaseObject') return {};
        throw new Error(`unexpected CDP method: ${method}`);
      },
      now: () => now,
      sleep(ms) {
        now += ms;
        return Promise.resolve();
      },
    });

    expect(
      await waitForSelectorInPage(
        services,
        'session:page',
        new RefMap(),
        '#ready',
        { state, timeout: 500 },
        () => {
          discoveries += 1;
          return Promise.resolve(new Map<string, string>());
        },
      ),
    ).toBe(true);
    expect(discoveries, 'a context change refreshes frame sessions').toBe(2);
    expect(visibilityChecks, 'the wait verifies the requested state').toBe(1);
  });
}

test('waitForSelectorInPage bounds repeated context changes by its timeout', async () => {
  let now = 0;
  let attempts = 0;
  const services = waitServices({
    cdp() {
      attempts += 1;
      throw new Error('Cannot find context with specified id');
    },
    now: () => now,
    sleep(ms) {
      now += ms;
      return Promise.resolve();
    },
  });

  await expect(
    waitForSelectorInPage(
      services,
      'session:page',
      new RefMap(),
      '#ready',
      { state: 'visible', timeout: 500 },
      () => Promise.resolve(new Map<string, string>()),
    ),
  ).rejects.toThrow(/page\.waitForSelector timed out after 500ms: #ready/);
  expect(attempts).toBeGreaterThan(1);
  expect(now).toBe(500);
});

test('waitForSelectorInPage reports its own timeout at the deadline', async () => {
  let now = 0;
  const discoveryTimeouts: number[] = [];
  const services = waitServices({
    cdp(method) {
      if (method === 'Runtime.evaluate') return { result: { type: 'undefined' } };
      throw new Error(`unexpected CDP method: ${method}`);
    },
    now: () => now,
    sleep(ms) {
      now += ms;
      return Promise.resolve();
    },
  });
  const getIframeSessions = (timeoutMs: number) => {
    discoveryTimeouts.push(timeoutMs);
    if (timeoutMs < 250) {
      return Promise.reject(timeoutError('CDP request timed out: Target.getTargets'));
    }
    return Promise.resolve(new Map<string, string>());
  };

  await expect(
    waitForSelectorInPage(
      services,
      'session:page',
      new RefMap(),
      '#missing',
      { state: 'visible', timeout: 500 },
      getIframeSessions,
    ),
  ).rejects.toThrow(/page\.waitForSelector timed out after 500ms: #missing/);
  expect(
    discoveryTimeouts.every((timeoutMs) => timeoutMs <= 500),
    `frame discovery must never exceed the public timeout: ${discoveryTimeouts.join(',')}`,
  ).toBe(true);
});

test('waitForSelectorInPage throttles iframe discovery while polling', async () => {
  let now = 0;
  let discoveries = 0;
  const services = waitServices({
    cdp(method) {
      if (method === 'Runtime.evaluate') return { result: { type: 'undefined' } };
      throw new Error(`unexpected CDP method: ${method}`);
    },
    now: () => now,
    sleep(ms) {
      now += ms;
      return Promise.resolve();
    },
  });

  await expect(
    waitForSelectorInPage(
      services,
      'session:page',
      new RefMap(),
      '#missing',
      { state: 'visible', timeout: 2_000 },
      () => {
        discoveries += 1;
        return Promise.resolve(new Map<string, string>());
      },
    ),
  ).rejects.toThrow(/timed out/);
  expect(
    discoveries,
    `expected at most one discovery per 500ms over 2s, got ${String(discoveries)}`,
  ).toBeLessThanOrEqual(5);
});

test('waitForURLInPage recovers from a transient execution-context change', async () => {
  let now = 0;
  let attempt = 0;
  const calls: [string, CdpObject, string | undefined, number | undefined][] = [];
  const services = waitServices({
    cdp(method, params, sessionId, timeoutMs) {
      calls.push([method, params, sessionId, timeoutMs]);
      attempt += 1;
      if (attempt === 1) {
        throw new Error('Execution context was destroyed');
      }
      return {
        result: {
          value: attempt === 2 ? 'https://example.test/loading' : 'https://example.test/ready',
        },
      };
    },
    now: () => now,
    sleep(ms) {
      now += ms;
      return Promise.resolve();
    },
  });

  await waitForURLInPage(services, 'session:page', /\/ready$/g, {
    timeout: 500,
  });

  expect(attempt).toBe(3);
  expect(
    calls.every(
      ([method, , sessionId, timeoutMs]) =>
        method === 'Runtime.evaluate' &&
        sessionId === 'session:page' &&
        timeoutMs !== undefined &&
        timeoutMs > 0 &&
        timeoutMs <= 500,
    ),
  ).toBe(true);
});

test('waitForURLInPage supports Playwright-style URL globs', async () => {
  let now = 0;
  let attempt = 0;
  const services = waitServices({
    cdp() {
      attempt += 1;
      return {
        result: {
          value:
            attempt === 1
              ? 'https://example.test/releases/draft/nested/item?channel=canary'
              : 'https://example.test/releases/ready/item?channel=stable',
        },
      };
    },
    now: () => now,
    sleep(ms) {
      now += ms;
      return Promise.resolve();
    },
  });

  await waitForURLInPage(services, 'session:page', '**/releases/{draft,ready}/*?channel=*', {
    timeout: 500,
  });

  expect(attempt, 'a single star must not cross a path separator').toBe(2);
});

test('waitForURLInPage passes a URL object to a synchronous predicate', async () => {
  let now = 0;
  let attempt = 0;
  const seen: string[] = [];
  const services = waitServices({
    cdp() {
      attempt += 1;
      return {
        result: {
          value: `https://example.test/jobs?id=${attempt === 1 ? '41' : '42'}`,
        },
      };
    },
    now: () => now,
    sleep(ms) {
      now += ms;
      return Promise.resolve();
    },
  });

  await waitForURLInPage(
    services,
    'session:page',
    (url) => {
      expect(url).toBeInstanceOf(URL);
      seen.push(url.href);
      return url.searchParams.get('id') === '42';
    },
    { timeout: 500 },
  );

  expect(seen).toEqual(['https://example.test/jobs?id=41', 'https://example.test/jobs?id=42']);
});

test('document load waits do not sleep past the budget after a slow probe', async () => {
  let now = 0;
  let calls = 0;
  const services = waitServices({
    cdp(_method, _params, _sessionId, timeoutMs) {
      calls += 1;
      if (calls === 1) {
        expect(timeoutMs).toBe(100);
        now = 99;
      } else {
        expect(timeoutMs).toBe(1);
      }
      return { result: { value: 'loading' } };
    },
    now: () => now,
    sleep(ms) {
      now += ms;
      return Promise.resolve();
    },
  });

  await expect(
    waitForLoadStateInPage(services, 'session:page', 'load', {
      timeout: 100,
    }),
  ).rejects.toThrow(/page\.waitForLoadState\(load\) timed out after 100ms/);

  expect(now).toBe(100);
});

test('network-idle discovery stays within the Page wait timeout', async () => {
  let discoveryTimeout: number | undefined;
  const services = waitServices({
    pageNetworkSessions(sessionId, timeoutMs) {
      expect(sessionId).toBe('session:page');
      discoveryTimeout = timeoutMs;
      return Promise.resolve([sessionId]);
    },
    ensureNetworkTracking: () => Promise.resolve(),
    networkActivity() {
      return { tracking: true, inflight: 0, lastActivityAt: -1_000 };
    },
    now: () => 0,
    sleep: () => Promise.resolve(),
  });

  await waitForLoadStateInPage(services, 'session:page', 'networkidle', {
    timeout: 123,
    idleMs: 10,
  });

  expect(discoveryTimeout).toBe(123);
});

test('network-idle gives tracking only the budget left after discovery', async () => {
  let now = 0;
  let trackingTimeout: number | undefined;
  const services = waitServices({
    pageNetworkSessions(_sessionId, timeoutMs) {
      expect(timeoutMs).toBe(100);
      now = 90;
      return Promise.resolve(['session:page']);
    },
    ensureNetworkTracking(_sessionIds, timeoutMs) {
      trackingTimeout = timeoutMs;
      return Promise.resolve();
    },
    networkActivity() {
      return { tracking: true, inflight: 0, lastActivityAt: -1_000 };
    },
    now: () => now,
    sleep: () => Promise.resolve(),
  });

  await waitForLoadStateInPage(services, 'session:page', 'networkidle', {
    timeout: 100,
    idleMs: 10,
  });

  expect(trackingTimeout).toBe(10);
});

test('network-idle reports its public timeout when discovery exhausts the budget', async () => {
  let now = 0;
  const services = waitServices({
    pageNetworkSessions() {
      now = 50;
      return Promise.reject(timeoutError('CDP request timed out: Page.getFrameTree'));
    },
    ensureNetworkTracking: () => Promise.resolve(),
    networkActivity() {
      throw new Error('network activity must not be read after discovery fails');
    },
    now: () => now,
    sleep: () => Promise.resolve(),
  });

  await expect(
    waitForLoadStateInPage(services, 'session:page', 'networkidle', {
      timeout: 50,
      idleMs: 10,
    }),
  ).rejects.toThrow(/page\.waitForLoadState\(networkidle\) timed out after 50ms/);
});
