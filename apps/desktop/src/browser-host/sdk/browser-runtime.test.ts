// Ported from ego-browser package/ego-browser/src/browser-runtime.test.mjs (ego-lite commit
// 56589ea8, MIT, see LICENSE). PiArc: Vitest; FakeBindings instead of hand-written ego objects;
// state.responseTimeoutMs instead of EGO_BROWSER_RESPONSE_TIMEOUT_MS. Dropped: the egoAutomated
// automation-hook test and assertions (no such domain, ADR-0091) and the legacy
// drainBrowserEvents assertion; the per-target event-queue test drains with drainPageEvents.

import { expect, test, vi } from 'vitest';

import { FakeBindings, installBindings, type CdpRequestMessage } from '../testing.js';
import {
  CdpRequestTimeoutError,
  PageDialogOpenedError,
  PageUnresponsiveError,
  browserCdp,
  drainPageEvents,
  ensureFrameSessions,
  ensureNetworkTracking,
  ensureSession,
  invalidateSession,
  networkActivity,
  pageNetworkSessions,
  prepareFileChooser,
  releaseRuntimeCallbacks,
  responseTimeoutMs,
  subscribeBrowserEvents,
  subscribePageEvents,
  type FileChooserInterception,
} from './browser-runtime.js';
import { isRecord, type CdpEvent, type CdpObject, type CdpResponse } from './cdp-types.js';
import type { EgoResult } from './ego-bindings.js';
import { setOverrides } from './state.js';

/** Answers one CDP command; it delivers replies itself (as upstream's hand-written runtimes). */
type Responder = (request: CdpRequestMessage, fake: FakeBindings) => void;

/** Bindings whose CDP answers come from `respond`, called synchronously inside the send. */
function scripted(respond: Responder): FakeBindings {
  const fake: FakeBindings = new FakeBindings({
    cdp: (request) => {
      respond(request, fake);
      return undefined;
    },
  });
  return fake;
}

/** Delivers one message synchronously (upstream: `runtime.onCDPMessage(JSON.stringify(…))`). */
function deliverNow(fake: FakeBindings, message: CdpObject): void {
  fake.onCDPMessage?.(JSON.stringify(message));
}

/** Delivers an event synchronously (upstream: `runtime.emit(sessionId, method, params)`). */
function emitNow(fake: FakeBindings, sessionId: string, method: string, params: CdpObject): void {
  deliverNow(fake, { sessionId, method, params });
}

/** The string `targetId` param of a command. */
function targetIdOf(request: CdpRequestMessage): string {
  const targetId = request.params.targetId;
  if (typeof targetId !== 'string') throw new TypeError(`${request.method} has no targetId`);
  return targetId;
}

/** The session id `Target.attachToTarget` answered. */
function attachedSession(response: CdpResponse<'Target.attachToTarget'>): string {
  const sessionId = response.result?.sessionId;
  if (typeof sessionId !== 'string') throw new TypeError('attachToTarget returned no sessionId');
  return sessionId;
}

/** Awaits `run` and answers what it rejected with; fails when it resolves. */
async function rejectionOf(run: Promise<unknown> | (() => Promise<unknown>)): Promise<Error> {
  try {
    await (typeof run === 'function' ? run() : run);
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error: ${String(error)}`, { cause: error });
  }
  throw new Error('expected a rejection');
}

function turn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Installs `fake`, runs `body`, then invalidates the session state and restores the bindings. */
async function withBindings(fake: FakeBindings, body: () => Promise<void>): Promise<void> {
  const restore = installBindings(fake);
  try {
    await body();
  } finally {
    invalidateSession();
    restore();
  }
}

function methodCount(sent: readonly CdpRequestMessage[], method: string, sessionId?: string) {
  return sent.filter(
    (request) =>
      request.method === method && (sessionId === undefined || request.sessionId === sessionId),
  ).length;
}

function eventMethods(events: readonly CdpEvent[]): string[] {
  return events.map((event) => event.method);
}

test('browserCdp exposes a typed transport timeout', async () => {
  await withBindings(new FakeBindings(), async () => {
    const error = await rejectionOf(() => browserCdp('Browser.getVersion', {}, undefined, 5));
    expect(error).toBeInstanceOf(CdpRequestTimeoutError);
    expect(error).toMatchObject({
      code: 'EGO_CDP_REQUEST_TIMEOUT',
      method: 'Browser.getVersion',
      timeoutMs: 5,
    });
    expect(error.message).toMatch(/CDP request timed out: Browser\.getVersion/);
  });
});

test('frame sessions follow one Page target and are invalidated with it', async () => {
  const attachCounts = new Map<string, number>();
  const fake = scripted((request, bindings) => {
    let result: CdpObject = {};
    if (request.method === 'Target.getTargets') {
      result = {
        targetInfos: [
          { targetId: 'page-main', type: 'page' },
          {
            targetId: 'frame-child',
            type: 'iframe',
            parentFrameId: 'same-process-frame',
          },
          {
            targetId: 'frame-grandchild',
            type: 'iframe',
            parentFrameId: 'same-process-inside-child',
          },
          {
            targetId: 'foreign-frame',
            type: 'iframe',
            parentFrameId: 'foreign-page',
          },
        ],
      };
    } else if (request.method === 'Page.getFrameTree') {
      result = {
        frameTree: {
          frame: { id: 'page-main' },
          childFrames: [
            {
              frame: { id: 'same-process-frame' },
              childFrames: [
                {
                  frame: { id: 'frame-child' },
                  childFrames: [
                    {
                      frame: { id: 'same-process-inside-child' },
                      childFrames: [{ frame: { id: 'frame-grandchild' } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      };
    } else if (request.method === 'Target.attachToTarget') {
      const targetId = targetIdOf(request);
      attachCounts.set(targetId, (attachCounts.get(targetId) ?? 0) + 1);
      result = { sessionId: `session:${targetId}` };
    }
    bindings.reply(request.id, result);
  });

  await withBindings(fake, async () => {
    const first = await ensureFrameSessions('page-main');
    expect([...first]).toEqual([
      ['same-process-frame', 'session:page-main'],
      ['frame-child', 'session:frame-child'],
      ['same-process-inside-child', 'session:frame-child'],
      ['frame-grandchild', 'session:frame-grandchild'],
    ]);
    expect(
      [...(first.parentFrameIds ?? [])],
      'frame sessions retain the ancestry needed to render an OOPIF cursor',
    ).toEqual([
      ['same-process-frame', 'page-main'],
      ['frame-child', 'same-process-frame'],
      ['same-process-inside-child', 'frame-child'],
      ['frame-grandchild', 'same-process-inside-child'],
    ]);
    expect(attachCounts.has('foreign-frame')).toBe(false);

    invalidateSession('page-main');
    const second = await ensureFrameSessions('page-main');
    expect([...second]).toEqual([...first]);
    expect(attachCounts.get('frame-child')).toBe(2);
    expect(attachCounts.get('frame-grandchild')).toBe(2);
  });
});

test('frame session discovery drops an enumerated iframe that disappears before attach', async () => {
  let discoveries = 0;
  let staleAttachAttempts = 0;
  const fake = scripted((request, bindings) => {
    let result: CdpObject = {};
    let error: string | undefined;
    if (request.method === 'Target.getTargets') {
      discoveries += 1;
      result = {
        targetInfos: [
          { targetId: 'page-main', type: 'page' },
          { targetId: 'frame-live', type: 'iframe', parentFrameId: 'page-main' },
          { targetId: 'frame-stale', type: 'iframe', parentFrameId: 'page-main' },
        ],
      };
    } else if (request.method === 'Page.getFrameTree') {
      result = {
        frameTree: {
          frame: { id: 'page-main' },
          childFrames: [{ frame: { id: 'frame-live' } }, { frame: { id: 'frame-stale' } }],
        },
      };
    } else if (request.method === 'Target.attachToTarget') {
      const targetId = targetIdOf(request);
      if (targetId === 'frame-stale') {
        staleAttachAttempts += 1;
        error = 'No target with given id found';
      } else {
        result = { sessionId: `session:${targetId}` };
      }
    }
    if (error === undefined) bindings.reply(request.id, result);
    else bindings.fail(request.id, error);
  });

  await withBindings(fake, async () => {
    invalidateSession();
    const sessions = await ensureFrameSessions('page-main', 1_000);
    expect([...sessions]).toEqual([['frame-live', 'session:frame-live']]);
    expect(discoveries, 'a vanished iframe must not restart discovery').toBe(1);
    expect(staleAttachAttempts).toBe(1);
  });
});

test('frame session discovery fails fast when the page target is gone', async () => {
  let attachAttempts = 0;
  const fake = scripted((request, bindings) => {
    if (request.method === 'Target.attachToTarget') {
      attachAttempts += 1;
      bindings.fail(request.id, 'No target with given id found');
      return;
    }
    bindings.reply(request.id, {});
  });

  await withBindings(fake, async () => {
    invalidateSession();
    const error = await rejectionOf(() => ensureFrameSessions('page-closed', 500));
    expect(error.message).toMatch(/No target with given id found/);
    expect(attachAttempts).toBe(1);
  });
});

test('frame session discovery fails fast when the page session is lost', async () => {
  let frameTreeAttempts = 0;
  const fake = scripted((request, bindings) => {
    let result: CdpObject = {};
    if (request.method === 'Target.getTargets') {
      result = { targetInfos: [{ targetId: 'page-main', type: 'page' }] };
    } else if (request.method === 'Page.getFrameTree') {
      frameTreeAttempts += 1;
      bindings.fail(request.id, 'Session with given id not found');
      return;
    } else if (request.method === 'Target.attachToTarget') {
      result = { sessionId: `session:${targetIdOf(request)}` };
    }
    bindings.reply(request.id, result);
  });

  await withBindings(fake, async () => {
    invalidateSession();
    const error = await rejectionOf(() => ensureFrameSessions('page-main', 500));
    expect(error.message).toMatch(/Session with given id not found/);
    expect(frameTreeAttempts).toBe(1);
  });
});

test('network tracking is continuous and does not consume Page events', async () => {
  const fake = scripted((request, bindings) => {
    bindings.reply(
      request.id,
      request.method === 'Target.attachToTarget' ? { sessionId: 'session:page-main' } : {},
    );
  });
  const networkEnables = () => methodCount(fake.sent, 'Network.enable');

  await withBindings(fake, async () => {
    const sessionId = await ensureSession('page-main');
    expect(sessionId).toBe('session:page-main');
    expect(networkEnables(), 'a Page session starts network tracking before it is returned').toBe(
      1,
    );

    emitNow(fake, sessionId, 'Network.requestWillBeSent', {
      requestId: 'favicon-without-terminal-event',
      request: { url: 'https://example.com/favicon.ico' },
    });
    expect(
      networkActivity([sessionId]).inflight,
      'favicon traffic must not keep a Page from reaching network idle',
    ).toBe(0);
    expect(
      eventMethods(drainPageEvents(sessionId)),
      'ignoring favicon activity for idle does not hide its public event',
    ).toEqual(['Network.requestWillBeSent']);

    emitNow(fake, sessionId, 'Network.requestWillBeSent', {
      requestId: 'favicon-without-terminal-event',
      redirectResponse: { status: 302 },
      request: { url: 'https://example.com/assets/icon.png' },
    });
    expect(
      networkActivity([sessionId]).inflight,
      'a redirected favicon stays excluded for its entire request chain',
    ).toBe(0);
    expect(
      eventMethods(drainPageEvents(sessionId)),
      'excluding a favicon redirect does not hide its public event',
    ).toEqual(['Network.requestWillBeSent']);

    emitNow(fake, sessionId, 'Network.loadingFinished', {
      requestId: 'favicon-without-terminal-event',
    });
    drainPageEvents(sessionId);
    emitNow(fake, sessionId, 'Network.requestWillBeSent', {
      requestId: 'favicon-without-terminal-event',
      request: { url: 'https://example.com/api/data' },
    });
    expect(
      networkActivity([sessionId]).inflight,
      'a favicon request id is released when a terminal event arrives',
    ).toBe(1);
    emitNow(fake, sessionId, 'Network.loadingFinished', {
      requestId: 'favicon-without-terminal-event',
    });
    drainPageEvents(sessionId);

    emitNow(fake, sessionId, 'Runtime.consoleAPICalled', { value: 'keep me' });
    emitNow(fake, sessionId, 'Network.requestWillBeSent', { requestId: 'slow-request' });

    expect(networkActivity([sessionId]).inflight).toEqual(1);
    await ensureNetworkTracking([sessionId]);
    expect(networkEnables(), 'ensuring an initialized tracker is idempotent').toBe(1);
    expect(
      eventMethods(drainPageEvents(sessionId)),
      'reading tracker state leaves the public Page event queue intact',
    ).toEqual(['Runtime.consoleAPICalled', 'Network.requestWillBeSent']);

    emitNow(fake, sessionId, 'Network.loadingFinished', { requestId: 'slow-request' });
    expect(networkActivity([sessionId]).inflight).toBe(0);

    await browserCdp('Network.disable', {}, sessionId);
    emitNow(fake, sessionId, 'Network.loadingFinished', { requestId: 'late-after-disable' });
    expect(
      networkActivity([sessionId]).tracking,
      'a late event after Network.disable must not resurrect tracking',
    ).toBe(false);
    await ensureNetworkTracking([sessionId]);
    expect(networkEnables(), 'the next sensitive operation must restore disabled tracking').toBe(2);
  });
});

test('Page network sessions include only its known OOPIF descendants', async () => {
  const fake = scripted((request, bindings) => {
    let result: CdpObject = {};
    if (request.method === 'Target.getTargets') {
      result = {
        targetInfos: [
          { targetId: 'page-main', type: 'page' },
          { targetId: 'frame-child', type: 'iframe', parentFrameId: 'page-main' },
          { targetId: 'foreign-frame', type: 'iframe', parentFrameId: 'foreign-page' },
        ],
      };
    } else if (request.method === 'Page.getFrameTree') {
      result = {
        frameTree: {
          frame: { id: 'page-main' },
          childFrames: [{ frame: { id: 'frame-child' } }],
        },
      };
    } else if (request.method === 'Target.attachToTarget') {
      result = { sessionId: `session:${targetIdOf(request)}` };
    }
    bindings.reply(request.id, result);
  });

  await withBindings(fake, async () => {
    const mainSessionId = await ensureSession('page-main');
    expect(await pageNetworkSessions(mainSessionId)).toEqual([
      'session:page-main',
      'session:frame-child',
    ]);
  });
});

test('a live auto-attached OOPIF survives a temporarily incomplete frame tree', async () => {
  const fake = scripted((request, bindings) => {
    let result: CdpObject = {};
    if (request.method === 'Target.getTargets') {
      result = {
        targetInfos: [
          { targetId: 'page-main', type: 'page' },
          { targetId: 'frame-child', type: 'iframe', parentFrameId: 'same-process-parent' },
        ],
      };
    } else if (request.method === 'Page.getFrameTree') {
      // Target and frame-tree snapshots are not atomic. The target can be
      // visible one protocol turn before its parent frame appears here.
      result = { frameTree: { frame: { id: 'page-main' } } };
    } else if (request.method === 'Target.attachToTarget') {
      result = { sessionId: `session:${targetIdOf(request)}` };
    }
    bindings.reply(request.id, result);
  });

  await withBindings(fake, async () => {
    const mainSessionId = await ensureSession('page-main');
    emitNow(fake, mainSessionId, 'Target.attachedToTarget', {
      sessionId: 'session:frame-child',
      targetInfo: {
        targetId: 'frame-child',
        type: 'iframe',
        parentFrameId: 'same-process-parent',
      },
      waitingForDebugger: true,
    });
    await turn();

    expect(await pageNetworkSessions(mainSessionId)).toEqual([
      'session:page-main',
      'session:frame-child',
    ]);
  });
});

test('Page network session discovery honors its transport timeout', async () => {
  const fake = scripted((request, bindings) => {
    if (request.method === 'Target.getTargets') return;
    bindings.reply(
      request.id,
      request.method === 'Target.attachToTarget'
        ? { sessionId: `session:${targetIdOf(request)}` }
        : {},
    );
  });

  await withBindings(fake, async () => {
    const mainSessionId = await ensureSession('page-main');
    const error = await rejectionOf(() => pageNetworkSessions(mainSessionId, 10));
    expect(error).toBeInstanceOf(CdpRequestTimeoutError);
    if (!(error instanceof CdpRequestTimeoutError)) return;
    expect(error.method).toBe('Target.getTargets');
    expect(error.timeoutMs > 0 && error.timeoutMs <= 10).toBe(true);
  });
});

/** Answers attach, Target.getTargets and Page.getFrameTree for page-main with one OOPIF child. */
function oopifPageResult(request: CdpRequestMessage): CdpObject {
  if (request.method === 'Target.attachToTarget') {
    return { sessionId: `session:${targetIdOf(request)}` };
  }
  if (request.method === 'Target.getTargets') {
    return {
      targetInfos: [
        { targetId: 'page-main', type: 'page' },
        { targetId: 'frame-child', type: 'iframe', parentFrameId: 'page-main' },
      ],
    };
  }
  if (request.method === 'Page.getFrameTree') {
    return {
      frameTree: {
        frame: { id: 'page-main' },
        childFrames: [{ frame: { id: 'frame-child', parentId: 'page-main' } }],
      },
    };
  }
  return {};
}

test('a shorter network-tracking waiter does not cancel shared initialization', async () => {
  let delayedNetworkEnable: (() => void) | undefined;
  const fake = scripted((request, bindings) => {
    const result = oopifPageResult(request);
    const respond = () => {
      deliverNow(bindings, { id: request.id, result });
    };
    if (request.method === 'Network.enable' && request.sessionId === 'session:frame-child') {
      delayedNetworkEnable = respond;
      setTimeout(respond, 80);
      return;
    }
    queueMicrotask(respond);
  });
  const childNetworkEnables = () => methodCount(fake.sent, 'Network.enable', 'session:frame-child');

  await withBindings(fake, async () => {
    const mainSessionId = await ensureSession('page-main');
    emitNow(fake, mainSessionId, 'Target.attachedToTarget', {
      sessionId: 'session:frame-child',
      targetInfo: { targetId: 'frame-child', type: 'iframe', parentFrameId: 'page-main' },
      waitingForDebugger: false,
    });
    await turn();

    const discoveryStartedAt = performance.now();
    expect(await pageNetworkSessions(mainSessionId, 10)).toEqual([
      'session:page-main',
      'session:frame-child',
    ]);
    expect(
      performance.now() - discoveryStartedAt < 60,
      "best-effort initialization must stay inside discovery's budget",
    ).toBe(true);

    const startedAt = performance.now();
    const error = await rejectionOf(() => ensureNetworkTracking(['session:frame-child'], 10));
    expect(error).toBeInstanceOf(CdpRequestTimeoutError);
    expect(error).toMatchObject({ method: 'Network.enable', timeoutMs: 10 });
    expect(performance.now() - startedAt < 60, 'the short waiter must honor its own budget').toBe(
      true,
    );
    expect(typeof delayedNetworkEnable).toBe('function');
    expect(
      childNetworkEnables(),
      'the short waiter must reuse the existing Network.enable request',
    ).toBe(1);

    await sleep(90);
    await ensureNetworkTracking(['session:frame-child'], 10);
    expect(childNetworkEnables(), 'the shared request still completes for later callers').toBe(1);
  });
});

test('a shorter session waiter does not cancel shared auto-attach initialization', async () => {
  const fake = scripted((request, bindings) => {
    const result = oopifPageResult(request);
    const respond = () => {
      deliverNow(bindings, { id: request.id, result });
    };
    if (request.method === 'Target.setAutoAttach' && request.sessionId === 'session:frame-child') {
      setTimeout(respond, 80);
      return;
    }
    queueMicrotask(respond);
  });
  const childAutoAttaches = () =>
    methodCount(fake.sent, 'Target.setAutoAttach', 'session:frame-child');

  await withBindings(fake, async () => {
    const mainSessionId = await ensureSession('page-main');
    emitNow(fake, mainSessionId, 'Target.attachedToTarget', {
      sessionId: 'session:frame-child',
      targetInfo: { targetId: 'frame-child', type: 'iframe', parentFrameId: 'page-main' },
      waitingForDebugger: false,
    });
    await turn();

    const discoveryStartedAt = performance.now();
    expect(await pageNetworkSessions(mainSessionId, 10)).toEqual([
      'session:page-main',
      'session:frame-child',
    ]);
    expect(
      performance.now() - discoveryStartedAt < 60,
      "shared auto-attach must stay inside discovery's budget",
    ).toBe(true);

    const startedAt = performance.now();
    expect(await ensureSession('frame-child', 10)).toBe('session:frame-child');
    expect(
      performance.now() - startedAt < 60,
      'best-effort auto-attach must not outlive the session wait budget',
    ).toBe(true);
    expect(
      childAutoAttaches(),
      'the short waiter must reuse the existing auto-attach request',
    ).toBe(1);

    await sleep(90);
    expect(await ensureSession('frame-child', 10)).toBe('session:frame-child');
    expect(
      childAutoAttaches(),
      'the shared auto-attach request still completes for later callers',
    ).toBe(1);
  });
});

test('an OOPIF document request can finish in its child session', async () => {
  const fake = scripted((request, bindings) => {
    let result: CdpObject = {};
    if (request.method === 'Target.getTargets') {
      result = {
        targetInfos: [
          { targetId: 'page-main', type: 'page' },
          {
            targetId: 'frame-child',
            type: 'iframe',
            parentFrameId: 'page-main',
            url: 'https://frame.example/',
          },
        ],
      };
    } else if (request.method === 'Page.getFrameTree') {
      result = {
        frameTree: {
          frame: { id: 'page-main' },
          childFrames: [{ frame: { id: 'frame-child' } }],
        },
      };
    } else if (request.method === 'Target.attachToTarget') {
      result = { sessionId: `session:${targetIdOf(request)}` };
    } else if (request.method === 'Runtime.evaluate') {
      result = { result: { value: 'loading' } };
    }
    bindings.reply(request.id, result);
  });

  await withBindings(fake, async () => {
    const mainSession = await ensureSession('page-main');
    const foreignSession = await ensureSession('page-foreign');
    emitNow(fake, mainSession, 'Network.requestWillBeSent', {
      requestId: 'document-request',
      frameId: 'frame-child',
      loaderId: 'document-request',
      type: 'Document',
      request: { url: 'https://frame.example/' },
    });
    emitNow(fake, foreignSession, 'Network.requestWillBeSent', {
      requestId: 'document-request',
      frameId: 'foreign-frame',
      loaderId: 'document-request',
      type: 'Document',
      request: { url: 'https://foreign.example/' },
    });

    const sessions = await pageNetworkSessions(mainSession);
    emitNow(fake, 'session:frame-child', 'Network.loadingFinished', {
      requestId: 'document-request',
    });

    expect(networkActivity(sessions).inflight).toBe(0);
    expect(
      networkActivity([foreignSession]).inflight,
      "a terminal event must not clear an unrelated Page's request",
    ).toBe(1);

    emitNow(fake, mainSession, 'Network.requestWillBeSent', {
      requestId: 'reattached-document',
      frameId: 'frame-child',
      loaderId: 'reattached-document',
      type: 'Document',
    });
    await pageNetworkSessions(mainSession);
    emitNow(fake, mainSession, 'Target.targetDestroyed', { targetId: 'frame-child' });
    expect(
      networkActivity([mainSession]).tracking,
      'destroying an OOPIF must not detach its parent Page session',
    ).toBe(true);
    expect(
      networkActivity([mainSession]).inflight,
      'destroying a reattached OOPIF removes its migrated document request',
    ).toBe(0);
  });
});

test('auto-attached OOPIFs are instrumented and resumed without waiting for Network.enable', async () => {
  let delayedChildNetworkEnable: CdpRequestMessage | undefined;
  const fake = scripted((request, bindings) => {
    if (request.method === 'Network.enable' && request.sessionId === 'session:frame-child') {
      delayedChildNetworkEnable = request;
      return;
    }
    queueMicrotask(() => {
      if (request.method === 'Target.setAutoAttach' && request.sessionId === 'session:page-main') {
        emitNow(bindings, 'session:page-main', 'Network.requestWillBeSent', {
          requestId: 'oopif-document',
          frameId: 'frame-child',
          loaderId: 'oopif-document',
          type: 'Document',
        });
        emitNow(bindings, 'session:page-main', 'Target.attachedToTarget', {
          sessionId: 'session:frame-child',
          targetInfo: {
            targetId: 'frame-child',
            type: 'iframe',
            parentFrameId: 'same-process-parent',
          },
          waitingForDebugger: true,
        });
      }
      const result =
        request.method === 'Target.attachToTarget'
          ? { sessionId: `session:${targetIdOf(request)}` }
          : {};
      deliverNow(bindings, { id: request.id, result });
      if (
        request.method === 'Runtime.runIfWaitingForDebugger' &&
        request.sessionId === 'session:frame-child' &&
        delayedChildNetworkEnable
      ) {
        deliverNow(bindings, { id: delayedChildNetworkEnable.id, result: {} });
        delayedChildNetworkEnable = undefined;
      }
    });
  });

  await withBindings(fake, async () => {
    await ensureSession('page-main');
    await turn();
    const sent = fake.sent;

    const mainAutoAttach = sent.find(
      (request) =>
        request.method === 'Target.setAutoAttach' && request.sessionId === 'session:page-main',
    );
    expect(mainAutoAttach?.params.autoAttach).toBe(true);
    expect(mainAutoAttach?.params.waitForDebuggerOnStart).toBe(true);
    expect(mainAutoAttach?.params.flatten).toBe(true);

    const childNetworkIndex = sent.findIndex(
      (request) =>
        request.method === 'Network.enable' && request.sessionId === 'session:frame-child',
    );
    const childResumeIndex = sent.findIndex(
      (request) =>
        request.method === 'Runtime.runIfWaitingForDebugger' &&
        request.sessionId === 'session:frame-child',
    );
    expect(childNetworkIndex >= 0, 'the child Network domain is enabled').toBe(true);
    expect(childResumeIndex >= 0, 'the paused child is resumed').toBe(true);
    expect(
      childNetworkIndex < childResumeIndex,
      'Network.enable is sent before the child resumes',
    ).toBe(true);
    expect(
      sent.some((request) => request.method === 'egoAutomated.enable'),
      'PiArc has no automation-hook domain (ADR-0091)',
    ).toBe(false);
    expect(delayedChildNetworkEnable, 'resuming does not await the Network.enable response').toBe(
      undefined,
    );
    expect(
      networkActivity(['session:page-main']).inflight,
      'a migrated request stays counted for the parent until the child is enumerated',
    ).toBe(1);
    expect(
      networkActivity(['session:page-main', 'session:frame-child']).inflight,
      'enabling the child Network domain preserves the migrated request',
    ).toBe(1);
    emitNow(fake, 'session:frame-child', 'Network.loadingFinished', {
      requestId: 'oopif-document',
    });
    expect(networkActivity(['session:page-main', 'session:frame-child']).inflight).toBe(0);
  });
});

for (const targetType of ['worker', 'worklet', 'shared_worker']) {
  test(`${targetType} targets are auto-attached, resumed, then detached`, async () => {
    const fake = scripted((request, bindings) => {
      bindings.reply(
        request.id,
        request.method === 'Target.attachToTarget' ? { sessionId: 'session:page-main' } : {},
      );
    });

    await withBindings(fake, async () => {
      const mainSessionId = await ensureSession('page-main');
      const sent = fake.sent;
      const autoAttach = sent.find(
        (request) =>
          request.method === 'Target.setAutoAttach' && request.sessionId === mainSessionId,
      );
      // No catch-all exclude: a browser can pause excluded targets without
      // attaching them, which leaves them paused forever.
      expect(autoAttach?.params.filter).toEqual([{}]);

      emitNow(fake, mainSessionId, 'Target.attachedToTarget', {
        sessionId: 'session:child',
        targetInfo: { targetId: 'child', type: targetType },
        waitingForDebugger: true,
      });
      await turn();

      const resumeIndex = sent.findIndex(
        (request) =>
          request.method === 'Runtime.runIfWaitingForDebugger' &&
          request.sessionId === 'session:child',
      );
      const detachIndex = sent.findIndex(
        (request) =>
          request.method === 'Target.detachFromTarget' &&
          request.params.sessionId === 'session:child',
      );
      expect(resumeIndex >= 0, 'a target paused by auto-attach is resumed').toBe(true);
      expect(
        detachIndex > resumeIndex,
        'the session is detached only after the resume was answered',
      ).toBe(true);
      expect(sent[detachIndex]?.sessionId).toBe(mainSessionId);
      expect(
        sent.some(
          (request) =>
            request.sessionId === 'session:child' &&
            request.method !== 'Runtime.runIfWaitingForDebugger',
        ),
        'the harness must not drive a non-frame target',
      ).toBe(false);
    });
  });
}

test('explicitly attached pages are never released as related targets', async () => {
  const fake = scripted((request, bindings) => {
    bindings.reply(
      request.id,
      request.method === 'Target.attachToTarget' ? { sessionId: 'session:page-main' } : {},
    );
  });

  await withBindings(fake, async () => {
    const mainSessionId = await ensureSession('page-main');
    // A browser-level Target.attachToTarget also emits attachedToTarget, with
    // no owning session.
    deliverNow(fake, {
      method: 'Target.attachedToTarget',
      params: {
        sessionId: mainSessionId,
        targetInfo: { targetId: 'page-main', type: 'page' },
        waitingForDebugger: false,
      },
    });
    await turn();

    expect(fake.sent.some((request) => request.method === 'Target.detachFromTarget')).toBe(false);
  });
});

// Gap A: ensureSession() calls the raw listTabs binding to attach a session.
// When the task is blocked it returns { error, error_code }; the result must
// surface the ego-browser-owned wording for the code (not the native error
// message) and carry error_code, instead of throwing the bare native error message.
test('browserCdp surfaces the owned message and error_code when ensureSession is blocked', async () => {
  const fake = new FakeBindings({
    listTabs: () =>
      Promise.resolve({
        error: 'Task space 10 is not assigned to an agent.',
        error_code: 'EGO_TASK_SPACE_INACTIVE',
      }),
  });
  await withBindings(fake, async () => {
    const error = await rejectionOf(() =>
      browserCdp('Runtime.evaluate', { expression: '1' }, undefined, 1000),
    );
    expect(error).toHaveProperty('error_code', 'EGO_TASK_SPACE_INACTIVE');
    // Owned guidance block, not the native "Task space 10 ..." text.
    expect(error.message).toMatch(/claimTaskSpace\(spaceId\)/);
    expect(error.message).not.toMatch(/\b10\b/);
  });
});

// Gap B: a raw CDP send that fails locally is reported through
// ego.onSendCDPMessageError, not as a CDP response. Without wiring the request
// would hang until the 15s timeout; wired, it rejects immediately with the
// owned message and error_code.
test('browserCdp rejects the in-flight request via onSendCDPMessageError', async () => {
  // The binding delivers the failure asynchronously through the event loop.
  const fake = scripted((_request, bindings) => {
    bindings.sendError('native reconstructed text', 'EGO_TASK_SPACE_INACTIVE');
  });
  await withBindings(fake, async () => {
    // Browser-level method skips ensureSession; short timeout bounds a regression.
    const error = await rejectionOf(() => browserCdp('Browser.getVersion', {}, undefined, 1000));
    expect(error).toHaveProperty('error_code', 'EGO_TASK_SPACE_INACTIVE');
    // Owned guidance block, not the native reconstructed text.
    expect(error.message).toMatch(/claimTaskSpace\(spaceId\)/);
    expect(error.message).not.toMatch(/native reconstructed text/);
  });
});

/** Bindings whose every CDP send fails locally with `errorCode`, probing through `probe`. */
function failingSendBindings(
  message: string,
  errorCode: string,
  probe: (state: string) => Promise<EgoResult<string>>,
): FakeBindings {
  const fake: FakeBindings = new FakeBindings({
    setAgentTaskState: probe,
    cdp: () => {
      fake.sendError(message, errorCode);
      return undefined;
    },
  });
  return fake;
}

test('a non-user-control CDP failure does not run the permission probe', async () => {
  let probes = 0;
  const fake = failingSendBindings('The task space is inactive.', 'EGO_TASK_SPACE_INACTIVE', () => {
    probes += 1;
    return Promise.resolve('state updated.');
  });

  await withBindings(fake, async () => {
    const error = await rejectionOf(() => browserCdp('Browser.getVersion', {}, undefined, 1000));
    expect(error).toHaveProperty('error_code', 'EGO_TASK_SPACE_INACTIVE');
    expect(error.message).toMatch(/no longer assigned to the agent/);
    expect(probes).toBe(0);
  });
});

test('a user-control CDP failure probes the native permission reason before rejecting', async () => {
  let probes = 0;
  const fake = failingSendBindings(
    'The task is under user control.',
    'EGO_TASK_SPACE_USER_IN_CONTROL',
    () => {
      probes += 1;
      return Promise.resolve({
        error: 'microphone',
        error_code: 'EGO_TASK_SPACE_USER_IN_CONTROL',
      });
    },
  );

  await withBindings(fake, async () => {
    const error = await rejectionOf(() => browserCdp('Browser.getVersion', {}, undefined, 1000));
    expect(error).toHaveProperty('error_code', 'EGO_TASK_SPACE_USER_IN_CONTROL');
    expect(error.message).toMatch(/microphone access/);
    expect(probes).toBe(1);
  });
});

test('concurrent user-control CDP failures share one permission probe', async () => {
  let probes = 0;
  let finishProbe: (result: EgoResult<string>) => void = () => undefined;
  const fake = failingSendBindings(
    'The task is under user control.',
    'EGO_TASK_SPACE_USER_IN_CONTROL',
    () => {
      probes += 1;
      return new Promise((resolve) => {
        finishProbe = resolve;
      });
    },
  );

  await withBindings(fake, async () => {
    const requests = [
      browserCdp('Browser.getVersion', {}, undefined, 1000),
      browserCdp('Browser.getBrowserCommandLine', {}, undefined, 1000),
    ];
    await turn();
    expect(probes).toBe(1);
    finishProbe({ error: 'camera', error_code: 'EGO_TASK_SPACE_USER_IN_CONTROL' });
    const results = await Promise.allSettled(requests);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    for (const result of results) {
      expect(result.status === 'rejected' ? String(result.reason) : '').toMatch(/camera access/);
    }
  });
});

test('a failed permission probe falls back to generic user-control guidance', async () => {
  const fake = failingSendBindings(
    'The task is under user control.',
    'EGO_TASK_SPACE_USER_IN_CONTROL',
    () => Promise.reject(new Error('probe transport failed')),
  );

  await withBindings(fake, async () => {
    const error = await rejectionOf(() => browserCdp('Browser.getVersion', {}, undefined, 1000));
    expect(error.message).toMatch(/Control of this task space is with the user/);
    expect(error.message).not.toMatch(/probe transport failed/);
  });
});

test('a recovered probe allows a later takeover to be detected', async () => {
  let probes = 0;
  const fake = failingSendBindings(
    'The task is under user control.',
    'EGO_TASK_SPACE_USER_IN_CONTROL',
    () => {
      probes += 1;
      if (probes === 1) return Promise.resolve('state updated.');
      return Promise.resolve({ error: 'location', error_code: 'EGO_TASK_SPACE_USER_IN_CONTROL' });
    },
  );

  await withBindings(fake, async () => {
    const first = await rejectionOf(() => browserCdp('Browser.getVersion', {}, undefined, 1000));
    expect(first.message).toMatch(/The task is under user control/);
    const second = await rejectionOf(() => browserCdp('Browser.getVersion', {}, undefined, 1000));
    expect(second.message).toMatch(/location access/);
    expect(probes).toBe(2);
  });
});

test('CDP events are drained only by the target session that received them', async () => {
  let nextSession = 1;
  const fake = scripted((request, bindings) => {
    bindings.reply(
      request.id,
      request.method === 'Target.attachToTarget'
        ? { sessionId: `session-${String(nextSession++)}` }
        : {},
    );
  });

  await withBindings(fake, async () => {
    const attachedA = await browserCdp('Target.attachToTarget', {
      targetId: 'target-a',
      flatten: true,
    });
    const attachedB = await browserCdp('Target.attachToTarget', {
      targetId: 'target-b',
      flatten: true,
    });
    const sessionA = attachedSession(attachedA);
    const sessionB = attachedSession(attachedB);

    emitNow(fake, sessionA, 'Network.requestWillBeSent', { requestId: 'request-a' });

    expect(drainPageEvents(sessionB), 'target B must not consume target A events').toEqual([]);
    expect(
      drainPageEvents(sessionA).map((event) =>
        event.method === 'Network.requestWillBeSent' ? event.params?.requestId : undefined,
      ),
      'target A retains its own event queue',
    ).toEqual(['request-a']);
  });
});

test('a JavaScript dialog interrupts the blocked Page input command', async () => {
  const sessionId = 'session-dialog';
  let pendingDisableRequestId: number | undefined;
  const fake = scripted((request, bindings) => {
    if (request.method === 'Target.attachToTarget') {
      bindings.reply(request.id, { sessionId });
      return;
    }
    if (request.method === 'Page.enable') {
      bindings.reply(request.id, {});
      return;
    }
    if (request.method === 'Page.setInterceptFileChooserDialog') {
      if (request.params.enabled === true) {
        bindings.reply(request.id, {});
      } else {
        pendingDisableRequestId = request.id;
      }
      return;
    }
    if (request.method === 'Input.dispatchMouseEvent') {
      // Chromium keeps this request pending until the modal dialog closes.
      bindings.emit({
        sessionId,
        method: 'Page.javascriptDialogOpening',
        params: {
          type: 'alert',
          message: 'Confirm action',
          url: 'https://example.test/dialog',
        },
      });
    }
  });

  await withBindings(fake, async () => {
    const attached = await browserCdp('Target.attachToTarget', {
      targetId: 'target-dialog',
      flatten: true,
    });
    const attachedSessionId = attachedSession(attached);
    await browserCdp('Page.enable', {}, attachedSessionId);
    const fileChooser = prepareFileChooser(attachedSessionId, {
      timeoutMs: 1_000,
      cancel: true,
    });
    await fileChooser.ready;

    const inputError = await rejectionOf(() =>
      browserCdp(
        'Input.dispatchMouseEvent',
        { type: 'mouseReleased', x: 10, y: 10 },
        attachedSessionId,
        100,
      ),
    );
    expect(inputError).toBeInstanceOf(PageDialogOpenedError);
    expect(inputError).toHaveProperty('code', 'EGO_PAGE_DIALOG_OPENED');
    expect(inputError).toHaveProperty('dialog', {
      type: 'alert',
      message: 'Confirm action',
      url: 'https://example.test/dialog',
    });

    const releaseError = await rejectionOf(() =>
      browserCdp('Runtime.releaseObject', { objectId: 'element-1' }, attachedSessionId, 100),
    );
    expect(releaseError).toMatchObject({
      code: 'EGO_PAGE_DIALOG_OPENED',
      method: 'Runtime.releaseObject',
    });

    const disposeStartedAt = Date.now();
    setTimeout(() => {
      if (pendingDisableRequestId !== undefined) {
        deliverNow(fake, { id: pendingDisableRequestId, result: {} });
      }
    }, 60);
    await fileChooser.dispose();
    expect(
      Date.now() - disposeStartedAt < 40,
      'dialog handling must not wait for file chooser cleanup',
    ).toBe(true);
  });
});

interface DialogRuntime {
  readonly fake: FakeBindings;
  readonly sent: CdpRequestMessage[];
}

async function withDialogRuntime(
  fn: (runtime: DialogRuntime) => Promise<void>,
  { hold = [] }: { hold?: readonly string[] } = {},
): Promise<void> {
  const fake = scripted((request, bindings) => {
    // Held methods behave like renderer commands stalled behind a dialog.
    if (hold.includes(request.method)) return;
    bindings.reply(
      request.id,
      request.method === 'Target.attachToTarget' ? { sessionId: 'session-page' } : {},
    );
  });
  await withBindings(fake, async () => {
    invalidateSession();
    await fn({ fake, sent: fake.sent });
  });
}

const CONFIRM_DIALOG = {
  type: 'confirm',
  message: 'Submit? This cannot be undone.',
  url: 'https://example.test/form',
};

test('an open JavaScript dialog fails renderer commands fast and names the dialog', async () => {
  await withDialogRuntime(async ({ fake, sent }) => {
    const attached = await browserCdp('Target.attachToTarget', {
      targetId: 'target-page',
      flatten: true,
    });
    const sessionId = attachedSession(attached);
    emitNow(fake, sessionId, 'Page.javascriptDialogOpening', CONFIRM_DIALOG);
    sent.length = 0;

    for (const method of [
      'Page.getFrameTree',
      'Page.captureScreenshot',
      'Page.getLayoutMetrics',
      'Accessibility.getFullAXTree',
      'DOM.getBoxModel',
    ]) {
      const error = await rejectionOf(() => browserCdp(method, {}, sessionId, 10_000));
      expect(error).toMatchObject({
        code: 'EGO_PAGE_DIALOG_OPENED',
        method,
        dialog: CONFIRM_DIALOG,
      });
      expect(error.message).toBe(
        `${method} cannot run while a JavaScript confirm dialog ` +
          `("Submit? This cannot be undone.") is open; handle it with ` +
          'page.acceptDialog() or page.dismissDialog() before continuing',
      );
    }
    expect(sent).toEqual([]);

    // Browser-process methods still answer while the dialog is open.
    await browserCdp('Target.getTargets', {});
    await browserCdp('Page.setDownloadBehavior', { behavior: 'default' }, sessionId);
    await browserCdp('Page.handleJavaScriptDialog', { accept: false }, sessionId);
    expect(sent.map((request) => request.method)).toEqual([
      'Target.getTargets',
      'Page.setDownloadBehavior',
      'Page.handleJavaScriptDialog',
    ]);

    emitNow(fake, sessionId, 'Page.javascriptDialogClosed', { result: false });
    await browserCdp('Page.getFrameTree', {}, sessionId);
  });
});

test("a dialog rejects stalled in-flight commands across the Page's frame sessions", async () => {
  await withDialogRuntime(
    async ({ fake, sent }) => {
      const attached = await browserCdp('Target.attachToTarget', {
        targetId: 'target-page',
        flatten: true,
      });
      const pageSession = attachedSession(attached);
      emitNow(fake, pageSession, 'Target.attachedToTarget', {
        sessionId: 'session-frame',
        targetInfo: { targetId: 'target-frame', type: 'iframe' },
        waitingForDebugger: false,
      });

      const pageTree = browserCdp('Page.getFrameTree', {}, pageSession, 10_000);
      const frameTree = browserCdp('Page.getFrameTree', {}, 'session-frame', 10_000);
      let downloadSettled = false;
      const download = browserCdp(
        'Page.setDownloadBehavior',
        { behavior: 'default' },
        pageSession,
        50,
      ).finally(() => {
        downloadSettled = true;
      });
      await turn();

      // Chromium reports a dialog opened by any frame on the Page session.
      emitNow(fake, pageSession, 'Page.javascriptDialogOpening', CONFIRM_DIALOG);

      for (const [promise, sessionId] of [
        [pageTree, pageSession],
        [frameTree, 'session-frame'],
      ] as const) {
        const error = await rejectionOf(promise);
        expect(error).toMatchObject({ code: 'EGO_PAGE_DIALOG_OPENED', sessionId });
        expect(error.message).toMatch(
          /^a JavaScript confirm dialog \("Submit\? This cannot be undone\."\) opened while Page\.getFrameTree was running;/,
        );
      }
      expect(downloadSettled, 'safe commands stay in flight').toBe(false);
      expect(await rejectionOf(download)).toBeInstanceOf(CdpRequestTimeoutError);

      // New commands on the frame session fail before they are sent.
      sent.length = 0;
      const error = await rejectionOf(() =>
        browserCdp('Accessibility.getFullAXTree', {}, 'session-frame', 10_000),
      );
      expect(error).toHaveProperty('code', 'EGO_PAGE_DIALOG_OPENED');
      expect(sent).toEqual([]);
    },
    { hold: ['Page.getFrameTree', 'Page.setDownloadBehavior'] },
  );
});

test('a raw command stalled by a known dialog reports it instead of a bare timeout', async () => {
  await withDialogRuntime(
    async ({ fake }) => {
      const attached = await browserCdp('Target.attachToTarget', {
        targetId: 'target-page',
        flatten: true,
      });
      const sessionId = attachedSession(attached);
      emitNow(fake, sessionId, 'Page.javascriptDialogOpening', CONFIRM_DIALOG);

      // Network tracking sends Network.enable directly, outside browserCdp's
      // pre-send check, so only its timeout can name the dialog.
      const error = await rejectionOf(() => ensureNetworkTracking([sessionId], 20));
      expect(error).toMatchObject({ code: 'EGO_PAGE_DIALOG_OPENED', method: 'Network.enable' });
      expect(error.message).toMatch(/^Network\.enable cannot run while/);

      emitNow(fake, sessionId, 'Page.javascriptDialogClosed', { result: true });
      expect(await rejectionOf(() => ensureNetworkTracking([sessionId], 20))).toBeInstanceOf(
        CdpRequestTimeoutError,
      );
    },
    { hold: ['Network.enable'] },
  );
});

test('page event drains exclude unscoped browser events', async () => {
  const fake = scripted((request, bindings) => {
    bindings.reply(
      request.id,
      request.method === 'Target.attachToTarget' ? { sessionId: 'session-page' } : {},
    );
  });

  await withBindings(fake, async () => {
    const attached = await browserCdp('Target.attachToTarget', {
      targetId: 'target-page',
      flatten: true,
    });
    const sessionId = attachedSession(attached);
    deliverNow(fake, { method: 'Target.targetCreated', params: { targetId: 'x' } });
    deliverNow(fake, {
      sessionId,
      method: 'Runtime.consoleAPICalled',
      params: { value: 'page' },
    });

    expect(eventMethods(drainPageEvents(sessionId))).toEqual(['Runtime.consoleAPICalled']);
  });
});

test('browser event subscribers are isolated and can unsubscribe', async () => {
  const received: CdpEvent[] = [];
  const reported: unknown[][] = [];
  const fake = scripted((request, bindings) => {
    bindings.reply(request.id, {});
  });
  const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    reported.push(args);
  });

  const unsubscribeThrowing = subscribeBrowserEvents(() => {
    throw new Error('subscriber failed');
  });
  const unsubscribe = subscribeBrowserEvents((event) => received.push(event));
  try {
    await withBindings(fake, async () => {
      await browserCdp('Target.setDiscoverTargets', { discover: true });
      deliverNow(fake, {
        method: 'Target.targetCreated',
        params: { targetInfo: { targetId: 'popup-1', type: 'page' } },
      });
      unsubscribe();
      deliverNow(fake, {
        method: 'Target.targetCreated',
        params: { targetInfo: { targetId: 'popup-2', type: 'page' } },
      });

      expect(
        received.map((event) =>
          event.method === 'Target.targetCreated' ? event.params?.targetInfo?.targetId : undefined,
        ),
      ).toEqual(['popup-1']);
      expect(reported.length, 'each throwing callback is contained').toBe(2);
    });
  } finally {
    unsubscribe();
    unsubscribeThrowing();
    consoleError.mockRestore();
  }
});

test('page event subscribers receive only events from their target', async () => {
  const received: CdpEvent[] = [];
  const fake = scripted((request, bindings) => {
    bindings.reply(
      request.id,
      request.method === 'Target.attachToTarget'
        ? { sessionId: `session:${targetIdOf(request)}` }
        : {},
    );
  });

  const unsubscribe = subscribePageEvents('target-a', (event) => received.push(event));
  try {
    await withBindings(fake, async () => {
      const sessionA = await ensureSession('target-a');
      const sessionB = await ensureSession('target-b');
      deliverNow(fake, {
        sessionId: sessionB,
        method: 'Page.downloadWillBegin',
        params: { guid: 'download-b' },
      });
      deliverNow(fake, {
        sessionId: sessionA,
        method: 'Page.downloadWillBegin',
        params: { guid: 'download-a' },
      });
      unsubscribe();
      deliverNow(fake, {
        sessionId: sessionA,
        method: 'Page.downloadProgress',
        params: { guid: 'download-a', state: 'completed' },
      });

      expect(
        received.map((event) =>
          event.method === 'Page.downloadWillBegin' || event.method === 'Page.downloadProgress'
            ? event.params?.guid
            : undefined,
        ),
      ).toEqual(['download-a']);
    });
  } finally {
    unsubscribe();
  }
});

test('a native CDP callback contains internal handler failures', async () => {
  const reported: unknown[][] = [];
  const fake = scripted((request, bindings) => {
    bindings.reply(
      request.id,
      request.method === 'Target.attachToTarget' ? { sessionId: 'session-callback-guard' } : {},
    );
  });
  const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    reported.push(args);
  });
  let interception: FileChooserInterception | undefined;

  try {
    await withBindings(fake, async () => {
      const attached = await browserCdp('Target.attachToTarget', {
        targetId: 'target-callback-guard',
        flatten: true,
      });
      const sessionId = attachedSession(attached);
      const chooser = prepareFileChooser(sessionId, { timeoutMs: 1_000, cancel: false });
      interception = chooser;
      await chooser.ready;
      // The runtime keeps its own resolve hook on the interception it returned.
      Reflect.set(chooser, 'resolve', () => {
        throw new Error('file chooser handler failed');
      });

      expect(() => {
        deliverNow(fake, {
          sessionId,
          method: 'Page.fileChooserOpened',
          params: { backendNodeId: 42, mode: 'selectSingle' },
        });
      }).not.toThrow();
      expect(reported.length).toBe(1);
      expect(String(reported[0]?.[0])).toMatch(/onCDPMessage/);

      const response = await browserCdp('Runtime.evaluate', { expression: '1' }, sessionId, 1_000);
      expect(response.result).toEqual({});
      await chooser.dispose();
    });
  } finally {
    consoleError.mockRestore();
    await interception?.dispose();
  }
});

test('runtime callbacks can be released without deleting a foreign replacement', async () => {
  const fake = scripted((request, bindings) => {
    bindings.reply(request.id, { ok: true });
  });

  await withBindings(fake, async () => {
    expect(
      typeof releaseRuntimeCallbacks,
      'the SDK lifecycle needs an explicit callback release hook',
    ).toBe('function');
    await browserCdp('Target.getTargets', {}, undefined, 1_000);
    expect(typeof fake.onCDPMessage).toBe('function');
    expect(typeof fake.onSendCDPMessageError).toBe('function');

    releaseRuntimeCallbacks(fake);
    expect(fake.onCDPMessage).toBeUndefined();
    expect(fake.onSendCDPMessageError).toBeUndefined();

    await browserCdp('Target.getTargets', {}, undefined, 1_000);
    const foreignMessage = (message: string) => {
      expect(typeof message).toBe('string');
    };
    const foreignError = (message: string, errorCode: string) => {
      expect(typeof message + typeof errorCode).toBe('stringstring');
    };
    fake.onCDPMessage = foreignMessage;
    fake.onSendCDPMessageError = foreignError;
    releaseRuntimeCallbacks(fake);
    expect(fake.onCDPMessage).toBe(foreignMessage);
    expect(fake.onSendCDPMessageError).toBe(foreignError);
  });
});

test('file chooser interception suppresses the native picker and returns its input', async () => {
  const fake = scripted((request, bindings) => {
    bindings.reply(
      request.id,
      request.method === 'Target.attachToTarget' ? { sessionId: 'session-upload' } : {},
    );
  });

  await withBindings(fake, async () => {
    const attached = await browserCdp('Target.attachToTarget', {
      targetId: 'target-upload',
      flatten: true,
    });
    const sessionId = attachedSession(attached);
    const interception = prepareFileChooser(sessionId, { timeoutMs: 1_000, cancel: true });
    await interception.ready;

    deliverNow(fake, {
      sessionId,
      method: 'Page.fileChooserOpened',
      params: { backendNodeId: 42, frameId: 'frame-upload', mode: 'selectMultiple' },
    });
    expect((await interception.event).backendNodeId).toBe(42);
    await interception.dispose();

    const calls = fake.sent;
    expect(
      calls.some(
        (call) =>
          call.method === 'Page.setInterceptFileChooserDialog' && call.params.enabled === true,
      ),
    ).toBe(true);
    expect(
      calls.some((call) => {
        const files = call.params.files;
        return (
          call.method === 'DOM.setFileInputFiles' &&
          call.params.backendNodeId === 42 &&
          Array.isArray(files) &&
          files.length === 0
        );
      }),
      'the safety interceptor cancels the chooser with an empty file list',
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.method === 'Page.setInterceptFileChooserDialog' && call.params.enabled === false,
      ),
    ).toBe(true);
  });
});

/** Bindings that answer immediately except for held methods, released on demand. */
function pageEnableHoldingBindings(): {
  fake: FakeBindings;
  hold(method: string): void;
  release(method: string): void;
} {
  const held = new Map<string, (() => void)[]>();
  const fake = scripted((request, bindings) => {
    const result =
      request.method === 'Target.attachToTarget'
        ? { sessionId: `session:${targetIdOf(request)}` }
        : {};
    const respond = () => {
      deliverNow(bindings, { id: request.id, result });
    };
    const queue = held.get(request.method);
    if (queue) {
      queue.push(respond);
      return;
    }
    queueMicrotask(respond);
  });
  return {
    fake,
    hold(method) {
      held.set(method, []);
    },
    release(method) {
      for (const respond of held.get(method) ?? []) respond();
      held.delete(method);
    },
  };
}

test('ensureSession bounds its wait for an unanswered Page.enable and shares the request', async () => {
  const runtime = pageEnableHoldingBindings();
  runtime.hold('Page.enable');
  const pageEnables = () => methodCount(runtime.fake.sent, 'Page.enable');

  try {
    await withBindings(runtime.fake, async () => {
      let startedAt = performance.now();
      expect(await ensureSession('page-main', 50)).toBe('session:page-main');
      expect(
        performance.now() - startedAt < 200,
        'an unanswered Page.enable must not hold the session wait beyond its budget',
      ).toBe(true);
      expect(pageEnables()).toBe(1);

      startedAt = performance.now();
      expect(await ensureSession('page-main', 50)).toBe('session:page-main');
      expect(
        performance.now() - startedAt < 200,
        'a cached session must not wait a full budget again',
      ).toBe(true);
      expect(pageEnables(), 'the second caller reuses the still-pending Page.enable request').toBe(
        1,
      );

      runtime.release('Page.enable');
      await turn();
      await ensureSession('page-main', 50);
      expect(
        pageEnables(),
        'a late Page.enable answer records the enabled state for later callers',
      ).toBe(1);
    });
  } finally {
    runtime.release('Page.enable');
  }
});

test('ensureSession caps the setup wait below the transport timeout', async () => {
  const runtime = pageEnableHoldingBindings();
  runtime.hold('Page.enable');
  runtime.hold('Network.enable');

  try {
    await withBindings(runtime.fake, async () => {
      const startedAt = performance.now();
      expect(await ensureSession('page-main')).toBe('session:page-main');
      const elapsed = performance.now() - startedAt;
      expect(
        elapsed >= 1_500 && elapsed < 3_500,
        `the default session wait is capped near two seconds, got ${String(elapsed)}ms`,
      ).toBe(true);
    });
  } finally {
    runtime.release('Page.enable');
    runtime.release('Network.enable');
  }
});

test('ensureFrameSessions reports an unanswered frame tree as an unresponsive Page', async () => {
  const runtime = pageEnableHoldingBindings();
  runtime.hold('Page.getFrameTree');

  try {
    await withBindings(runtime.fake, async () => {
      const startedAt = performance.now();
      const error = await rejectionOf(() => ensureFrameSessions('page-main', 100));
      expect(error).toMatchObject({
        code: 'EGO_PAGE_UNRESPONSIVE',
        name: 'PageUnresponsiveError',
        method: 'Page.getFrameTree',
        targetId: 'page-main',
      });
      expect(
        error,
        'budget-driven retry loops still recognize it as a request timeout',
      ).toBeInstanceOf(CdpRequestTimeoutError);
      expect(error).toBeInstanceOf(PageUnresponsiveError);
      if (!(error instanceof PageUnresponsiveError)) return;
      expect(error.waitedMs >= 90, `waited ${String(error.waitedMs)}ms`).toBe(true);
      expect(error.message).toMatch(/did not answer Page\.getFrameTree/);
      expect(error.message).toMatch(/navigation has not committed/);
      expect(
        performance.now() - startedAt < 400,
        "the unresponsive Page is reported inside the caller's budget",
      ).toBe(true);
      expect(methodCount(runtime.fake.sent, 'Page.getFrameTree')).toBe(1);
    });
  } finally {
    runtime.release('Page.getFrameTree');
  }
});

test('the runtime response timeout defaults to 15 s and honors a test override', () => {
  const restore = setOverrides({ responseTimeoutMs: undefined });
  try {
    expect(responseTimeoutMs()).toBe(15_000);
    setOverrides({ responseTimeoutMs: 4000 });
    expect(responseTimeoutMs()).toBe(4_000);
    // Upstream's invalid env values "0", "-1", "abc", "1.5" and "" as numbers.
    for (const invalid of [0, -1, Number.NaN, 1.5]) {
      setOverrides({ responseTimeoutMs: invalid });
      expect(responseTimeoutMs(), `ignores ${String(invalid)}`).toBe(15_000);
    }
  } finally {
    restore();
  }
});

test('a received CDP message envelope is validated before use', async () => {
  const fake = scripted((request, bindings) => {
    bindings.reply(
      request.id,
      request.method === 'Target.attachToTarget' ? { sessionId: 'session-page' } : {},
    );
  });

  await withBindings(fake, async () => {
    const attached = await browserCdp('Target.attachToTarget', {
      targetId: 'target-page',
      flatten: true,
    });
    const sessionId = attachedSession(attached);
    // Malformed messages are ignored instead of reaching the event queue.
    fake.onCDPMessage?.('not json');
    deliverNow(fake, { sessionId, method: 42, params: {} });
    deliverNow(fake, { sessionId, method: 'Runtime.consoleAPICalled', params: 'text' });
    deliverNow(fake, { sessionId, method: 'Runtime.consoleAPICalled', params: { value: 'ok' } });
    const events = drainPageEvents(sessionId);
    expect(eventMethods(events)).toEqual(['Runtime.consoleAPICalled']);
    expect(events.every((event) => event.params === undefined || isRecord(event.params))).toBe(
      true,
    );
  });
});
