// Ported from ego-browser package/ego-browser/src/page-model.test.mjs (ego-lite commit 56589ea8,
// MIT, see LICENSE). PiArc: Vitest on page-model.fixture.ts; upstream tests 167-209, from "Page
// click does not re-dispatch a gesture after its session was lost" to the end of the file.
// Screenshot overrides answer an attachment instead of a path; the foreign-target test passes its
// CDP override to the task (upstream reassigned fixture.services.cdp after the task had copied
// it, so the event never fired); CDP overrides answer the unwrapped result `services.cdp`
// promises (upstream returned the `{ result }` envelope for Page.getFrameTree).

import { expect, test } from 'vitest';

import { fakeCdp } from '../testing.js';
import { CdpRequestTimeoutError, PageUnresponsiveError } from './browser-runtime.js';
import type { CdpObject } from './cdp-types.js';
import { resetPageNotices } from './page-discovery.js';
import {
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
  type RecordedCdpCall,
} from './page-model.fixture.js';
import { createTaskSpaceHandle } from './page-model.js';

/** The `cdp` entries recorded after `start` (upstream: `fixture.calls.slice(start)`). */
function cdpCallsSince(fixture: Fixture, start: number): RecordedCdpCall[] {
  const recent: FixtureCall[] = fixture.calls.slice(start);
  return cdpCalls(fixture).slice(cdpCalls(fixture).length - countCdp(recent));
}

function countCdp(calls: FixtureCall[]): number {
  return calls.filter(([kind]) => kind === 'cdp').length;
}

function mouseEvents(fixture: Fixture, type?: string): RecordedCdpCall[] {
  return cdpCalls(fixture).filter(
    (call) =>
      call.method === 'Input.dispatchMouseEvent' &&
      (type === undefined || call.params.type === type),
  );
}

function declarationIncludes(call: RecordedCdpCall, text: string): boolean {
  const declaration = call.params.functionDeclaration;
  return typeof declaration === 'string' && declaration.includes(text);
}

/**
 * The frame tree a stopped Page answers with. PiArc: `services.cdp` answers the unwrapped
 * `result` (the `CdpCall` contract), so the override returns `{ frameTree }`; upstream returned
 * the `{ result: { frameTree } }` envelope and page-model read both shapes.
 */
function previousFrameTree(): CdpObject {
  return {
    frameTree: {
      frame: {
        id: 'frame-1',
        loaderId: 'loader-old',
        url: 'https://example.test/previous',
      },
    },
  };
}

/** A page handle's label; unmanaged handles have none (upstream reads `item.page.label`). */
function labelOf(page: object | undefined): unknown {
  return page === undefined ? undefined : Reflect.get(page, 'label');
}

test('Page click does not re-dispatch a gesture after its session was lost', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');
    fixture.loseSessionOnNextMouseRelease();

    await expect(page.click('#submit', { timeout: 1_000 })).rejects.toThrow(
      /Session with given id not found/,
    );
    expect(
      mouseEvents(fixture, 'mousePressed'),
      'a gesture that already reached the page must not be dispatched again',
    ).toHaveLength(1);
  });
});

test('Page click reports the action timeout instead of a tail discovery timeout', async () => {
  await withFixture(async (fixture) => {
    const discoveryTimeouts: (number | undefined)[] = [];
    const task = taskForRound(fixture, 'round-a', {
      async ensureFrameSessions(_targetId, timeoutMs) {
        discoveryTimeouts.push(timeoutMs);
        if (timeoutMs !== undefined && timeoutMs < 250) {
          // A discovery timeout consumes its whole budget before failing.
          await fixture.services.sleep(timeoutMs);
          throw Object.assign(new Error('CDP request timed out: Target.getTargets'), {
            code: 'EGO_CDP_REQUEST_TIMEOUT',
          });
        }
        return new Map<string, string>();
      },
    });
    const page = await openTestPage(task, 'https://example.test/first');
    fixture.rejectClickPoints(100);

    await expect(page.click('#changing', { timeout: 1_000 })).rejects.toThrow(
      /page\.click timed out after 1000ms.*not visible/i,
    );
    expect(
      discoveryTimeouts.every((timeoutMs) => timeoutMs !== undefined && timeoutMs <= 1_000),
      `frame discovery must never exceed the action timeout: ${JSON.stringify(discoveryTimeouts)}`,
    ).toBe(true);
  });
});

test('Page click retries when an iframe disappears while the element is resolved', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');
    fixture.loseFrameOnNextResolution({
      message: 'Frame with the given frameId is not found.',
    });

    expect(await page.click('#ready', { timeout: 1_000 })).toEqual({});
    expect(mouseEvents(fixture, 'mousePressed')).toHaveLength(1);
  });
});

test('Page click retries when an iframe session is lost while the element is resolved', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');
    fixture.loseFrameOnNextResolution({
      message: 'Session with given id not found',
      sessionId: 'session:frame-gone',
    });

    expect(await page.click('#ready', { timeout: 1_000 })).toEqual({});
  });
});

test('Page click fails fast when its own session is lost while the element is resolved', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');
    fixture.loseFrameOnNextResolution({
      message: 'Session with given id not found',
      sessionId: 'session:target-1',
    });

    await expect(page.click('#ready', { timeout: 1_000 })).rejects.toThrow(
      /Session with given id not found/,
    );
    expect(mouseEvents(fixture)).toHaveLength(0);
  });
});

test('Page click reports the last transient state after its timeout', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');
    fixture.rejectClickPoints(100);

    await expect(page.click('#changing', { timeout: 1_000 })).rejects.toThrow(
      /page\.click timed out after 1000ms.*not visible/i,
    );
    // The blocked target is re-examined every 50ms until the 1000ms deadline.
    expect(
      cdpCalls(fixture).filter(
        (call) =>
          call.method === 'Runtime.callFunctionOn' &&
          declarationIncludes(call, 'getBoundingClientRect'),
      ),
    ).toHaveLength(21);
    expect(mouseEvents(fixture)).toHaveLength(0);
  });
});

test('Page click waits for a temporary pointer interceptor', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');
    fixture.interceptNextClickPoint();

    expect(await page.click('#covered', { timeout: 100 })).toEqual({});
    expect(
      mouseEvents(fixture, 'mouseReleased').length,
      'input is dispatched after the overlay disappears',
    ).toBeGreaterThan(0);
  });
});

test('Page click times out while a pointer interceptor remains', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');
    fixture.interceptClickPoints(100);

    await expect(page.click('#covered', { timeout: 100 })).rejects.toThrow(
      /page\.click timed out after 100ms.*overlay.*intercepts pointer events/i,
    );
    expect(
      mouseEvents(fixture),
      'an intercepted high-level click must not dispatch any mouse input',
    ).toHaveLength(0);
  });
});

test('Page click force bypasses only the pointer interception check', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');
    fixture.interceptClickPoints(100);

    expect(await page.click('#intentionally-covered', { force: true })).toEqual({});
    expect(mouseEvents(fixture, 'mouseReleased').length).toBeGreaterThan(0);
  });
});

test('close leaves an anchor tab and the next page gets a new label', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const first = await openTestPage(task, 'https://example.test/first');

    await first.close();
    expect(fixture.tabs.has('target-1')).toBe(false);
    expect(fixture.tabs.size, 'the task space must retain an anchor tab').toBe(1);
    await expect(task.page('p1').goto('https://example.test/closed')).rejects.toThrow(
      /page p1 was closed/,
    );

    const second = await openTestPage(task, 'https://example.test/second');
    expect(second.label).toBe('p2');
    expect(second.targetId).toBe('target-3');
  });
});

test('close waits for the target to disappear before retiring its label', async () => {
  await withFixture(async (fixture) => {
    let closeRequested = false;
    let postCloseReads = 0;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        if (method === 'Target.closeTarget') {
          closeRequested = true;
          return { success: true };
        }
        return fixture.services.cdp(method, params, sessionId, timeoutMs);
      }),
      async listTabs() {
        await fixture.services.listTabs();
        if (closeRequested && ++postCloseReads === 3) {
          fixture.tabs.delete('target-1');
        }
        return [...fixture.tabs.values()];
      },
    });
    const page = await openTestPage(task, 'https://example.test/first');

    await page.close();

    expect(postCloseReads).toBe(3);
    await expect(task.page(page.label).title()).rejects.toThrow(/page p1 was closed/);
  });
});

test('close keeps the page managed when the target never disappears', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        if (method === 'Target.closeTarget') return { success: true };
        return fixture.services.cdp(method, params, sessionId, timeoutMs);
      }),
    });
    const page = await openTestPage(task, 'https://example.test/first');

    await expect(page.close()).rejects.toThrow(/did not close within 2000ms/);

    const inventory = await task.tabs();
    expect(inventory[0]?.label).toBe(page.label);
    expect(await page.title()).toBe('https://example.test/first');
  });
});

test('a ledger failure closes the newly created uncommitted tab', async () => {
  await withFixture(async (fixture) => {
    const task = createTaskSpaceHandle(
      { id: 7, name: 'research', ownership: 'agent' },
      {
        ...fixture.services,
        // Upstream passes a partial ledger: only the two methods this path reaches.
        ledger: untyped({
          reconcile() {
            return Promise.resolve({ pages: {} });
          },
          addPage() {
            return Promise.reject(new Error('ledger unavailable'));
          },
        }),
      },
    );

    await expect(openTestPage(task, 'https://example.test/uncommitted')).rejects.toThrow(
      /ledger unavailable/,
    );
    expect(fixture.tabs.size).toBe(0);
    expect(cdpCalls(fixture).some((call) => call.method === 'Target.closeTarget')).toBe(true);
  });
});

test('pages returns managed Page handles while tabs returns the complete inventory', async () => {
  await withFixture(async (fixture) => {
    fixture.tabs.set('target-user', {
      targetId: 'target-user',
      url: 'https://example.test/user',
      title: 'User page',
      active: false,
    });
    const task = taskForRound(fixture, 'round-a');
    const managed = await openTestPage(task, 'https://example.test/managed');
    fixture.tabs.set('target-popup', {
      targetId: 'target-popup',
      url: 'https://example.test/popup',
      title: 'Late popup',
      active: false,
    });

    const pages = await task.pages();
    const tabs = await task.tabs();
    const managedItem = tabs.find((item) => item.label === 'p1');
    const popupItem = tabs.find((item) => item.label === 'p2');
    const unknownItem = tabs.find((item) => item.targetId === 'target-user');

    expect(pages.map((page) => page.label)).toEqual(['p1', 'p2']);
    expect(pages.every((page) => typeof page.url === 'function')).toBe(true);
    expect(pages.some((page) => page.targetId === 'target-user')).toBe(false);
    expect(labelOf(managedItem?.page)).toBe('p1');
    expect(managedItem?.page.targetId).toBe(managed.targetId);
    expect(managedItem?.title).toBe('https://example.test/managed');
    expect(managedItem?.openedBy).toBe('agent');
    expect(labelOf(popupItem?.page)).toBe('p2');
    expect(popupItem?.openedBy).toBe('agent');
    expect(unknownItem?.label).toBeUndefined();
    expect(unknownItem?.page.targetId).toBe('target-user');
    expect(unknownItem?.page.spaceId).toBe(7);
    expect(unknownItem?.page.openedBy).toBe('unknown');
    const unknownPage: object = unmanagedPage(unknownItem);
    expect(Reflect.get(unknownPage, 'snapshot')).toBeUndefined();
    expect(Reflect.get(unknownPage, 'goto')).toBeUndefined();
    expect(Reflect.get(unknownPage, 'close')).toBeUndefined();
    expect(unknownItem?.title).toBe('User page');
    expect(unknownItem?.openedBy).toBe('unknown');
    expect(Reflect.get(task, 'listPages')).toBeUndefined();
  });
});

test('tabs automatically manages a tab created during agent control', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    await openTestPage(task, 'https://example.test/managed');
    fixture.tabs.set('target-popup', {
      targetId: 'target-popup',
      url: 'https://example.test/popup',
      title: 'Late popup',
      active: false,
    });

    const popup = (await task.tabs()).find((item) => item.targetId === 'target-popup');

    expect(popup?.label).toBe('p2');
    expect(popup?.openedBy).toBe('agent');
    expect(labelOf(popup?.page)).toBe('p2');
  });
});

test('adopt turns a live untracked page into a managed page', async () => {
  await withFixture(async (fixture) => {
    fixture.tabs.set('target-user', {
      targetId: 'target-user',
      url: 'https://example.test/user',
      title: 'User page',
      active: true,
    });
    const task = taskForRound(fixture, 'round-a');
    const untracked = unmanagedPage((await task.tabs())[0]);

    const adopted = await task.adopt(untracked, { as: 'notes' });

    expect(adopted.label).toBe('notes');
    expect(adopted.targetId).toBe('target-user');
    expect(adopted.openedBy).toBe('unknown');
    expect(await adopted.snapshot()).toMatch(
      /\[notes .*space "research"\(7\).*\]\nsnapshot:https:\/\/example\.test\/user/,
    );
    expect((await task.tabs()).map(({ label, openedBy }) => ({ label, openedBy }))).toEqual([
      { label: 'notes', openedBy: 'unknown' },
    ]);
  });
});

test('adopt rejects stale, cross-space, and already managed handles', async () => {
  await withFixture(async (fixture) => {
    fixture.tabs.set('target-user', {
      targetId: 'target-user',
      url: 'https://example.test/user',
      title: 'User page',
      active: true,
    });
    const task = taskForRound(fixture, 'round-a');
    const untracked = unmanagedPage((await task.tabs())[0]);
    const otherTask = createTaskSpaceHandle(
      { id: 8, name: 'other', ownership: 'agent' },
      {
        ledger: fixtureLedger(fixture),
        ...fixture.services,
      },
    );

    await expect(otherTask.adopt(untracked)).rejects.toThrow(/belongs to space 7, not space 8/);

    const adopted = await task.adopt(untracked);
    await expect(task.adopt(untracked)).rejects.toThrow(/target target-user is already page p1/);

    const inventory = await task.tabs();
    expect(labelOf(inventory[0]?.page)).toBe(adopted.label);
    fixture.tabs.delete('target-user');
    const stale = untracked;
    await expect(task.adopt(stale)).rejects.toThrow(/untracked page target-user is no longer open/);
  });
});

test('adopt applies the managed-page budget before changing the ledger', async () => {
  await withFixture(async (fixture) => {
    fixture.tabs.set('target-user', {
      targetId: 'target-user',
      url: 'https://example.test/user',
      title: 'User page',
      active: false,
    });
    const task = taskForRound(fixture, 'round-a', { pageBudget: 1 });
    await openTestPage(task, 'https://example.test/managed');
    const untracked = unmanagedPage(
      (await task.tabs()).find((item) => item.targetId === 'target-user'),
    );

    await expect(task.adopt(untracked)).rejects.toThrow(/Page budget reached \(1\/1\)/);
    const after = await task.tabs();
    expect(after.find((item) => item.targetId === 'target-user')?.label).toBeUndefined();
  });
});

test('release leaves an adopted page open and retires its label', async () => {
  await withFixture(async (fixture) => {
    fixture.tabs.set('target-user', {
      targetId: 'target-user',
      url: 'https://example.test/user',
      title: 'User page',
      active: true,
    });
    const task = taskForRound(fixture, 'round-a');
    const untracked = unmanagedPage((await task.tabs())[0]);
    const adopted = await task.adopt(untracked);

    const released = await task.release(adopted.label);

    expect(released.targetId).toBe('target-user');
    expect(fixture.tabs.has('target-user')).toBe(true);
    expect((await task.tabs())[0]?.label).toBeUndefined();
    await expect(adopted.snapshot()).rejects.toThrow(/page p1 was released/);
    const adoptedAgain = await task.adopt(released);
    expect(adoptedAgain.label).toBe('p2');
  });
});

test('release refuses to orphan a page created by the agent', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const created = await openTestPage(task, 'https://example.test/agent');

    await expect(task.release(created.label)).rejects.toThrow(
      /page p1 was created by the agent; close it instead/,
    );
    expect(fixture.tabs.has(String(created.targetId))).toBe(true);
    expect((await task.tabs())[0]?.label).toBe('p1');
  });
});

test('tabs retires a managed label when its browser tab disappeared', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/managed');
    fixture.tabs.delete(String(page.targetId));

    expect(await task.tabs()).toEqual([]);
    await expect(task.page('p1').snapshot()).rejects.toThrow(/page p1 was closed/);
  });
});

test('newPage rejects before creating a tab when the managed budget is full', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', { pageBudget: 2 });
    const first = await openTestPage(task, 'https://example.test/first');
    await openTestPage(task, 'https://example.test/second');

    const error = await rejection(openTestPage(task, 'https://example.test/third'));
    expect(error.message).toMatch(/Page budget reached \(2\/2\) in space "research"/);
    expect(error.message).toMatch(/p1\s+"https:\/\/example\.test\/first"/);
    expect(error.message).toMatch(/Close: await task\.page\('p1'\)\.close\(\)/);
    expect(error.message).toMatch(/Reuse: await task\.page\('p1'\)\.goto\(url\)/);
    expect(fixture.tabs.size, 'budget rejection must happen before createTab').toBe(2);

    await first.close();
    const replacement = await openTestPage(task, 'https://example.test/third');
    expect(replacement.label).toBe('p3');
    expect(fixture.tabs.size).toBe(2);
  });
});

test('a tab closed outside the runtime frees budget on the next newPage', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', { pageBudget: 2 });
    const first = await openTestPage(task, 'https://example.test/first');
    await openTestPage(task, 'https://example.test/second');
    fixture.tabs.delete(String(first.targetId));

    const replacement = await openTestPage(task, 'https://example.test/third');

    expect(replacement.label).toBe('p3');
    expect(fixture.tabs.size).toBe(2);
    await expect(task.page('p1').snapshot()).rejects.toThrow(/page p1 was closed/);
  });
});

test('newPage never closes a managed page when native returns its target again', async () => {
  await withFixture(async (fixture) => {
    const firstTask = taskForRound(fixture, 'round-a');
    const first = await openTestPage(firstTask, 'https://example.test/first');
    const closeCallsBefore = cdpCalls(fixture).filter(
      (call) => call.method === 'Target.closeTarget',
    ).length;
    const secondTask = taskForRound(fixture, 'round-a', {
      createTab() {
        return Promise.resolve(String(first.targetId));
      },
    });

    await expect(openTestPage(secondTask, 'https://example.test/second')).rejects.toThrow(
      /did not create a distinct tab.*already page p1/,
    );

    expect(fixture.tabs.has(String(first.targetId))).toBe(true);
    expect(cdpCalls(fixture).filter((call) => call.method === 'Target.closeTarget')).toHaveLength(
      closeCallsBefore,
    );
  });
});

test('an input action without a popup skips tab polling and settle delays', async () => {
  await withFixture(async (fixture) => {
    let tabListCalls = 0;
    const task = taskForRound(fixture, 'round-a', {
      listTabs() {
        tabListCalls += 1;
        return fixture.services.listTabs();
      },
    });
    const page = await openTestPage(task, 'https://example.test/source');
    tabListCalls = 0;
    const sleepsBefore = fixture.sleepDurations.length;
    const callsBefore = fixture.calls.length;

    const receipt = await page.click('#plain-button');

    expect(receipt).toEqual({});
    expect(tabListCalls, 'no popup means no tab list round trips').toBe(0);
    expect(
      fixture.sleepDurations.slice(sleepsBefore),
      'the action boundary no longer sleeps to settle the tab list',
    ).toEqual([]);
    const syncCalls = cdpCallsSince(fixture, callsBefore).filter(
      (call) => call.method === 'Runtime.evaluate' && call.params.expression === '0',
    );
    expect(syncCalls, 'one page round trip orders a popup event ahead of the receipt').toHaveLength(
      1,
    );
  });
});

test('a popup reported by Target.targetCreated is adopted without a settle delay', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/source');
    const sleepsBefore = fixture.sleepDurations.length;
    fixture.openPopupOnNextClick('https://example.test/popup');

    const receipt = await page.click('#open-popup');

    expect(receipt.popups).toHaveLength(1);
    expect(receipt.popups?.[0]?.label).toBe('p2');
    expect(await task.page('p2').url(), 'the popup Page is usable from the receipt').toBe(
      'https://example.test/popup',
    );
    expect(fixture.sleepDurations.slice(sleepsBefore)).toEqual([]);
  });
});

test('a target created outside this task space is not adopted as a popup', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let foreignEvents = 0;
    // PiArc: the override is given to the task; upstream reassigned fixture.services.cdp after
    // the task had already copied the services, so its event never fired.
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp((method, params: CdpObject, sessionId, timeoutMs) => {
        if (method === 'Input.dispatchMouseEvent') {
          // The user opens a tab in another window while the click runs.
          foreignEvents += 1;
          fixture.emitBrowserEvent('Target.targetCreated', {
            targetInfo: {
              targetId: 'target-elsewhere',
              type: 'page',
              url: 'https://example.test/elsewhere',
            },
          });
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
    });
    const page = await openTestPage(task, 'https://example.test/source');

    const receipt = await page.click('#plain-button');

    expect(foreignEvents).toBeGreaterThan(0);
    expect(receipt, "a foreign target is not in this space's tab list").toEqual({});
    const ledger = await fixtureLedger(fixture).read(7);
    expect(Object.values(ledger.pages).some((entry) => entry.targetId === 'target-elsewhere')).toBe(
      false,
    );
  });
});

test('without target discovery the action boundary falls back to tab polling', async () => {
  await withFixture(async (fixture) => {
    fixture.setTargetDiscovery(false);
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/source');
    const sleepsBefore = fixture.sleepDurations.length;
    fixture.openPopupOnNextClick('https://example.test/popup');

    const receipt = await page.click('#open-popup');

    expect(receipt.popups).toHaveLength(1);
    expect(
      fixture.sleepDurations.slice(sleepsBefore),
      'the polling fallback keeps its settle delay',
    ).toEqual([50]);
  });
});

test('a missing action target fails fast once the page is idle', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/source');
    fixture.markNetworkTracked('session:target-1', { lastActivityAt: 0 });
    fixture.setElementState({ present: false });
    fixture.setDomActivity({
      readyState: 'complete',
      visible: true,
      idleMs: 650,
      framesLoading: false,
    });
    const startedAt = fixture.services.now();

    const error = await rejection(page.click('#nope'));
    expect(error.name).toBe('ElementResolutionError');
    expect(Reflect.get(error, 'kind')).toBe('permanent');
    expect(error.message).toMatch(/page\.click failed: Selector #nope matched 0 elements/);
    expect(error.message).toMatch(/idle for 650ms/);
    expect(error.message).toMatch(/page\.waitForSelector\(\)/);
    expect(
      fixture.services.now() - startedAt,
      'the first attempt never gives up; the second attempt proves the page idle',
    ).toBe(500);
    const probes = fixture.calls.filter(([kind]) => kind === 'domActivityProbe');
    expect(probes, 'the page is probed only once idle time could have elapsed').toHaveLength(1);
  });
});

test('a missing action target keeps waiting while the page is busy', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/source');
    fixture.markNetworkTracked('session:target-1', { lastActivityAt: 0 });
    fixture.setElementState({ present: false });

    // Still mutating: the observer saw a change a moment ago.
    fixture.setDomActivity({
      readyState: 'complete',
      visible: true,
      idleMs: 120,
      framesLoading: false,
    });
    let startedAt = fixture.services.now();
    await expect(page.click('#nope', { timeout: 1_000 })).rejects.toThrow(
      /page\.click timed out after 1000ms: Selector #nope matched 0 elements/,
    );
    expect(fixture.services.now() - startedAt).toBe(1_000);

    // Idle DOM, but a request is in flight.
    fixture.setDomActivity({
      readyState: 'complete',
      visible: true,
      idleMs: 900,
      framesLoading: false,
    });
    const baseActivity = (sessionIds: string[]) => fixture.services.networkActivity(sessionIds);
    const task2 = taskForRound(fixture, 'round-a', {
      networkActivity(sessionIds) {
        return { ...baseActivity(sessionIds), tracking: true, inflight: 1 };
      },
    });
    const busyPage = task2.page('p1');
    startedAt = fixture.services.now();
    await expect(busyPage.click('#nope', { timeout: 1_000 })).rejects.toThrow(
      /page\.click timed out after 1000ms/,
    );
    expect(fixture.services.now() - startedAt).toBe(1_000);

    // Network cannot be observed at all: never fail early.
    const task3 = taskForRound(fixture, 'round-a', {
      networkActivity() {
        return { tracking: false, inflight: 0, lastActivityAt: 0 };
      },
    });
    startedAt = fixture.services.now();
    await expect(task3.page('p1').click('#nope', { timeout: 1_000 })).rejects.toThrow(
      /page\.click timed out after 1000ms/,
    );
    expect(fixture.services.now() - startedAt).toBe(1_000);
  });
});

test('page.fill returns after the first accepted read-back', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/source');
    const callsBefore = fixture.calls.length;
    const sleepsBefore = fixture.sleepDurations.length;

    await page.fill('#text-input', 'hello');

    const readBacks = cdpCallsSince(fixture, callsBefore).filter(
      (call) =>
        call.method === 'Runtime.callFunctionOn' && declarationIncludes(call, 'readFilledValue'),
    );
    expect(readBacks, 'an accepted value is not re-read').toHaveLength(1);
    expect(
      fixture.sleepDurations.slice(sleepsBefore).includes(50),
      'no verification interval is spent on an accepted value',
    ).toBe(false);
    expect(fixture.fillText()).toBe('hello');
  });
});

test('a missing action target keeps waiting while the page is hidden', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/source');
    fixture.markNetworkTracked('session:target-1', { lastActivityAt: 0 });
    fixture.setElementState({ present: false });
    fixture.setDomActivity({
      readyState: 'complete',
      visible: false,
      idleMs: 5_000,
      framesLoading: false,
    });
    const startedAt = fixture.services.now();

    await expect(page.click('#nope', { timeout: 1_000 })).rejects.toThrow(
      /page\.click timed out after 1000ms: Selector #nope matched 0 elements/,
    );
    expect(fixture.services.now() - startedAt).toBe(1_000);
  });
});

test('a popup waiter ignores the URL refresh of an earlier popup', async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/source');
    fixture.openPopupOnNextClick('about:blank');
    const oldReceipt = await page.click('#old-popup-link');
    const oldPopup = oldReceipt.popups?.[0];
    expect(oldPopup).toBeDefined();
    const oldTargetId = oldPopup?.targetId ?? '';

    const pending = page.waitForEvent('popup', { timeout: 200 });
    const oldTab = fixture.tabs.get(oldTargetId);
    expect(oldTab).toBeDefined();
    if (oldTab) oldTab.url = 'https://example.test/old-final';
    fixture.emitBrowserEvent('Target.targetInfoChanged', {
      targetInfo: {
        targetId: oldTargetId,
        type: 'page',
        url: 'https://example.test/old-final',
      },
    });
    fixture.openPopupOnNextClick('https://example.test/next');
    const nextReceipt = await page.click('#next-popup-link');

    const popup = await pending;
    expect(labelOf(popup)).toBe(nextReceipt.popups?.[0]?.label);
    expect(labelOf(popup)).not.toBe(oldPopup?.label);
  });
});

test('a click that reaches a file input waits for the trailing chooser event', async () => {
  await withFixture(async (fixture) => {
    fixture.setFileInputClicked(true);
    const task = taskForRound(fixture, 'round-a', {
      sleep(ms) {
        fixture.sleepDurations.push(ms);
        // The chooser event lands only after the action acknowledged its input.
        fixture.emitFileChooser();
        return Promise.resolve();
      },
    });
    const page = await openTestPage(task, 'https://example.test/upload-guard');

    const error = await rejection(page.click('#open-upload'));
    expect(Reflect.get(error, 'code')).toBe('EGO_FILE_CHOOSER_OPENED');
    expect(
      fixture.sleepDurations.slice(-1),
      'a confirmed file-input click waits for the chooser rather than a blind settle',
    ).toEqual([1_000]);
  });
});

test('snapshot names the Page and the next step when the Page does not answer', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', {
      ensureFrameSessions() {
        return Promise.reject(new PageUnresponsiveError('Page.getFrameTree', 1_500, 'target-1'));
      },
    });
    const page = await openTestPage(task, 'https://example.test/pending');

    const error = await rejection(page.snapshot());
    expect(error).toMatchObject({
      code: 'EGO_PAGE_UNRESPONSIVE',
      method: 'Page.getFrameTree',
      waitedMs: 1_500,
      targetId: 'target-1',
    });
    expect(error.message).toMatch(/^Page p1 .*did not answer Page\.getFrameTree within 1500ms\./);
    expect(error.message).toMatch(/navigation has started but not committed/);
    expect(error.message).toMatch(/page\.cdp\("Page\.stopLoading"\)/);
    expect(error.message).toMatch(/task\.newPage\(\)/);
  });
});

test('snapshot stops a pending navigation after its wait and says what the Page shows', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    const stops: { sessionId: string | undefined; timeoutMs: number | undefined }[] = [];
    const task = taskForRound(fixture, 'round-a', {
      ensureFrameSessions() {
        return Promise.reject(
          new PageUnresponsiveError('Page.getFrameTree', 15_000, 'target-1', 'session-1'),
        );
      },
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        if (method === 'Target.getTargetInfo') {
          return { targetInfo: { url: 'https://example.test/pending' } };
        }
        if (method === 'Page.stopLoading') {
          stops.push({ sessionId, timeoutMs });
          return {};
        }
        if (method === 'Page.getFrameTree' && stops.length > 0) {
          return previousFrameTree();
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
    });
    const page = await openTestPage(task, 'https://example.test/previous');

    const error = await rejection(page.snapshot());
    expect(error).toMatchObject({
      code: 'EGO_PAGE_UNRESPONSIVE',
      stopped: true,
      currentUrl: 'https://example.test/previous',
    });
    expect(error.message).toMatch(
      /^Page p1 \(https:\/\/example\.test\/pending\) did not answer Page\.getFrameTree within 15000ms: a main-frame navigation had started but not committed\. It was stopped once that wait ran out, so the Page answers again and shows https:\/\/example\.test\/previous\./,
    );
    expect(error.message).toMatch(/Retry the call/);
    expect(error.message).toMatch(/page\.goto\(url, \{ timeout \}\)/);
    expect(error.message).not.toMatch(/page\.cdp\("Page\.stopLoading"\)/);
    expect(stops).toEqual([{ sessionId: 'session-1', timeoutMs: 1_000 }]);
  });
});

test('snapshot names a probably hung renderer when stopping does not help', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    const task = taskForRound(fixture, 'round-a', {
      ensureFrameSessions() {
        return Promise.reject(
          new PageUnresponsiveError('Page.getFrameTree', 15_000, 'target-1', 'session-1'),
        );
      },
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        if (method === 'Page.stopLoading') {
          throw new CdpRequestTimeoutError(method, timeoutMs ?? 0, sessionId);
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
    });
    const page = await openTestPage(task, 'https://example.test/hung');

    const error = await rejection(page.snapshot());
    expect(error).toMatchObject({ code: 'EGO_PAGE_UNRESPONSIVE', stopped: false });
    expect(error.message).toMatch(
      /did not answer Page\.getFrameTree within 15000ms, and still did not answer after Page\.stopLoading, so its renderer is probably hung\./,
    );
    expect(error.message).toMatch(/task\.newPage\(\)/);
  });
});

test('screenshot stops a pending navigation when the Page never answers its renderer command', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let held = true;
    const stops: { sessionId: string | undefined; timeoutMs: number | undefined }[] = [];
    // PiArc: a screenshot answers the attached image, not a file path.
    const afterStop = { image: 2, width: 640, height: 480 };
    const task = taskForRound(fixture, 'round-a', {
      screenshot(_options, sessionId) {
        if (held) {
          return Promise.reject(new CdpRequestTimeoutError('Runtime.evaluate', 15_000, sessionId));
        }
        return Promise.resolve(afterStop);
      },
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        if (method === 'Page.stopLoading') {
          stops.push({ sessionId, timeoutMs });
          held = false;
          return {};
        }
        if (method === 'Page.getFrameTree' && !held) {
          return previousFrameTree();
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
    });
    const page = await openTestPage(task, 'https://example.test/previous');

    const error = await rejection(page.screenshot());
    expect(error).toMatchObject({
      code: 'EGO_PAGE_UNRESPONSIVE',
      method: 'Runtime.evaluate',
      waitedMs: 15_000,
      stopped: true,
      currentUrl: 'https://example.test/previous',
    });
    expect(error.message).toMatch(
      /^Page p1 .*did not answer Runtime\.evaluate within 15000ms: a main-frame navigation had started but not committed\. It was stopped once that wait ran out/,
    );
    expect(stops).toHaveLength(1);
    expect(typeof stops[0]?.sessionId).toBe('string');
    expect(await page.screenshot()).toEqual(afterStop);
  });
});

test('a screenshot capture timeout reports EGO_PAGE_UNRESPONSIVE naming Page.captureScreenshot', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', {
      screenshot(_options, sessionId) {
        return Promise.reject(
          new CdpRequestTimeoutError('Page.captureScreenshot', 15_000, sessionId),
        );
      },
    });
    const page = await openTestPage(task, 'https://example.test/canvas');

    const error = await rejection(page.screenshot());
    expect(error).toMatchObject({
      code: 'EGO_PAGE_UNRESPONSIVE',
      method: 'Page.captureScreenshot',
      waitedMs: 15_000,
    });
  });
});

test('a browser-level command timeout is not treated as an unresponsive Page', async () => {
  await withFixture(async (fixture) => {
    let stops = 0;
    const task = taskForRound(fixture, 'round-a', {
      screenshot() {
        return Promise.reject(new CdpRequestTimeoutError('Target.getTargetInfo', 15_000));
      },
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        if (method === 'Page.stopLoading') stops += 1;
        return fixture.services.cdp(method, params, sessionId, timeoutMs);
      }),
    });
    const page = await openTestPage(task, 'https://example.test/browser');

    const error = await rejection(page.screenshot());
    expect(error).toMatchObject({
      code: 'EGO_CDP_REQUEST_TIMEOUT',
      method: 'Target.getTargetInfo',
    });
    expect(stops).toBe(0);
  });
});

test('evaluate stops a pending navigation when the Page never answers', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let held = false;
    let terminateCalls = 0;
    const stops: { sessionId: string | undefined; timeoutMs: number | undefined }[] = [];
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        const expression = typeof params.expression === 'string' ? params.expression : '';
        if (
          method === 'Runtime.evaluate' &&
          expression.includes('__egoPageEvaluate') &&
          expression.includes('pendingProbe')
        ) {
          held = true;
        }
        if (held && method === 'Runtime.evaluate') {
          throw new CdpRequestTimeoutError(method, timeoutMs ?? 0, sessionId);
        }
        if (held && method === 'Runtime.terminateExecution') {
          terminateCalls += 1;
          throw new CdpRequestTimeoutError(method, timeoutMs ?? 0, sessionId);
        }
        if (method === 'Page.stopLoading') {
          stops.push({ sessionId, timeoutMs });
          held = false;
          return {};
        }
        if (method === 'Page.getFrameTree' && stops.length > 0) {
          return previousFrameTree();
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
    });
    const page = await openTestPage(task, 'https://example.test/previous');

    const error = await rejection(page.evaluate(() => 'pendingProbe'));
    expect(error).toMatchObject({
      code: 'EGO_PAGE_EVALUATION_TIMED_OUT',
      stopped: true,
      currentUrl: 'https://example.test/previous',
      pageResponsive: true,
      executionStopped: false,
      mayHaveLateEffects: true,
    });
    expect(error.message).toMatch(
      /^page\.evaluate on Page p1 timed out after \d+ms: a main-frame navigation had started but not committed, so the Page answered nothing\. It was stopped once that wait ran out, so the Page answers again and shows https:\/\/example\.test\/previous; the evaluation may still run late/,
    );
    expect(error.message).toMatch(/page\.goto\(url, \{ timeout \}\)/);
    expect(terminateCalls, 'termination is still attempted first').toBe(1);
    expect(stops).toHaveLength(1);
  });
});

test('evaluate names a probably hung renderer when stopping does not help', async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    let held = false;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp((method, params, sessionId, timeoutMs) => {
        const expression = typeof params.expression === 'string' ? params.expression : '';
        if (method === 'Runtime.evaluate' && expression.includes('hungProbe')) {
          held = true;
        }
        if (
          held &&
          (method === 'Runtime.evaluate' ||
            method === 'Runtime.terminateExecution' ||
            method === 'Page.stopLoading')
        ) {
          throw new CdpRequestTimeoutError(method, timeoutMs ?? 0, sessionId);
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
    });
    const page = await openTestPage(task, 'https://example.test/hung');

    const error = await rejection(page.evaluate(() => 'hungProbe'));
    expect(error).toMatchObject({
      code: 'EGO_PAGE_EVALUATION_TIMED_OUT',
      stopped: false,
      pageResponsive: false,
    });
    expect(error.message).toMatch(/renderer is probably hung/);
    expect(error.message).toMatch(/task\.newPage\(\)/);
  });
});

test('snapshot describes a Page that stops answering after the first document check', async () => {
  await withFixture(async (fixture) => {
    let calls = 0;
    const task = taskForRound(fixture, 'round-a', {
      ensureFrameSessions() {
        calls += 1;
        if (calls === 1) return Promise.resolve(new Map<string, string>());
        return Promise.reject(new PageUnresponsiveError('Page.getFrameTree', 800, 'target-1'));
      },
      snapshot() {
        return Promise.resolve({
          content: 'button "Go" [ref=1]',
          refs: [{ refId: 1, backendNodeId: 1, role: 'button', name: 'Go' }],
        });
      },
    });
    const page = await openTestPage(task, 'https://example.test/late');

    const error = await rejection(page.snapshot());
    expect(error).toMatchObject({ code: 'EGO_PAGE_UNRESPONSIVE' });
    expect(error.message).toMatch(/^Page p1 .*did not answer Page\.getFrameTree within 800ms\./);
    expect(error.message).toMatch(/Page\.stopLoading/);
    expect(calls, 'the second frame discovery is the one that failed').toBe(2);
  });
});
