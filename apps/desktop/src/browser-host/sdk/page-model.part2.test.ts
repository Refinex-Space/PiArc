// Ported from ego-browser package/ego-browser/src/page-model.test.mjs (ego-lite commit 56589ea8,
// MIT, see LICENSE). PiArc: Vitest on page-model.fixture.ts; upstream tests 26-72, from "a
// claimed space closes with every tab kept by keep all" to "Page evaluate follows JSON omission
// rules in one CDP request". Ledgers live in the fixture's in-memory storage; overridden
// services.cdp answers the unwrapped result; snapshot options carry the Page's targetId;
// screenshots attach an image and refuse a path; the two viewport-overflow hint tests are dropped
// with the hint.

import { expect, test } from 'vitest';

import { fakeCdp } from '../testing.js';
import { CdpRequestTimeoutError } from './browser-runtime.js';
import { isRecord, type CdpCall, type CdpObject } from './cdp-types.js';
import { PageNavigationTimeoutError } from './driver/page-waits.js';
import type { EgoSnapshotOptions } from './ego-bindings.js';
import { resetSink } from './output-sink.js';
import {
  capturedRoundOutput,
  cdpCalls,
  fixtureLedger,
  openTestPage,
  rejection,
  taskForRound,
  unmanagedPage,
  untyped,
  withFixture,
  type Fixture,
  type FixtureCall,
} from './page-model.fixture.js';
import { captureTaskSpaceUserBoundary, createTaskSpaceHandle } from './page-model.js';
import { PageRefRegistry } from './page-ref-registry.js';

function finishFixtureTask(fixture: Fixture, lifecycleCalls: string[]) {
  const ledger = fixtureLedger(fixture);
  const task = taskForRound(fixture, 'round-a', {
    ledger,
    completeTaskSpace() {
      lifecycleCalls.push('finish');
      return Promise.resolve();
    },
    closeTaskSpace() {
      lifecycleCalls.push('close');
      return Promise.resolve();
    },
  });
  return { ledger, task };
}

async function finishKeepingFirstPage(fixture: Fixture, lifecycleCalls: string[]) {
  const { task } = finishFixtureTask(fixture, lifecycleCalls);
  const kept = await openTestPage(task, 'https://example.test/kept');
  await task.finish({ keep: [kept.label] });
  lifecycleCalls.length = 0;
  return kept.targetId;
}

/** The navigation timeout a goto or reload rejected with (upstream reads its fields). */
async function navigationTimeout(promise: Promise<unknown>): Promise<PageNavigationTimeoutError> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(PageNavigationTimeoutError);
  if (!(error instanceof PageNavigationTimeoutError)) throw error;
  return error;
}

/**
 * Hands a command on with its method widened to `string` (inside a `method === '…'` branch the
 * literal would demand that command's typed params).
 */
function forward(
  cdp: CdpCall,
  method: string,
  params: CdpObject,
  sessionId: string | undefined,
  timeoutMs: number | undefined,
) {
  return cdp(method, params, sessionId, timeoutMs);
}

/** A Page.getFrameTree answer with one main frame. */
function frameTree(loaderId: string) {
  return { frameTree: { frame: { id: 'frame-1', loaderId } } };
}

function timeout(method: string, timeoutMs: number | undefined, sessionId: string | undefined) {
  return new CdpRequestTimeoutError(method, timeoutMs ?? 0, sessionId);
}

test('a claimed space closes with every tab kept by keep all', async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls: string[] = [];
    const { task } = finishFixtureTask(fixture, lifecycleCalls);
    await openTestPage(task, 'https://example.test/one');
    await openTestPage(task, 'https://example.test/two');
    await task.finish({ keep: 'all' });
    lifecycleCalls.length = 0;

    const { task: claimed } = finishFixtureTask(fixture, lifecycleCalls);
    const receipt = await claimed.finish({ keep: [] });

    expect(receipt.closedSpace).toBe(true);
    expect(receipt.preservedUnmanagedCount).toBe(0);
    expect(lifecycleCalls).toEqual(['close']);
  });
});

test('a claim forgets a kept tab the user closed in the meantime', async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls: string[] = [];
    const { ledger, task } = finishFixtureTask(fixture, lifecycleCalls);
    const closedByUser = await openTestPage(task, 'https://example.test/one');
    const stillOpen = await openTestPage(task, 'https://example.test/two');
    await task.finish({ keep: 'all' });
    lifecycleCalls.length = 0;
    fixture.tabs.delete(String(closedByUser.targetId));

    const { task: claimed } = finishFixtureTask(fixture, lifecycleCalls);
    expect(await claimed.tabs()).toHaveLength(1);
    expect((await ledger.read(7)).retainedTargets).toEqual([stillOpen.targetId]);

    const receipt = await claimed.finish({ keep: [] });
    expect(receipt.closedSpace).toBe(true);
    expect(lifecycleCalls).toEqual(['close']);
  });
});

test('a kept tab of unknown origin stays protected after a claim', async () => {
  await withFixture(async (fixture) => {
    resetSink();
    const lifecycleCalls: string[] = [];
    const { ledger, task } = finishFixtureTask(fixture, lifecycleCalls);
    const agentPage = await openTestPage(task, 'https://example.test/agent');
    fixture.addExternalTab('target-user', 'https://example.test/user');
    await ledger.keepUnmanaged(7, 'target-user', 'unknown');
    const userTab = (await task.tabs()).find((tab) => tab.targetId === 'target-user');
    const adopted = await task.adopt(unmanagedPage(userTab));
    expect(adopted.openedBy).toBe('unknown');
    await task.finish({ keep: 'all' });
    lifecycleCalls.length = 0;
    resetSink();

    const { task: claimed } = finishFixtureTask(fixture, lifecycleCalls);
    const origins = Object.fromEntries(
      (await claimed.tabs()).map((tab) => [tab.targetId, tab.openedBy]),
    );
    expect(origins).toEqual({
      [String(agentPage.targetId)]: 'agent',
      'target-user': 'unknown',
    });

    const receipt = await claimed.finish({ keep: [] });

    expect(receipt.closedSpace).toBe(false);
    expect(lifecycleCalls).toEqual(['finish']);
    expect(fixture.tabs.has(String(agentPage.targetId))).toBe(false);
    expect(fixture.tabs.has('target-user')).toBe(true);
    expect(capturedRoundOutput()).toMatch(/did not close task space 7/);
  });
});

test('finish reports an unclosed space only when it was asked to keep nothing', async () => {
  await withFixture(async (fixture) => {
    resetSink();
    const lifecycleCalls: string[] = [];
    await finishKeepingFirstPage(fixture, lifecycleCalls);
    fixture.addExternalTab('target-user', 'https://example.test/user');

    const { task: claimed } = finishFixtureTask(fixture, lifecycleCalls);
    const receipt = await claimed.finish({ keep: 'all' });

    expect(receipt.closedSpace).toBe(false);
    expect(receipt.preservedUnmanagedCount).toBe(1);
    expect(capturedRoundOutput()).not.toMatch(/did not close/);
  });
});

test('TaskSpace finish protects a tab opened while the user owned the space', async () => {
  await withFixture(async (fixture) => {
    resetSink();
    const lifecycleCalls: string[] = [];
    const keptTarget = await finishKeepingFirstPage(fixture, lifecycleCalls);
    fixture.addExternalTab('target-user', 'https://example.test/user');

    const { task: claimed } = finishFixtureTask(fixture, lifecycleCalls);
    const origins = Object.fromEntries(
      (await claimed.tabs()).map((tab) => [tab.targetId, tab.openedBy]),
    );
    expect(origins).toEqual({
      [String(keptTarget)]: 'agent',
      'target-user': 'unknown',
    });
    const receipt = await claimed.finish({ keep: [] });

    expect(receipt.closedSpace).toBe(false);
    expect(receipt.preservedUnmanagedCount).toBe(1);
    expect(lifecycleCalls).toEqual(['finish']);
    expect(fixture.tabs.has(String(keptTarget)), 'the kept tab is closed').toBe(false);
    expect(fixture.tabs.has('target-user'), 'the user tab remains').toBe(true);
    expect(capturedRoundOutput()).toMatch(
      /did not close task space 7: 1 tab\(s\) of user or unknown origin/,
    );
    resetSink();
  });
});

test('TaskSpace finish leaves earlier kept tabs open unless it keeps nothing', async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls: string[] = [];
    const keptTarget = String(await finishKeepingFirstPage(fixture, lifecycleCalls));

    const { task: second } = finishFixtureTask(fixture, lifecycleCalls);
    const secondPage = await openTestPage(second, 'https://example.test/two');
    const receipt = await second.finish({ keep: [secondPage.label] });
    expect(receipt.closedSpace).toBe(false);
    expect(fixture.tabs.has(keptTarget), 'named keep does not close it').toBe(true);

    const { task: third } = finishFixtureTask(fixture, lifecycleCalls);
    const keepAll = await third.finish({ keep: 'all' });
    expect(keepAll.closedSpace).toBe(false);
    expect(fixture.tabs.has(keptTarget), 'keep all does not close it').toBe(true);

    lifecycleCalls.length = 0;
    const { task: last } = finishFixtureTask(fixture, lifecycleCalls);
    const closing = await last.finish({ keep: [] });
    expect(closing.closedSpace, 'origin survives repeated rounds').toBe(true);
    expect(lifecycleCalls).toEqual(['close']);
  });
});

test('a claimed space closes when its kept tab is adopted but not closed before finish', async () => {
  await withFixture(async (fixture) => {
    resetSink();
    const lifecycleCalls: string[] = [];
    const keptTarget = await finishKeepingFirstPage(fixture, lifecycleCalls);

    const { task: claimed } = finishFixtureTask(fixture, lifecycleCalls);
    const [tab] = await claimed.tabs();
    expect(tab?.targetId).toBe(keptTarget);
    const adopted = await claimed.adopt(unmanagedPage(tab));
    expect(adopted.openedBy).toBe('agent');

    const receipt = await claimed.finish({ keep: [] });
    expect(receipt.closedSpace).toBe(true);
    expect(receipt.closedManagedLabels).toEqual([adopted.label]);
    expect(lifecycleCalls).toEqual(['close']);
    expect(capturedRoundOutput()).not.toMatch(/did not close/);
  });
});

test('TaskSpace finish closes the SDK anchor tab when a Page is kept', async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls: string[] = [];
    const { task } = finishFixtureTask(fixture, lifecycleCalls);
    const p1 = await openTestPage(task, 'https://example.test/one');
    await p1.close();
    const anchorTargetId = String((await task.tabs())[0]?.targetId);
    const p2 = await openTestPage(task, 'https://example.test/two');

    const receipt = await task.finish({ keep: ['p2'] });

    expect(receipt).toEqual({
      spaceId: 7,
      closedSpace: false,
      keptManagedLabels: ['p2'],
      closedManagedLabels: [],
      preservedUnmanagedCount: 0,
    });
    expect(lifecycleCalls).toEqual(['finish']);
    expect(fixture.tabs.has(anchorTargetId), 'the anchor is closed').toBe(false);
    expect(fixture.tabs.has(String(p2.targetId)), 'the kept Page remains').toBe(true);
  });
});

test('TaskSpace finish closes the SDK anchor tab but keeps user tabs', async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls: string[] = [];
    const { ledger, task } = finishFixtureTask(fixture, lifecycleCalls);
    const p1 = await openTestPage(task, 'https://example.test/one');
    await p1.close();
    const anchorTargetId = String((await task.tabs())[0]?.targetId);
    fixture.addExternalTab('target-user', 'https://example.test/user');
    await ledger.keepUnmanaged(7, 'target-user', 'unknown');
    const p2 = await openTestPage(task, 'https://example.test/two');

    const receipt = await task.finish({ keep: [] });

    expect(receipt).toEqual({
      spaceId: 7,
      closedSpace: false,
      keptManagedLabels: [],
      closedManagedLabels: ['p2'],
      preservedUnmanagedCount: 1,
    });
    expect(fixture.tabs.has(String(p2.targetId)), 'the Agent Page is closed').toBe(false);
    expect(lifecycleCalls).toEqual(['finish']);
    expect(fixture.tabs.has(anchorTargetId), 'the anchor is closed').toBe(false);
    expect(fixture.tabs.has('target-user'), 'the user tab remains').toBe(true);
  });
});

test('TaskSpace finish keeps an SDK anchor that is the last tab of a kept space', async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls: string[] = [];
    const { task } = finishFixtureTask(fixture, lifecycleCalls);
    const p1 = await openTestPage(task, 'https://example.test/one');
    await p1.close();
    const anchorTargetId = String((await task.tabs())[0]?.targetId);

    const receipt = await task.finish({ keep: 'all' });

    expect(receipt).toEqual({
      spaceId: 7,
      closedSpace: false,
      keptManagedLabels: [],
      closedManagedLabels: [],
      preservedUnmanagedCount: 0,
    });
    expect(lifecycleCalls).toEqual(['finish']);
    expect(
      fixture.tabs.has(anchorTargetId),
      'closing the last tab would destroy the space the caller kept',
    ).toBe(true);
  });
});

test('TaskSpace finish keeps protected unmanaged tabs even with an empty keep list', async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls: string[] = [];
    const { ledger, task } = finishFixtureTask(fixture, lifecycleCalls);
    const agentPage = await openTestPage(task, 'https://example.test/agent');
    fixture.addExternalTab('target-user', 'https://example.test/user');
    await ledger.keepUnmanaged(7, 'target-user', 'unknown');

    const receipt = await task.finish({ keep: [] });

    expect(receipt).toEqual({
      spaceId: 7,
      closedSpace: false,
      keptManagedLabels: [],
      closedManagedLabels: ['p1'],
      preservedUnmanagedCount: 1,
    });

    expect(lifecycleCalls).toEqual(['finish']);
    expect(fixture.tabs.has(String(agentPage.targetId))).toBe(false);
    expect(fixture.tabs.has('target-user')).toBe(true);
  });
});

test('TaskSpace finish validates every retained label before closing Pages', async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls: string[] = [];
    const { ledger, task } = finishFixtureTask(fixture, lifecycleCalls);
    const p1 = await openTestPage(task, 'https://example.test/one');
    const p2 = await openTestPage(task, 'https://example.test/two');

    await expect(task.finish({ keep: ['p2', 'missing'] })).rejects.toThrow(
      /page label not found: missing/,
    );

    expect(lifecycleCalls).toEqual([]);
    expect(fixture.tabs.has(String(p1.targetId))).toBe(true);
    expect(fixture.tabs.has(String(p2.targetId))).toBe(true);
    expect(Object.keys((await ledger.read(7)).pages)).toEqual(['p1', 'p2']);
  });
});

test('Page reports existing labels when an Agent uses one it never created', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    await openTestPage(task, 'https://example.test/one');

    const guessed = task.page('p2');
    expect(guessed, 'task.page returns a handle even for an unknown label').toBeTruthy();
    const error = await rejection(guessed.url());
    expect(error.message).toMatch(/^page label not found: p2\. /);
    expect(error.message).toMatch(/Managed Pages in task space 7: p1\./);
    expect(error.message).toMatch(/await task\.newPage\(\)/);
  });
});

test('Page reports a finished task when used after finish in the same round', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', {
      completeTaskSpace: () => Promise.resolve(),
    });
    const page = await openTestPage(task, 'https://example.test/one');
    await task.finish({ keep: ['p1'] });

    expect(String(await rejection(page.url()))).toMatch(
      /^Error: page label not found: p1\. Task space 7 already finished/,
    );
  });
});

test("Page reports user ownership when a later round reuses a finished task's label", async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', {
      completeTaskSpace: () => Promise.resolve(),
    });
    await openTestPage(task, 'https://example.test/one');
    await task.finish({ keep: ['p1'] });

    const nextRound = createTaskSpaceHandle(
      { id: 7, name: 'research', ownership: 'user' },
      {
        ledger: fixtureLedger(fixture),
        ...fixture.services,
      },
    );
    expect(String(await rejection(nextRound.page('p1').url()))).toMatch(
      /^Error: page label not found: p1\. Task space 7 is owned by the user/,
    );
  });
});

test('handoff preserves user-created tabs as unknown and captures the active user page', async () => {
  await withFixture(async (fixture) => {
    const firstRound = taskForRound(fixture, 'round-a', {
      handOffTaskSpace: () => Promise.resolve(),
    });
    const agentPage = await openTestPage(firstRound, 'https://example.test/agent');
    await firstRound.handOff();
    expect(agentPage.label).toBe('p1');
    fixture.addExternalTab('target-user', 'https://example.test/user-created', {
      active: true,
    });

    const afterTakeover = taskForRound(fixture, 'round-b');
    await captureTaskSpaceUserBoundary(afterTakeover);
    const userPage = afterTakeover.userPage();
    expect(userPage, 'takeover captures the tab the user was viewing').toBeTruthy();
    expect(userPage?.targetId).toBe('target-user');
    expect(userPage?.openedBy).toBe('unknown');

    const inventory = await afterTakeover.tabs();
    const userItem = inventory.find((item) => item.targetId === 'target-user');
    expect(userItem?.label).toBeUndefined();
    expect(userItem?.openedBy).toBe('unknown');

    fixture.addExternalTab('target-popup', 'https://example.test/agent-popup');
    const reconciled = await afterTakeover.tabs();
    expect(reconciled.find((item) => item.targetId === 'target-popup')?.openedBy).toBe('agent');
  });
});

test('failed native handoff removes the pending user-control boundary', async () => {
  await withFixture(async (fixture) => {
    const ledger = fixtureLedger(fixture);
    const task = taskForRound(fixture, 'round-a', {
      ledger,
      handOffTaskSpace: () => Promise.reject(new Error('native handoff failed')),
    });
    await openTestPage(task, 'https://example.test/agent');

    await expect(task.handOff()).rejects.toThrow(/native handoff failed/);
    expect((await ledger.read(7)).userControlPending).toBe(false);
  });
});

test('TaskSpace keeps Page state when native finish fails', async () => {
  await withFixture(async (fixture) => {
    const ledger = fixtureLedger(fixture);
    const task = taskForRound(fixture, 'round-a', {
      ledger,
      completeTaskSpace: () => Promise.reject(new Error('native finish failed')),
    });
    await openTestPage(task, 'https://example.test/managed');

    await expect(task.finish({ keep: 'all' })).rejects.toThrow(/native finish failed/);

    expect((await ledger.read(7)).pages).toEqual({
      p1: { targetId: 'target-1', openedBy: 'agent' },
    });
  });
});

test('a page label restores in a new round and goto reuses its target', async () => {
  await withFixture(async (fixture) => {
    const firstRound = taskForRound(fixture, 'round-a');
    const created = await openTestPage(firstRound, 'https://example.test/first');

    expect(created.label).toBe('p1');
    expect(created.spaceId).toBe(7);
    expect(created.targetId).toBe('target-1');
    expect(created.openedBy).toBe('agent');
    expect(fixture.tabs.size).toBe(1);

    const secondRound = taskForRound(fixture, 'round-b');
    const restored = secondRound.page('p1');
    const receipt = await restored.goto('https://example.test/second');

    expect(restored.targetId).toBe('target-1');
    expect(fixture.tabs.size, 'goto must not create a second tab').toBe(1);
    expect(fixture.tabs.get('target-1')?.url).toBe('https://example.test/second');
    expect(receipt).toEqual({});
    expect(await restored.snapshot()).toMatch(
      /\[p1 .*space "research"\(7\).*\]\nsnapshot:https:\/\/example\.test\/second/,
    );
  });
});

test('Page.goto accepts Playwright-style navigation options', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');
    fixture.setDocumentLifecycle({
      readyState: 'interactive',
      domContentLoaded: true,
    });
    fixture.calls.length = 0;

    await page.goto('https://example.test/second', {
      referer: 'https://example.test/source',
      timeout: 250,
      waitUntil: 'domcontentloaded',
    });

    const navigation = cdpCalls(fixture).find(({ method }) => method === 'Page.navigate');
    expect([navigation?.params, navigation?.sessionId]).toEqual([
      {
        url: 'https://example.test/second',
        referrer: 'https://example.test/source',
      },
      'session:target-1',
    ]);
  });
});

test('Page.goto commit waits for this navigation without waiting for the DOM', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let nowMs = 5_000;
    let committed = false;
    let commitChecks = 0;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp(async (method, params, sessionId, timeoutMs) => {
        if (method === 'Page.navigate') {
          await forward(baseCdp, method, params, sessionId, timeoutMs);
          return { frameId: 'frame-1', loaderId: 'loader-new' };
        }
        if (method === 'Page.getFrameTree') {
          commitChecks += 1;
          return frameTree(committed ? 'loader-new' : 'loader-old');
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
      now: () => nowMs,
      sleep(ms) {
        nowMs += ms;
        committed = true;
        return Promise.resolve();
      },
    });
    const page = await openTestPage(task, 'https://example.test/first');
    commitChecks = 0;
    committed = false;
    fixture.setDocumentLifecycle({
      readyState: 'loading',
      domContentLoaded: false,
    });
    const callsBeforeGoto = fixture.calls.length;

    await page.goto('https://example.test/second', {
      timeout: 250,
      waitUntil: 'commit',
    });

    expect(
      commitChecks,
      'one frame check records the previous document, two wait for the commit',
    ).toBe(3);
    expect(
      fixture.calls
        .slice(callsBeforeGoto)
        .some(([kind, method]) => kind === 'cdp' && method === 'Runtime.evaluate'),
      'commit must not wait for DOM readiness',
    ).toBe(false);
  });
});

test('Page.goto starts network tracking before a network-idle navigation', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');
    const callsBeforeGoto = fixture.calls.length;

    await page.goto('https://example.test/second', {
      timeout: 1_000,
      waitUntil: 'networkidle',
    });

    const methods = fixture.calls
      .slice(callsBeforeGoto)
      .filter(([kind]) => kind === 'cdp')
      .map(([, method]) => method);
    expect(methods.indexOf('Network.enable')).toBeLessThan(methods.indexOf('Page.navigate'));
    expect(
      methods.includes('Network.disable'),
      'continuous tracking must remain enabled for requests that start before a later wait',
    ).toBe(false);
  });
});

test('Page.goto timeout distinguishes a committed usable document', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');
    fixture.setDocumentLifecycle({
      readyState: 'loading',
      domContentLoaded: false,
    });

    const error = await navigationTimeout(
      page.goto('https://example.test/streaming', {
        timeout: 100,
        waitUntil: 'load',
      }),
    );
    expect(error.code).toBe('EGO_NAVIGATION_TIMEOUT');
    expect(error.committed).toBe(true);
    expect(error.url).toBe('https://example.test/streaming');
    expect(error.readyState).toBe('loading');
    expect(error.message).toMatch(/navigation committed/);
    expect(error.message).toMatch(/waitForLoadState\("load"\)/);
  });
});

test('Page.goto timeout reports when no new document committed', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let nowMs = 0;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        if (method === 'Page.navigate' && params.url === 'https://example.test/never-committed') {
          nowMs = 100;
          throw timeout(method, timeoutMs, sessionId);
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
      now: () => nowMs,
    });
    const page = await openTestPage(task, 'https://example.test/first');
    nowMs = 0;

    const error = await navigationTimeout(
      page.goto('https://example.test/never-committed', {
        timeout: 100,
        waitUntil: 'load',
      }),
    );
    expect(error.code).toBe('EGO_NAVIGATION_TIMEOUT');
    expect(error.committed).toBe(false);
    expect(error.url).toBeUndefined();
    expect(error.readyState).toBeUndefined();
    expect(error.message).not.toMatch(/Continue on this Page/);
  });
});

test('Page.goto stops a navigation that has not committed by its timeout', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let nowMs = 0;
    let held = false;
    const stops: { sessionId: string | undefined; timeoutMs: number | undefined }[] = [];
    let frameChecksAfterStop = 0;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp(async (method, params, sessionId, timeoutMs) => {
        if (method === 'Page.navigate') {
          const response = await forward(baseCdp, method, params, sessionId, timeoutMs);
          if (params.url !== 'https://example.test/held') return response;
          // Chromium answers Page.navigate only once the response arrives.
          held = true;
          nowMs += timeoutMs ?? 0;
          throw timeout(method, timeoutMs, sessionId);
        }
        if (method === 'Page.stopLoading') {
          stops.push({ sessionId, timeoutMs });
          held = false;
          return {};
        }
        if (method === 'Page.getFrameTree') {
          if (held) throw timeout(method, timeoutMs, sessionId);
          if (stops.length > 0) frameChecksAfterStop += 1;
          return frameTree('loader-old');
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
      now: () => nowMs,
      sleep(ms) {
        nowMs += ms;
        return Promise.resolve();
      },
    });
    const page = await openTestPage(task, 'https://example.test/first');
    nowMs = 0;

    const error = await navigationTimeout(
      page.goto('https://example.test/held', {
        timeout: 100,
        waitUntil: 'load',
      }),
    );
    expect(error.code).toBe('EGO_NAVIGATION_TIMEOUT');
    expect(error.committed).toBe(false);
    expect(error.stopped).toBe(true);
    expect(error.url).toBeUndefined();
    expect(error.message).toMatch(
      /^page\.goto timed out after 100ms waiting for load; the navigation to "https:\/\/example\.test\/held" had not committed and was stopped, so the Page still shows its previous document\./,
    );
    expect(error.message).toMatch(/Retry page\.goto\(url, \{ timeout \}\)/);
    expect(error.message).toMatch(/task\.newPage\(\)/);
    expect(stops.length, 'the pending navigation is stopped once').toBe(1);
    expect(typeof stops[0]?.sessionId).toBe('string');
    expect(stops[0]?.timeoutMs, 'stopping never waits a transport timeout').toBe(1_000);
    expect(
      frameChecksAfterStop,
      'the Page is confirmed responsive after the navigation stops',
    ).toBe(1);
  });
});

test('Page.goto names a pending navigation it could not stop', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let nowMs = 0;
    let held = false;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp(async (method, params, sessionId, timeoutMs) => {
        if (method === 'Page.navigate') {
          const response = await forward(baseCdp, method, params, sessionId, timeoutMs);
          if (params.url !== 'https://example.test/held') return response;
          held = true;
          nowMs += timeoutMs ?? 0;
          throw timeout(method, timeoutMs, sessionId);
        }
        if (method === 'Page.stopLoading') {
          throw timeout(method, timeoutMs, sessionId);
        }
        if (method === 'Page.getFrameTree') {
          if (held) throw timeout(method, timeoutMs, sessionId);
          return frameTree('loader-old');
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
      now: () => nowMs,
      sleep(ms) {
        nowMs += ms;
        return Promise.resolve();
      },
    });
    const page = await openTestPage(task, 'https://example.test/first');
    nowMs = 0;

    const error = await navigationTimeout(
      page.goto('https://example.test/held', {
        timeout: 100,
        waitUntil: 'load',
      }),
    );
    expect(error.code).toBe('EGO_NAVIGATION_TIMEOUT');
    expect(error.committed).toBe(false);
    expect(error.stopped).toBe(false);
    expect(error.message).toMatch(
      /the navigation to "https:\/\/example\.test\/held" has not committed and the Page did not answer even after Page\.stopLoading, so its renderer is probably hung/,
    );
    expect(error.message).toMatch(/task\.newPage\(\)/);
    expect(error.message).not.toMatch(/was stopped/);
  });
});

test('Page.goto reports a navigation that commits while it is being stopped', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let nowMs = 0;
    let held = false;
    let loaderId = 'loader-old';
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp(async (method, params, sessionId, timeoutMs) => {
        if (method === 'Page.navigate') {
          const response = await forward(baseCdp, method, params, sessionId, timeoutMs);
          if (params.url !== 'https://example.test/held') return response;
          held = true;
          nowMs += timeoutMs ?? 0;
          throw timeout(method, timeoutMs, sessionId);
        }
        if (method === 'Page.stopLoading') {
          // The response arrived just before the stop: the new document is
          // in place by the time the Page answers again.
          held = false;
          loaderId = 'loader-new';
          return {};
        }
        if (method === 'Page.getFrameTree') {
          if (held) throw timeout(method, timeoutMs, sessionId);
          return frameTree(loaderId);
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
      now: () => nowMs,
      sleep(ms) {
        nowMs += ms;
        return Promise.resolve();
      },
    });
    const page = await openTestPage(task, 'https://example.test/first');
    nowMs = 0;

    const error = await navigationTimeout(
      page.goto('https://example.test/held', {
        timeout: 100,
        waitUntil: 'load',
      }),
    );
    expect(error.code).toBe('EGO_NAVIGATION_TIMEOUT');
    expect(error.committed).toBe(true);
    expect(error.stopped).toBe(true);
    expect(error.message).toMatch(
      /navigation committed at "https:\/\/example\.test\/held".*but its loading was stopped at the deadline\. Call page\.reload\(\{ timeout \}\)/,
    );
    expect(error.message).not.toMatch(/previous document/);
  });
});

test('Page.goto does not stop anything when its budget ends before Page.navigate', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let nowMs = 0;
    let stops = 0;
    let navigates = 0;
    let armed = false;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        if (method === 'Page.getFrameTree' && armed) {
          // The pre-navigation probe is the last thing the budget covers.
          nowMs += timeoutMs ?? 0;
          throw timeout(method, timeoutMs, sessionId);
        }
        if (method === 'Page.navigate' && armed) navigates += 1;
        if (method === 'Page.stopLoading') stops += 1;
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
      now: () => nowMs,
      sleep(ms) {
        nowMs += ms;
        return Promise.resolve();
      },
    });
    const page = await openTestPage(task, 'https://example.test/first');
    nowMs = 0;
    armed = true;

    const error = await navigationTimeout(
      page.goto('https://example.test/never-sent', {
        timeout: 100,
        waitUntil: 'load',
      }),
    );
    expect(error.code).toBe('EGO_NAVIGATION_TIMEOUT');
    expect(error.committed).toBe(false);
    expect(error.stopped).toBe(false);
    expect(error.message).not.toMatch(/pending|stopped|hung/);
    expect(navigates, 'Page.navigate was never dispatched').toBe(0);
    expect(stops, 'nothing in flight belongs to this call').toBe(0);
  });
});

test('Page.goto timeout on a responsive Page does not stop anything', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let nowMs = 0;
    let stops = 0;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp(async (method, params, sessionId, timeoutMs) => {
        if (method === 'Page.navigate') {
          const response = await forward(baseCdp, method, params, sessionId, timeoutMs);
          if (params.url !== 'https://example.test/answering') return response;
          return { frameId: 'frame-1', loaderId: 'loader-new' };
        }
        if (method === 'Page.stopLoading') {
          stops += 1;
          return {};
        }
        if (method === 'Page.getFrameTree') {
          return frameTree('loader-old');
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
      now: () => nowMs,
      sleep(ms) {
        nowMs += ms;
        return Promise.resolve();
      },
    });
    const page = await openTestPage(task, 'https://example.test/first');
    nowMs = 0;

    const error = await navigationTimeout(
      page.goto('https://example.test/answering', {
        timeout: 100,
        waitUntil: 'load',
      }),
    );
    expect(error.code).toBe('EGO_NAVIGATION_TIMEOUT');
    expect(error.committed).toBe(false);
    expect(error.stopped).toBe(false);
    expect(error.message).not.toMatch(/pending|stopped/);
    expect(stops, 'a Page that answers has nothing to stop').toBe(0);
  });
});

test('Page.goto performs one final loader check at the timeout boundary', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let nowMs = 0;
    let frameChecks = 0;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp(async (method, params, sessionId, timeoutMs) => {
        if (method === 'Page.navigate') {
          await forward(baseCdp, method, params, sessionId, timeoutMs);
          return { frameId: 'frame-1', loaderId: 'loader-new' };
        }
        if (method === 'Page.getFrameTree') {
          frameChecks += 1;
          return frameTree(frameChecks >= 3 ? 'loader-new' : 'loader-old');
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
      now: () => nowMs,
      sleep(ms) {
        nowMs += ms;
        return Promise.resolve();
      },
    });
    const page = await openTestPage(task, 'https://example.test/first');
    nowMs = 0;
    frameChecks = 0;
    fixture.setDocumentLifecycle({
      readyState: 'loading',
      domContentLoaded: false,
    });

    const error = await navigationTimeout(
      page.goto('https://example.test/boundary', {
        timeout: 100,
        waitUntil: 'load',
      }),
    );
    expect(error.committed).toBe(true);
    expect(error.url).toBe('https://example.test/boundary');
    expect(frameChecks).toBe(3);
  });
});

test('Page.reload reloads the current document and waits for the requested state', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let loaderId = 'loader-old';
    let reloading = false;
    let postReloadChecks = 0;
    let reloadParams: unknown;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        if (method === 'Page.getFrameTree') {
          if (reloading) {
            postReloadChecks += 1;
            if (postReloadChecks >= 2) loaderId = 'loader-new';
          }
          return frameTree(loaderId);
        }
        if (method === 'Page.reload') {
          reloadParams = params;
          reloading = true;
          return {};
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
    });
    const page = await openTestPage(task, 'https://example.test/first');
    fixture.setDocumentLifecycle({
      readyState: 'interactive',
      domContentLoaded: true,
    });
    expect(await page.reload({ timeout: 250, waitUntil: 'domcontentloaded' })).toEqual({});
    expect(reloadParams).toEqual({ loaderId: 'loader-old' });
    expect(postReloadChecks, 'reload waits for a new main-frame loader').toBe(2);
  });
});

test('Page.reload stops a reload that has not committed by its timeout', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let nowMs = 0;
    let held = false;
    let stops = 0;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        if (method === 'Page.getFrameTree') {
          if (held) throw timeout(method, timeoutMs, sessionId);
          return frameTree('loader-old');
        }
        if (method === 'Page.reload') {
          held = true;
          return {};
        }
        if (method === 'Page.stopLoading') {
          stops += 1;
          held = false;
          return {};
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
      now: () => nowMs,
      sleep(ms) {
        nowMs += ms;
        return Promise.resolve();
      },
    });
    const page = await openTestPage(task, 'https://example.test/first');

    await expect(page.reload({ timeout: 100, waitUntil: 'commit' })).rejects.toThrow(
      /page\.reload timed out after 100ms waiting for commit; the reload had not committed and was stopped, so the Page still shows its previous document\. Retry page\.reload\(\{ timeout \}\)/,
    );
    expect(stops, 'the pending reload is stopped').toBe(1);
  });
});

test('newPage creates a managed blank Page and leaves navigation to goto', async () => {
  await withFixture(async (fixture) => {
    const requestedUrl = 'https://example.test/created-document';
    const task = taskForRound(fixture, 'round-a');

    const page = await task.newPage();

    expect(fixture.tabs.get(String(page.targetId))?.url).toBe('about:blank');
    expect(page.label).toBe('p1');

    await page.goto(requestedUrl);
    expect(fixture.tabs.get(String(page.targetId))?.url).toBe(requestedUrl);
  });
});

test('snapshot activates the addressed page, not whichever tab was current', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const first = await openTestPage(task, 'https://example.test/first');
    await openTestPage(task, 'https://example.test/second');

    expect(fixture.activeTarget()).toBe('target-2');
    expect(await first.snapshot()).toMatch(
      /\[p1 .*space "research"\(7\).*\]\nsnapshot:https:\/\/example\.test\/first/,
    );
    expect(fixture.activeTarget()).toBe('target-1');
  });
});

test('snapshot defaults to the viewport, reports its source, and validates options', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/before');

    expect(await page.snapshot()).toMatch(/snapshot:https:\/\/example\.test\/before/);
    // PiArc: the snapshot binding also receives the Page's target.
    expect(fixture.snapshotOptions.at(-1)).toEqual({
      scope: 'only_within_viewport',
      includeActionMarks: true,
      includeStableLocator: true,
      targetId: page.targetId,
    });

    await page.snapshot({ scope: 'full_page' });
    expect(fixture.snapshotOptions.at(-1)).toEqual({
      scope: 'full_page',
      includeActionMarks: true,
      includeStableLocator: true,
      targetId: page.targetId,
    });

    expect(await page.snapshot({ scope: 'subtree', root: '@21' })).toMatch(
      /snapshot:https:\/\/example\.test\/before/,
    );
    expect(fixture.snapshotOptions.at(-1)).toEqual({
      scope: 'subtree',
      root: 21,
      includeActionMarks: true,
      includeStableLocator: true,
      targetId: page.targetId,
    });

    await expect(page.snapshot({ scope: 'subtree' })).rejects.toThrow(
      /page\.snapshot subtree scope requires root to be a snapshot ref such as @21/,
    );
    await expect(page.snapshot({ scope: 'full_page', root: '@21' })).rejects.toThrow(
      /page\.snapshot root is only supported when scope is subtree/,
    );
    await expect(page.snapshot({ scope: 'subtree', root: 'css:#target' })).rejects.toThrow(
      /page\.snapshot root must be a snapshot ref such as @21/,
    );
    await expect(page.snapshot({ scope: 'subtree', root: '@999' })).rejects.toThrow(
      /Unknown ref: 999/,
    );

    await expect(page.snapshot(untyped({ diff: true }))).rejects.toThrow(
      /page\.snapshot received unknown option: diff/,
    );
  });
});

// Upstream's "a viewport snapshot reports content outside the viewport" and "a viewport
// snapshot stays silent when the document fits the viewport" are not ported: PiArc removed the
// SDK's viewport-overflow hint because the main process's snapshot prints it.

test('viewport snapshots preserve native iframe contents and refs', async () => {
  for (const options of [{}, { scope: 'only_within_viewport' as const }]) {
    await withFixture(async (fixture) => {
      const content = [
        'root',
        '  button "Host action" [ref=1]',
        '  iframe [ref=11]',
        '    root',
        '      button "Frame action" [ref=21]',
        '      iframe [ref=31]',
        '        root',
        '          button "Nested OOPIF action" [ref=41]',
        '  text "Host sibling"',
      ].join('\n');
      const task = taskForRound(fixture, 'round-a', {
        cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
          if (method === 'DOM.getFrameOwner') return { backendNodeId: 99 };
          if (method === 'DOM.getBoxModel') {
            return { model: { content: [0, 0, 400, 0, 400, 300, 0, 300] } };
          }
          return fixture.services.cdp(method, params, sessionId, timeoutMs);
        }),
        ensureFrameSessions() {
          return Promise.resolve(
            new Map([
              ['frame-same', 'session:target-1'],
              ['frame-oopif', 'session:oopif'],
            ]),
          );
        },
        snapshot() {
          return Promise.resolve({
            content,
            refs: [
              { refId: 1, backendNodeId: 1, role: 'button' },
              { refId: 11, backendNodeId: 11, role: 'iframe' },
              {
                refId: 21,
                backendNodeId: 21,
                role: 'button',
                frameId: 'frame-same',
              },
              {
                refId: 31,
                backendNodeId: 31,
                role: 'iframe',
                frameId: 'frame-same',
              },
              {
                refId: 41,
                backendNodeId: 21,
                role: 'button',
                frameId: 'frame-oopif',
              },
            ],
          });
        },
      });
      const page = await openTestPage(task, 'https://example.test/iframe-host');

      expect((await page.snapshot(options)).split('\n').slice(1).join('\n')).toBe(content);
      const refs = fixture.services.pageRefs.forTarget(String(page.targetId));
      expect([...refs.map.keys()]).toEqual(['1', '11', '21', '31', '41']);
      expect(refs.get('21')?.frameId).toBe('frame-same');
      expect(refs.get('41')?.frameId).toBe('frame-oopif');
      expect(refs.get('41')?.backendNodeId).toBe(21);

      for (const [ref, expectedSession] of [
        ['@21', 'session:target-1'],
        ['@41', 'session:oopif'],
      ] as const) {
        await page.snapshot(options);
        const beforeAction = cdpCalls(fixture).length;
        await page.click(ref);
        const actionCalls = cdpCalls(fixture).slice(beforeAction);
        const resolutions = actionCalls.filter(
          ({ method, params }) => method === 'DOM.resolveNode' && params.backendNodeId === 21,
        );
        expect(resolutions.length, `${ref} resolves its native node`).toBeGreaterThan(0);
        expect(
          resolutions.every(({ sessionId }) => sessionId === expectedSession),
          `${ref} resolves the colliding backendNodeId only in its own frame`,
        ).toBe(true);
        expect(
          actionCalls.some(
            ({ method, params, sessionId }) =>
              method === 'Input.dispatchMouseEvent' &&
              params.type === 'mouseReleased' &&
              sessionId === expectedSession,
          ),
          `${ref} dispatches its click in the expected session`,
        ).toBe(true);
      }
    });
  }
});

test('a viewport snapshot preserves previously registered offscreen iframe refs', async () => {
  await withFixture(async (fixture) => {
    const snapshotFixture = ({ scope }: EgoSnapshotOptions) => {
      if (scope === 'only_within_viewport') {
        return Promise.resolve({ content: 'root\n  heading "Host"', refs: [] });
      }
      return Promise.resolve({
        content: [
          'root',
          '  heading "Host"',
          '  iframe [ref=11]',
          '    root',
          '      button "Hidden frame action" [ref=21]',
        ].join('\n'),
        refs: [
          { refId: 11, backendNodeId: 11, role: 'iframe' },
          { refId: 21, backendNodeId: 21, role: 'button' },
        ],
      });
    };
    const task = taskForRound(fixture, 'round-a', {
      snapshot: snapshotFixture,
    });
    const page = await openTestPage(task, 'https://example.test/iframe-host');
    const targetId = String(page.targetId);
    await page.snapshot({ scope: 'full_page' });
    expect(
      fixture.services.pageRefs.forTarget(targetId).get('21')?.backendNodeId,
      'the full snapshot initially advertises the iframe descendant',
    ).toBe(21);

    const snapshot = await page.snapshot();

    expect(snapshot).not.toMatch(/iframe \[ref=/);
    expect(snapshot).not.toMatch(/Hidden frame action/);
    expect(fixture.services.pageRefs.forTarget(targetId).get('11')?.backendNodeId).toBe(11);
    expect(
      fixture.services.pageRefs.forTarget(targetId).get('21')?.backendNodeId,
      'a partial viewport snapshot must not invalidate an omitted ref',
    ).toBe(21);
    expect(fixture.services.pageRefs.isInvalidated(targetId, '21')).toBe(false);
  });
});

test('a subtree snapshot preserves refs outside the observed subtree', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', {
      snapshot(options) {
        if (options.scope === 'full_page') {
          return Promise.resolve({
            content: ['root', '  button "First" [ref=21]', '  button "Second" [ref=22]'].join('\n'),
            refs: [
              { refId: 21, backendNodeId: 21, role: 'button', name: 'First' },
              { refId: 22, backendNodeId: 22, role: 'button', name: 'Second' },
            ],
          });
        }
        return Promise.resolve({
          content: ['button "First" [ref=21]'].join('\n'),
          refs: [{ refId: 21, backendNodeId: 21, role: 'button', name: 'First' }],
        });
      },
    });
    const page = await openTestPage(task, 'https://example.test/two-actions');
    const targetId = String(page.targetId);
    await page.snapshot({ scope: 'full_page' });

    await page.snapshot({ scope: 'subtree', root: '@21' });

    expect(fixture.services.pageRefs.forTarget(targetId).get('22')?.backendNodeId).toBe(22);
    expect(fixture.services.pageRefs.isInvalidated(targetId, '22')).toBe(false);
  });
});

test('subtree snapshots preserve saved sibling roots when native refs are reused', async () => {
  await withFixture(async (fixture) => {
    const requestedRoots: (number | undefined)[] = [];
    const task = taskForRound(fixture, 'round-a', {
      snapshot(options) {
        if (options.scope !== 'subtree') {
          return Promise.resolve({
            content: 'root\n  iframe [ref=1]\n  iframe [ref=2]',
            refs: [
              { refId: 1, backendNodeId: 35, role: 'iframe' },
              { refId: 2, backendNodeId: 36, role: 'iframe' },
            ],
          });
        }
        requestedRoots.push(options.root);
        return Promise.resolve({
          content: 'iframe [ref=1]\n  button "First frame action" [ref=2]',
          refs: [
            ...(options.root === undefined
              ? []
              : [{ refId: 1, backendNodeId: options.root, role: 'iframe' }]),
            {
              refId: 2,
              backendNodeId: 43,
              role: 'button',
              frameId: 'frame-child',
            },
          ],
        });
      },
    });
    const page = await openTestPage(task, 'https://example.test/siblings');
    await page.snapshot();
    const first = await page.snapshot({ scope: 'subtree', root: '@1' });
    expect(first).not.toMatch(/button.*\[ref=2\]/);
    await page.snapshot({ scope: 'subtree', root: '@2' });
    expect(requestedRoots).toEqual([35, 36]);
  });
});

test('a subtree snapshot inherits the root ref frame provenance', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', {
      ensureFrameSessions() {
        return Promise.resolve(new Map([['frame-child', 'session:target-1']]));
      },
      snapshot(options) {
        if (options.scope === 'full_page') {
          return Promise.resolve({
            content: [
              'root',
              '  iframe [ref=11]',
              '    root',
              '      button "Frame root" [ref=21]',
            ].join('\n'),
            refs: [
              { refId: 11, backendNodeId: 11, role: 'iframe' },
              {
                refId: 21,
                backendNodeId: 21,
                role: 'button',
                name: 'Frame root',
              },
            ],
          });
        }
        return Promise.resolve({
          content: ['button "Frame root" [ref=21]', '  link "Frame child" [ref=22]'].join('\n'),
          refs: [
            {
              refId: 21,
              backendNodeId: 21,
              role: 'button',
              name: 'Frame root',
            },
            {
              refId: 22,
              backendNodeId: 22,
              role: 'link',
              name: 'Frame child',
            },
          ],
        });
      },
    });
    const page = await openTestPage(task, 'https://example.test/frame');
    await page.snapshot({ scope: 'full_page' });

    await page.snapshot({ scope: 'subtree', root: '@21' });

    expect(fixture.services.pageRefs.forTarget(String(page.targetId)).get('22')).toStrictEqual({
      backendNodeId: 22,
      role: 'link',
      name: 'Frame child',
      nth: undefined,
      frameId: 'frame-child',
      frameProvenance: 'frame',
    });
  });
});

for (const expression of ['document.title', () => document.title]) {
  test(`Page evaluate preserves snapshot refs for a read-only ${typeof expression}`, async () => {
    await withFixture(async (fixture) => {
      const task = taskForRound(fixture, 'round-a');
      const page = await openTestPage(task, 'https://example.test/select');
      await page.snapshot({ scope: 'full_page' });
      await page.evaluate(expression);

      expect(await page.selectOption('@21', 'nl')).toEqual(['nl']);
      expect(
        fixture.calls.filter(([kind]) => kind === 'snapshot').length,
        'reading the Page must not require a new snapshot',
      ).toBe(1);
      expect(
        cdpCalls(fixture).find(({ method }) => method === 'DOM.resolveNode')?.params.backendNodeId,
      ).toBe(21);
    });
  });
}

test('read-only evaluate preserves a published ref across Agent rounds', async () => {
  await withFixture(async (fixture) => {
    const page = await openTestPage(
      taskForRound(fixture, 'round-a'),
      'https://example.test/select',
    );
    await page.snapshot();
    const inspected = taskForRound(fixture, 'round-b', {
      pageRefs: new PageRefRegistry(),
    }).page(page.label);
    await inspected.evaluate('document.title');
    const restored = taskForRound(fixture, 'round-c', {
      pageRefs: new PageRefRegistry(),
    }).page(page.label);

    expect(await restored.selectOption('@21', 'nl')).toEqual(['nl']);
    expect(
      fixture.calls.filter(([kind]) => kind === 'snapshot').length,
      'each round must reuse the original published mapping',
    ).toBe(1);
    expect(
      cdpCalls(fixture).find(({ method }) => method === 'DOM.resolveNode')?.params.backendNodeId,
    ).toBe(21);
  });
});

test('subtree snapshot resolves its root in the addressed Page', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const first = await openTestPage(task, 'https://example.test/first');
    const second = await openTestPage(task, 'https://example.test/second');

    await first.snapshot();
    await second.snapshot();
    expect(fixture.activeTarget()).toBe('target-2');

    expect(await first.snapshot({ scope: 'subtree', root: 'ref=21' })).toMatch(
      /\[p1 .*space "research"\(7\).*\]\nsnapshot:https:\/\/example\.test\/first/,
    );
    expect(fixture.activeTarget()).toBe('target-1');
    expect(fixture.snapshotOptions.at(-1)).toEqual({
      scope: 'subtree',
      root: 21,
      includeActionMarks: true,
      includeStableLocator: true,
      targetId: first.targetId,
    });
  });
});

/** The session of a recorded Page call: `cdp` entries carry it fourth, `screenshot` third. */
function pageCallSession(call: FixtureCall): unknown {
  const [kind] = call;
  if (kind === 'cdp') return call[3];
  if (kind === 'screenshot') return call[2];
  return undefined;
}

test('metadata reads stay target-scoped while evaluate and screenshot activate their Page', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const first = await openTestPage(task, 'https://example.test/first');
    await openTestPage(task, 'https://example.test/second');

    expect(fixture.activeTarget()).toBe('target-2');
    expect(await first.url()).toBe('https://example.test/first');
    expect(await first.title()).toBe('https://example.test/first');
    expect(await first.info()).toEqual({
      url: 'https://example.test/first',
      title: 'https://example.test/first',
      w: 801,
      h: 600,
      sx: 0,
      sy: 0,
      pw: 1200,
      ph: 900,
    });
    expect(fixture.activeTarget(), 'metadata reads must not activate the addressed page').toBe(
      'target-2',
    );
    expect(await first.evaluate((value) => value, { source: 'first' })).toEqual({
      source: 'first',
    });
    expect(
      fixture.activeTarget(),
      'page.evaluate must activate the page whose JavaScript it runs',
    ).toBe('target-1');
    // PiArc: the capture is attached to the tool result instead of written to a path.
    expect(await first.screenshot({ fullPage: true })).toEqual({
      image: 1,
      width: 800,
      height: 600,
    });
    expect(
      fixture.calls.some(
        (call) =>
          call[0] === 'screenshot' &&
          isRecord(call[1]) &&
          call[1].full === true &&
          !Object.hasOwn(call[1], 'fullPage') &&
          call[2] === 'session:target-1',
      ),
      'page.screenshot must map Playwright-style options to the capture driver',
    ).toBe(true);
    await expect(first.screenshot(untyped({ scale: 'device' }))).rejects.toThrow(
      /scale must be one of css/,
    );
    expect(await first.screenshot({ scale: 'css' })).toEqual({
      image: 1,
      width: 800,
      height: 600,
    });
    expect(
      fixture.calls.some(
        (call) =>
          call[0] === 'screenshot' &&
          isRecord(call[1]) &&
          call[1].scale === 'css' &&
          call[2] === 'session:target-1',
      ),
      'page.screenshot must forward the explicit scale mode',
    ).toBe(true);
    await expect(first.screenshot(untyped('/tmp/legacy.png'))).rejects.toThrow(
      /options must be an object/,
    );
    // PiArc: every path is refused (upstream rejected relative ones and wrote absolute ones).
    const capturesBeforePaths = fixture.calls.filter(([kind]) => kind === 'screenshot').length;
    for (const path of ['/tmp/first.png', './step1-initial.png', 'shots/before.png', '']) {
      await expect(
        first.screenshot({ path, fullPage: true }),
        `page.screenshot must refuse the path ${JSON.stringify(path)}`,
      ).rejects.toThrow(/does not write files: the image is already attached to the tool result/);
    }
    expect(
      fixture.calls.filter(([kind]) => kind === 'screenshot').length,
      'refused screenshot paths must be rejected before capture',
    ).toBe(capturesBeforePaths);
    expect(fixture.activeTarget(), 'screenshot must activate the page before visual capture').toBe(
      'target-1',
    );

    const pageCalls = fixture.calls.filter(
      (call) =>
        (call[0] === 'cdp' || call[0] === 'screenshot') &&
        pageCallSession(call) === 'session:target-1',
    );
    expect(pageCalls.length).toBeGreaterThanOrEqual(5);
    expect(pageCalls.every((call) => pageCallSession(call) === 'session:target-1')).toBe(true);
    const pageEvaluation = cdpCalls(fixture).find(
      ({ method, params, sessionId }) =>
        sessionId === 'session:target-1' &&
        method === 'Runtime.evaluate' &&
        String(params.expression).includes('__egoPageEvaluate'),
    );
    expect(String(pageEvaluation?.params.expression)).toMatch(/value.*=> value/);
    expect(String(pageEvaluation?.params.expression)).toMatch(/source/);
    expect(
      cdpCalls(fixture).some(
        ({ method, sessionId }) =>
          sessionId === 'session:target-1' && method === 'Runtime.callFunctionOn',
      ),
    ).toBe(false);
  });
});

test('Page evaluate rejects ambiguous or non-serializable arguments', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/evaluate');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(page.evaluate('document.title', { ignored: true })).rejects.toThrow(
      /string expression does not accept an argument/,
    );
    await expect(page.evaluate((value) => value, cyclic)).rejects.toThrow(
      /argument must be JSON-serializable/,
    );
    await expect(page.evaluate(untyped(42))).rejects.toThrow(
      /expects a function or string expression/,
    );
  });
});

test('Page evaluate follows JSON omission rules in one CDP request', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/evaluate');
    fixture.calls.length = 0;

    const result = await page.evaluate((value) => value, {
      kept: 1,
      omitted: undefined,
      list: [undefined, 'ready'],
    });

    expect(result).toEqual({ kept: 1, list: [null, 'ready'] });
    const evaluationCalls = cdpCalls(fixture).filter(
      ({ method }) =>
        method === 'Runtime.evaluate' ||
        method === 'Runtime.callFunctionOn' ||
        method === 'Runtime.releaseObject',
    );
    expect(evaluationCalls).toHaveLength(1);
    expect(evaluationCalls[0]?.method).toBe('Runtime.evaluate');
    expect(String(evaluationCalls[0]?.params.expression)).toMatch(/__egoPageEvaluate/);
  });
});
