// Ported from ego-browser package/ego-browser/src/page-model.test.mjs (ego-lite commit 56589ea8,
// MIT, see LICENSE), first slice: from "background discovery does not adopt the pre-existing tab
// baseline" to "a three-reply conversation closes the space it kept and claimed twice". PiArc:
// Vitest on the typed fixture in page-model.fixture.ts; ledgers live in the fixture's in-memory
// storage; node:vm's runInNewContext is replaced by an indirect eval with page stubs.

import { expect, test } from 'vitest';

import { fakeCdp } from '../testing.js';
import { resetSink } from './output-sink.js';
import { consumeUnhandledPageNotices, resetPageNotices } from './page-discovery.js';
import {
  capturedRoundOutput,
  cdpCalls,
  fixtureLedger,
  openTestPage,
  rejection,
  taskForRound,
  unmanagedPage,
  untyped,
  waitForLedgerTarget,
  withFixture,
  type Fixture,
} from './page-model.fixture.js';
import { initializeTaskSpaceHandle } from './page-model.js';

// Serialized into the Page by page.evaluate(); it is never defined in the script.
declare const missingClosureForE2E: unknown;

/**
 * Run a generated Page probe the way the Page would, with `location` and `document` stubs.
 * Upstream evaluates it with node:vm's runInNewContext.
 */
async function runPageProbe(expression: string): Promise<unknown> {
  const restore = [
    stubGlobal('location', { href: 'https://example.test/wait' }),
    stubGlobal('document', { title: 'wait' }),
  ];
  try {
    const value: unknown = await globalThis.eval(expression);
    return value;
  } finally {
    for (const undo of restore) undo();
  }
}

function stubGlobal(name: string, value: object): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  };
}

test('background discovery does not adopt the pre-existing tab baseline', async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    fixture.addExternalTab('target-existing', 'https://example.test/existing');
    const ledger = fixtureLedger(fixture);
    const task = taskForRound(fixture, 'round-a', { ledger });

    await initializeTaskSpaceHandle(task);
    const page = await openTestPage(task, 'https://example.test/managed');

    expect(page.label).toBe('p1');
    expect((await ledger.read(7)).unmanagedTargets).toEqual({
      'target-existing': 'unknown',
    });
    expect(consumeUnhandledPageNotices()).toEqual([]);
  });
});

test('a created TaskSpace manages its sole default tab as agent page p1', async () => {
  await withFixture(async (fixture) => {
    fixture.addExternalTab('target-initial', 'chrome://newtab/', {
      active: true,
    });
    const ledger = fixtureLedger(fixture);
    const task = taskForRound(fixture, 'round-a', { ledger });

    await initializeTaskSpaceHandle(task, { created: true });

    const [initial] = await task.pages();
    expect(initial?.label).toBe('p1');
    expect(initial?.targetId).toBe('target-initial');
    expect(initial?.openedBy).toBe('agent');

    const next = await task.newPage();
    expect(next.label).toBe('p2');
    expect(next.targetId).not.toBe(initial?.targetId);
  });
});

test('created-space initialization waits for a delayed default tab', async () => {
  await withFixture(async (fixture) => {
    fixture.addExternalTab('target-initial', 'chrome://newtab/', {
      active: true,
    });
    let inventories = 0;
    const task = taskForRound(fixture, 'round-a', {
      listTabs() {
        inventories += 1;
        if (inventories === 1) return Promise.resolve([]);
        return fixture.services.listTabs();
      },
    });

    await initializeTaskSpaceHandle(task, { created: true });

    const [initial] = await task.pages();
    expect(initial?.label).toBe('p1');
    expect(initial?.targetId).toBe('target-initial');
    expect(inventories).toBeGreaterThanOrEqual(2);
  });
});

test('created-space initialization refuses to guess between multiple tabs', async () => {
  await withFixture(async (fixture) => {
    fixture.addExternalTab('target-a', 'chrome://newtab/', { active: true });
    fixture.addExternalTab('target-b', 'about:blank');
    const ledger = fixtureLedger(fixture);
    const task = taskForRound(fixture, 'round-a', { ledger });

    await expect(initializeTaskSpaceHandle(task, { created: true })).rejects.toThrow(
      /new task space expected one default tab, found 2/,
    );
    expect((await ledger.read(7)).pages).toEqual({});
  });
});

test('created-space initialization times out when no default tab appears', async () => {
  await withFixture(async (fixture) => {
    const ledger = fixtureLedger(fixture);
    const task = taskForRound(fixture, 'round-a', { ledger });

    await expect(initializeTaskSpaceHandle(task, { created: true })).rejects.toThrow(
      /new task space did not expose its default tab within 2000ms/,
    );
    expect((await ledger.read(7)).pages).toEqual({});
  });
});

test('background target discovery adopts a delayed popup and reports its opener', async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    const ledger = fixtureLedger(fixture);
    const task = taskForRound(fixture, 'round-a', { ledger });
    await initializeTaskSpaceHandle(task);
    const source = await openTestPage(task, 'https://example.test/source');
    fixture.addExternalTab('target-delayed', 'https://example.test/delayed', {
      openerId: String(source.targetId),
    });

    fixture.emitBrowserEvent('Target.targetCreated', {
      targetInfo: {
        targetId: 'target-delayed',
        type: 'page',
        url: 'https://example.test/delayed',
        openerId: source.targetId,
      },
    });

    // The ledger write can become visible before discovery publishes its notice.
    await fixture.services.gate.withSpace(7, () => undefined);
    const adopted = await waitForLedgerTarget(ledger, 7, 'target-delayed');
    expect(adopted.label).toBe('p2');
    expect(consumeUnhandledPageNotices()).toEqual([
      {
        spaceId: 7,
        targetId: 'target-delayed',
        label: 'p2',
        openerLabel: 'p1',
        url: 'https://example.test/delayed',
      },
    ]);
  });
});

test('using a delayed popup suppresses its notice before round output', async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    const ledger = fixtureLedger(fixture);
    const task = taskForRound(fixture, 'round-a', { ledger });
    await initializeTaskSpaceHandle(task);
    const source = await openTestPage(task, 'https://example.test/source');
    fixture.addExternalTab('target-delayed', 'https://example.test/delayed', {
      openerId: String(source.targetId),
    });
    fixture.emitBrowserEvent('Target.targetCreated', {
      targetInfo: {
        targetId: 'target-delayed',
        type: 'page',
        url: 'https://example.test/delayed',
        openerId: source.targetId,
      },
    });
    const adopted = await waitForLedgerTarget(ledger, 7, 'target-delayed');

    expect(await task.page(adopted.label).url()).toBe('https://example.test/delayed');
    expect(consumeUnhandledPageNotices()).toEqual([]);
  });
});

test('tab reconciliation reports a late page without requiring an explicit wait', async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    const task = taskForRound(fixture, 'round-a');
    const source = await openTestPage(task, 'https://example.test/source');
    fixture.addExternalTab('target-delayed', 'https://example.test/delayed', {
      openerId: String(source.targetId),
    });

    const inventory = await task.tabs();
    const adopted = inventory.find((item) => item.targetId === 'target-delayed');

    expect(adopted?.label).toBe('p2');
    expect(consumeUnhandledPageNotices()).toEqual([
      {
        spaceId: 7,
        targetId: 'target-delayed',
        label: 'p2',
        openerLabel: 'p1',
        url: 'https://example.test/delayed',
      },
    ]);
  });
});

test('TaskSpace.waitForControl polls in milliseconds without taking control', async () => {
  await withFixture(async (fixture) => {
    let elapsedMs = 0;
    let probes = 0;
    const task = taskForRound(fixture, 'round-a', {
      now: () => elapsedMs,
      sleep(ms) {
        elapsedMs += ms;
        return Promise.resolve();
      },
      probeAgentControl() {
        probes += 1;
        return Promise.resolve(probes >= 3);
      },
    });

    await task.waitForControl({ interval: 25, timeout: 100 });

    expect(probes).toBe(3);
    expect(elapsedMs).toBe(50);
    expect(fixture.calls.filter(([name]) => name === 'selectSpace')).toEqual([
      ['selectSpace', 7],
      ['selectSpace', 7],
      ['selectSpace', 7],
    ]);
  });
});

test('TaskSpace.waitForControl times out in milliseconds and validates options', async () => {
  await withFixture(async (fixture) => {
    let elapsedMs = 0;
    const task = taskForRound(fixture, 'round-a', {
      now: () => elapsedMs,
      sleep(ms) {
        elapsedMs += ms;
        return Promise.resolve();
      },
      probeAgentControl() {
        return Promise.resolve(false);
      },
    });

    await expect(task.waitForControl({ interval: 40, timeout: 90 })).rejects.toThrow(
      /task\.waitForControl timed out after 90ms/,
    );
    expect(elapsedMs).toBe(90);
    await expect(task.waitForControl({ interval: 0 })).rejects.toThrow(
      /interval must be a positive number of milliseconds/,
    );
    await expect(task.waitForControl({ timeout: 0 })).rejects.toThrow(
      /timeout must be a positive number of milliseconds/,
    );
  });
});

test('Page.waitForTimeout validates and waits in milliseconds without activating the Page', async () => {
  await withFixture(async (fixture) => {
    const waits: number[] = [];
    const task = taskForRound(fixture, 'round-a', {
      sleep(ms) {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    const page = await openTestPage(task, 'https://example.test/timer');
    waits.length = 0;
    fixture.calls.length = 0;

    await page.waitForTimeout(125);

    expect(waits).toEqual([125]);
    expect(fixture.calls).toEqual([]);
    await expect(page.waitForTimeout(-1)).rejects.toThrow(
      /page\.waitForTimeout requires a non-negative number of milliseconds/,
    );
    await expect(page.waitForTimeout(Number.POSITIVE_INFINITY)).rejects.toThrow(
      /page\.waitForTimeout requires a non-negative number of milliseconds/,
    );
  });
});

test('Page.waitForFunction polls one Page with one JSON argument', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const first = await openTestPage(task, 'https://example.test/first');
    const second = await openTestPage(task, 'https://example.test/second');
    fixture.setWaitFunctionResults([false, false, true]);
    fixture.calls.length = 0;

    expect(
      await first.waitForFunction(
        ({ selector }: { selector: string }) => Boolean(document.querySelector(selector)),
        { selector: '#ready' },
        { timeout: 250, polling: 25 },
      ),
    ).toBe(true);

    const probes = cdpCalls(fixture).filter(
      ({ method, params, sessionId }) =>
        method === 'Runtime.evaluate' &&
        String(params.expression).includes('__egoWaitForFunction') &&
        sessionId === 'session:target-1',
    );
    expect(probes).toHaveLength(3);
    expect(String(probes[0]?.params.expression)).toMatch(/selector.*#ready/);
    expect(
      cdpCalls(fixture).some(
        ({ method, params }) =>
          method === 'Target.activateTarget' && params.targetId === first.targetId,
      ),
      'waitForFunction activates the addressed Page',
    ).toBe(true);
    expect(second.targetId).toBe('target-2');
  });
});

test("Page.waitForFunction resolves to true, not the predicate's value", async () => {
  await withFixture(async (fixture) => {
    const baseCdp = fixture.services.cdp;
    const task = taskForRound(fixture, 'round-a', {
      // Run the real probe, because the shared fixture answers it with a
      // canned `matched` and would not exercise the coercion.
      cdp: fakeCdp(async (method, params, sessionId, timeoutMs) => {
        const expression = params.expression;
        if (
          method === 'Runtime.evaluate' &&
          typeof expression === 'string' &&
          expression.includes('__egoWaitForFunction')
        ) {
          const value = await runPageProbe(expression);
          return { result: { type: 'object', value } };
        }
        return baseCdp(method, params, sessionId, timeoutMs);
      }),
    });
    const page = await openTestPage(task, 'https://example.test/wait');

    for (const predicate of [
      () => 'loaded',
      () => ({ status: 'ok' }),
      () => 42,
      async () => {
        await Promise.resolve();
        return 'loaded';
      },
      "'loaded'",
      "({ status: 'ok' })",
    ]) {
      expect(await page.waitForFunction(predicate)).toBe(true);
    }
    await expect(page.waitForFunction(() => 0, undefined, { timeout: 60 })).rejects.toThrow(
      /page\.waitForFunction timed out after 60ms/,
    );
  });
});

test('Page.waitForFunction validates input and reports its timeout', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');

    const timeout = await rejection(
      page.waitForFunction(() => false, undefined, {
        timeout: 60,
        polling: 25,
      }),
    );
    expect(timeout.message).toMatch(/page\.waitForFunction timed out after 60ms/);
    expect(timeout.message).toMatch(/page p1/);
    expect(timeout.message).toMatch(/last URL was "https:\/\/example\.test\/first"/);
    await expect(page.waitForFunction(untyped(42))).rejects.toThrow(
      /page\.waitForFunction expects a function or string expression/,
    );
    await expect(page.waitForFunction('document.readyState', { ignored: true })).rejects.toThrow(
      /string expression does not accept an argument/,
    );
    await expect(page.waitForFunction(() => true, undefined, { timeout: 0 })).rejects.toThrow(
      /timeout must be a positive number of milliseconds/,
    );
    await expect(page.waitForFunction(() => true, undefined, { polling: 0 })).rejects.toThrow(
      /polling must be a positive number of milliseconds/,
    );
    await expect(page.waitForFunction(() => false, { timeout: 60 })).rejects.toThrow(
      /options are the third argument.*pass undefined.*Expected: await page\.waitForFunction\(fnOrString, argument\?, \{ timeout\?, polling\? \}\)/,
    );
  });
});

test('Page.waitForFunction timeout points to an unhandled popup', async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/source');
    fixture.openPopupOnNextClick('https://example.test/popup');
    await page.click('#open-popup');

    const error = await rejection(
      page.waitForFunction(() => false, undefined, {
        timeout: 60,
        polling: 25,
      }),
    );
    expect(error.message).toMatch(/popup p2 opened from p1/i);
    expect(error.message).toMatch(/task\.page\("p2"\)/);
    expect(error.message).toMatch(/before retrying the preceding action/i);
  });
});

test('Page.evaluate explains that its callback cannot capture Node variables', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');

    const error = await rejection(page.evaluate(() => missingClosureForE2E));
    expect(error.message).toMatch(/ReferenceError: missingClosureForE2E is not defined/);
    expect(error.message).toMatch(
      /page\.evaluate\(\) callbacks run inside the Page and cannot access variables from the Node\.js script/,
    );
    expect(error.message).toMatch(/pass JSON data as the second argument/);
  });
});

test('v2 methods reject option fields that are absent from the public schema', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    await expect(task.newPage({ reuse: true })).rejects.toThrow(
      /task\.newPage does not accept arguments/,
    );
    expect(fixture.tabs.size, 'validation runs before creating a tab').toBe(0);

    const page = await openTestPage(task, 'https://example.test/options');
    await expect(page.click('button', untyped({ trial: true }))).rejects.toThrow(
      /page\.click received unknown option: trial/,
    );
    await expect(task.finish(untyped(undefined))).rejects.toThrow(
      /task\.finish options must be an object/,
    );
    await expect(task.finish({})).rejects.toThrow(/task\.finish requires the keep option/);
    const close: unknown = Reflect.get(task, 'close');
    expect(close, 'TaskSpace has one terminal API').toBeUndefined();
  });
});

test('TaskSpace uses spaceId and finishes while keeping every managed Page', async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls: string[] = [];
    const ledger = fixtureLedger(fixture);
    const services = {
      ledger,
      handOffTaskSpace() {
        lifecycleCalls.push('handOff');
        return Promise.resolve();
      },
      completeTaskSpace() {
        lifecycleCalls.push('finish');
        return Promise.resolve();
      },
    };
    const task = taskForRound(fixture, 'round-a', services);

    expect(task.spaceId).toBe(7);
    expect(task.id, 'id remains a compatibility alias').toBe(7);
    await task.handOff();

    const finishTask = taskForRound(fixture, 'round-b', services);
    const page = await finishTask.newPage();
    const receipt = await finishTask.finish({ keep: 'all' });
    expect(receipt).toEqual({
      spaceId: 7,
      closedSpace: false,
      keptManagedLabels: [page.label],
      closedManagedLabels: [],
      preservedUnmanagedCount: 0,
    });
    expect((await ledger.read(7)).pages).toEqual({});
    expect(fixture.tabs.has(String(page.targetId))).toBe(true);

    expect(lifecycleCalls).toEqual(['handOff', 'finish']);
    expect(
      fixture.calls
        .filter(([name]) => name === 'selectSpace')
        .every(([, spaceId]) => spaceId === 7),
    ).toBe(true);
  });
});

test('TaskSpace finish keeps named Pages and protects unknown-origin Pages', async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls: string[] = [];
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
    const p1 = await openTestPage(task, 'https://example.test/one');
    const p2 = await openTestPage(task, 'https://example.test/two');
    const p3 = await openTestPage(task, 'https://example.test/three');
    fixture.addExternalTab('target-user', 'https://example.test/user');
    await ledger.addPage(7, 'target-user', {
      as: 'user-page',
      openedBy: 'unknown',
    });

    const receipt = await task.finish({ keep: ['p2'] });

    expect(receipt).toEqual({
      spaceId: 7,
      closedSpace: false,
      keptManagedLabels: ['p2', 'user-page'],
      closedManagedLabels: ['p1', 'p3'],
      preservedUnmanagedCount: 0,
    });

    expect(lifecycleCalls).toEqual(['finish']);
    expect([...fixture.tabs.keys()].sort()).toEqual([p2.targetId, 'target-user']);
    expect(fixture.tabs.has(String(p1.targetId))).toBe(false);
    expect(fixture.tabs.has(String(p3.targetId))).toBe(false);
    expect((await ledger.read(7)).pages).toEqual({});
  });
});

test('TaskSpace finish closes the whole space when no Pages are retained', async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls: string[] = [];
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
    await openTestPage(task, 'https://example.test/one');

    const receipt = await task.finish({ keep: [] });

    expect(receipt).toEqual({
      spaceId: 7,
      closedSpace: true,
      keptManagedLabels: [],
      closedManagedLabels: ['p1'],
      preservedUnmanagedCount: 0,
    });

    expect(lifecycleCalls).toEqual(['close']);
    expect(
      cdpCalls(fixture).some(({ method }) => method === 'Target.closeTarget'),
      'closing the whole space does not close its Pages one by one',
    ).toBe(false);
    expect((await ledger.read(7)).pages).toEqual({});
  });
});

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

test('TaskSpace finish closes the space after the only Page was closed', async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls: string[] = [];
    const { ledger, task } = finishFixtureTask(fixture, lifecycleCalls);
    const p1 = await openTestPage(task, 'https://example.test/one');
    await p1.close();

    const tabs = await task.tabs();
    expect(tabs.length, 'page.close leaves a blank anchor tab').toBe(1);
    expect(tabs[0]?.label, 'the anchor stays unmanaged').toBeUndefined();
    expect(tabs[0]?.openedBy, 'the anchor is SDK-owned').toBe('agent');

    const receipt = await task.finish({ keep: [] });

    expect(receipt).toEqual({
      spaceId: 7,
      closedSpace: true,
      keptManagedLabels: [],
      closedManagedLabels: [],
      preservedUnmanagedCount: 0,
    });
    expect(lifecycleCalls).toEqual(['close']);
    expect((await ledger.read(7)).pages).toEqual({});
  });
});

test('TaskSpace finish closes the space when a new Page follows the last close', async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls: string[] = [];
    const { task } = finishFixtureTask(fixture, lifecycleCalls);
    const p1 = await openTestPage(task, 'https://example.test/one');
    await p1.close();
    const p2 = await openTestPage(task, 'https://example.test/two');
    expect(p2.label).toBe('p2');
    expect((await task.tabs()).length, 'anchor and p2 are live').toBe(2);

    const receipt = await task.finish({ keep: [] });

    expect(receipt).toEqual({
      spaceId: 7,
      closedSpace: true,
      keptManagedLabels: [],
      closedManagedLabels: ['p2'],
      preservedUnmanagedCount: 0,
    });
    expect(lifecycleCalls).toEqual(['close']);
  });
});

async function finishKeepingFirstPage(fixture: Fixture, lifecycleCalls: string[]) {
  const { task } = finishFixtureTask(fixture, lifecycleCalls);
  const kept = await openTestPage(task, 'https://example.test/kept');
  await task.finish({ keep: [kept.label] });
  lifecycleCalls.length = 0;
  return kept.targetId;
}

test('a claimed space closes when the agent closes task.pages() without adopting', async () => {
  await withFixture(async (fixture) => {
    resetSink();
    const lifecycleCalls: string[] = [];
    const keptTarget = await finishKeepingFirstPage(fixture, lifecycleCalls);

    const { task: claimed } = finishFixtureTask(fixture, lifecycleCalls);
    const pages = await claimed.pages();
    expect(pages.length, 'labels ended with the task').toBe(0);
    for (const page of pages) await page.close();
    expect(fixture.tabs.has(String(keptTarget)), 'nothing was closed yet').toBe(true);

    const receipt = await claimed.finish({ keep: [] });

    expect(receipt).toEqual({
      spaceId: 7,
      closedSpace: true,
      keptManagedLabels: [],
      closedManagedLabels: [],
      preservedUnmanagedCount: 0,
    });
    expect(lifecycleCalls).toEqual(['close']);
    expect(capturedRoundOutput()).not.toMatch(/did not close/);
  });
});

test('a claimed space closes when every adopted Page is closed before finish', async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls: string[] = [];
    await finishKeepingFirstPage(fixture, lifecycleCalls);

    const { task: claimed } = finishFixtureTask(fixture, lifecycleCalls);
    await claimed.adopt(unmanagedPage((await claimed.tabs())[0]));
    for (const page of await claimed.pages()) await page.close();
    expect(await claimed.pages()).toHaveLength(0);

    const receipt = await claimed.finish({ keep: [] });

    expect(receipt.closedSpace).toBe(true);
    expect(lifecycleCalls).toEqual(['close']);
  });
});

test('a three-reply conversation closes the space it kept and claimed twice', async () => {
  await withFixture(async (fixture) => {
    const lifecycleCalls: string[] = [];
    const keptTarget = await finishKeepingFirstPage(fixture, lifecycleCalls);

    const { task: followUp } = finishFixtureTask(fixture, lifecycleCalls);
    const page = await followUp.adopt(unmanagedPage((await followUp.tabs())[0]));
    expect(page.targetId).toBe(keptTarget);
    await page.goto('https://example.test/follow-up');
    const kept = await followUp.finish({ keep: [page.label] });
    expect(kept.closedSpace).toBe(false);
    expect(lifecycleCalls).toEqual(['finish']);

    lifecycleCalls.length = 0;
    const { task: summary } = finishFixtureTask(fixture, lifecycleCalls);
    expect(await summary.pages()).toHaveLength(0);
    const receipt = await summary.finish({ keep: [] });

    expect(receipt.closedSpace).toBe(true);
    expect(lifecycleCalls).toEqual(['close']);
  });
});

// PiArc additions: the changes the port makes to the Page model.

test('PiArc: the agent cursor names the acting Page target', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    await openTestPage(task, 'https://example.test/first');
    const second = await openTestPage(task, 'https://example.test/second');

    await second.click('button');

    expect(fixture.cursorTargets.length).toBeGreaterThan(0);
    expect(fixture.cursorTargets.every((targetId) => targetId === second.targetId)).toBe(true);
  });
});

test('PiArc: page.screenshot attaches the image and refuses a path', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/shot');
    fixture.calls.length = 0;

    await expect(page.screenshot({ path: '/tmp/shot.png' })).rejects.toThrow(
      /already attached to the tool result.*Omit path/,
    );
    expect(fixture.calls.some(([name]) => name === 'screenshot')).toBe(false);
    expect(await page.screenshot({ fullPage: true })).toEqual({
      image: 1,
      width: 800,
      height: 600,
    });
    expect(fixture.calls.filter(([name]) => name === 'screenshot')).toEqual([
      ['screenshot', { full: true }, 'session:target-1'],
    ]);
  });
});

test('PiArc: page.fetch refuses saveAs because the script cannot write files', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/fetch');
    fixture.calls.length = 0;

    await expect(page.fetch('/api/file', { saveAs: '/tmp/file.bin' })).rejects.toThrow(
      /saveAs is not supported.*download\.saveAs\(path\)/,
    );
    expect(fixture.calls).toEqual([]);
    expect(await page.fetch('/api/teapot')).toMatchObject({ status: 418, body: 'short and stout' });
  });
});

test('PiArc: page.snapshot names its tab for the snapshot binding', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/snapshot');

    await page.snapshot();

    expect(fixture.snapshotOptions).toEqual([
      {
        scope: 'only_within_viewport',
        includeActionMarks: true,
        includeStableLocator: true,
        targetId: page.targetId,
      },
    ]);
  });
});
