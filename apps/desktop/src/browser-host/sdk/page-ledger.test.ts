// Ported from ego-browser package/ego-browser/src/page-ledger.test.mjs (ego-lite commit 56589ea8,
// MIT, see LICENSE). PiArc: Vitest; ledgers live in an in-memory storage port (or FakeBindings)
// instead of a temporary directory. Tests of the dropped file store (numbered versions, locks,
// browser instance ids, legacy-file migration, stale-file cleanup) are not ported; documents that
// do not parse, schema errors and the default bindings storage have PiArc tests.

import { afterEach, expect, test } from 'vitest';

import { FakeBindings, installBindings } from '../testing.js';
import { isRecord } from './cdp-types.js';
import { PageLedgerStore, type PageLedgerStorage } from './page-ledger.js';

/** One JSON document per Space, as the main process keeps them. */
class MemoryStorage implements PageLedgerStorage {
  readonly documents = new Map<number, string>();

  load(spaceId: number): Promise<string | null> {
    return Promise.resolve(this.documents.get(spaceId) ?? null);
  }

  save(spaceId: number, data: string): Promise<void> {
    if (data === '') this.documents.delete(spaceId);
    else this.documents.set(spaceId, data);
    return Promise.resolve();
  }

  /** Parse the stored document of one Space. */
  stored(spaceId: number): Record<string, unknown> {
    const text = this.documents.get(spaceId);
    expect(text, `no ledger for space ${String(spaceId)}`).toBeDefined();
    const parsed: unknown = JSON.parse(text ?? '');
    if (!isRecord(parsed)) throw new Error('stored ledger is not an object');
    return parsed;
  }

  store(spaceId: number, document: unknown): void {
    this.documents.set(spaceId, JSON.stringify(document));
  }
}

function recordField(value: unknown, key: string): Record<string, unknown> {
  const field = isRecord(value) ? value[key] : undefined;
  if (!isRecord(field)) throw new Error(`${key} is not an object`);
  return field;
}

let restoreBindings: (() => void) | undefined;

afterEach(() => {
  restoreBindings?.();
  restoreBindings = undefined;
});

test('page labels survive a new process and are never reused', async () => {
  const storage = new MemoryStorage();
  const firstRound = new PageLedgerStore({ storage });
  const first = await firstRound.addPage(7, 'target-a');

  expect(first.label).toBe('p1');
  expect(first.targetId).toBe('target-a');

  const secondRound = new PageLedgerStore({ storage });
  expect(await secondRound.getPage(7, 'p1')).toStrictEqual(first);

  await secondRound.closePage(7, 'p1');
  await expect(secondRound.getPage(7, 'p1')).rejects.toThrow(/page p1 was closed/);

  const next = await secondRound.addPage(7, 'target-b');
  expect(next.label).toBe('p2');
});

// PiArc: upstream also checks that a browser restart (a new browser instance id) drops the refs;
// PiArc's ledgers live in the main process's memory, so an app restart starts without them.
test('Page ref state survives a process restart but not a Page close', async () => {
  const storage = new MemoryStorage();
  const first = new PageLedgerStore({ storage });
  await first.addPage(7, 'page-a');
  const refs = {
    nextRef: 3,
    refs: [
      {
        refId: '1',
        backendNodeId: 42,
        documentId: 'document-a',
        active: false,
      },
      {
        refId: '2',
        backendNodeId: 43,
        documentId: 'document-a',
        active: true,
      },
    ],
  };
  await first.setPageRefs(7, 'p1', refs);
  const resumed = new PageLedgerStore({ storage });
  expect((await resumed.getPage(7, 'p1')).refs).toStrictEqual(refs);
  await resumed.closePage(7, 'p1');
  expect((await resumed.read(7)).pages).toStrictEqual({});
});

test('a newly created space atomically replaces stale state with agent page p1', async () => {
  const store = new PageLedgerStore({ storage: new MemoryStorage() });
  await store.addPage(7, 'target-stale');
  await store.closePage(7, 'p1');

  const initial = await store.initializeCreatedSpace(7, 'target-initial');

  expect(initial).toStrictEqual({
    label: 'p1',
    targetId: 'target-initial',
    openedBy: 'agent',
  });
  expect(await store.read(7)).toStrictEqual({
    spaceId: 7,
    nextLabel: 2,
    usedLabels: ['p1'],
    releasedLabels: [],
    initialized: true,
    userControlPending: false,
    unmanagedTargets: {},
    retainedTargets: [],
    pages: {
      p1: { targetId: 'target-initial', openedBy: 'agent' },
    },
  });

  const next = await store.addPage(7, 'target-next');
  expect(next.label).toBe('p2');
});

test('custom labels share the permanent used-label namespace', async () => {
  const store = new PageLedgerStore({ storage: new MemoryStorage() });
  const page = await store.addPage(2, 'target-login', { as: 'login' });

  expect(page.label).toBe('login');
  await store.closePage(2, 'login');
  await expect(store.addPage(2, 'target-new', { as: 'login' })).rejects.toThrow(
    /page label already used: login/,
  );
});

test('writes use a complete ledger document', async () => {
  const storage = new MemoryStorage();
  const store = new PageLedgerStore({ storage });
  await store.addPage(5, 'target-a');

  expect(storage.stored(5)).toStrictEqual({
    spaceId: 5,
    nextLabel: 2,
    usedLabels: ['p1'],
    releasedLabels: [],
    initialized: true,
    userControlPending: false,
    unmanagedTargets: {},
    retainedTargets: [],
    pages: {
      p1: {
        targetId: 'target-a',
        openedBy: 'agent',
      },
    },
  });
});

// PiArc: replaces "a version that is gone or still being written falls back to the previous
// one": there is one document per Space, so one that does not parse reads as no ledger.
test('a stored document that does not parse reads as no ledger', async () => {
  const storage = new MemoryStorage();
  const store = new PageLedgerStore({ storage });
  storage.documents.set(5, '{"spaceId": 5, "nextLabel": 3, "usedLabels": ["p1", "p2"], "pages": {');

  expect((await store.read(5)).pages).toStrictEqual({});

  const page = await store.addPage(5, 'target-b');
  expect(page.label).toBe('p1');
  expect(Object.keys(recordField(storage.stored(5), 'pages'))).toStrictEqual(['p1']);
});

test('a stored document with the wrong shape is reported, never replaced', async () => {
  const storage = new MemoryStorage();
  const store = new PageLedgerStore({ storage });
  storage.store(5, { spaceId: 5, nextLabel: 0, usedLabels: [], pages: {} });
  const before = storage.documents.get(5);

  await expect(store.read(5)).rejects.toThrow(/invalid page ledger space 5: schema mismatch/);
  await expect(store.addPage(5, 'target-a')).rejects.toThrow(/schema mismatch/);
  expect(storage.documents.get(5)).toBe(before);
});

test("concurrent writers never lose each other's update", async () => {
  const storage = new MemoryStorage();
  const roundA = new PageLedgerStore({ storage });
  const roundB = new PageLedgerStore({ storage });
  await roundA.addPage(5, 'target-seed');

  const [pageA, pageB] = await Promise.all([
    roundA.addPage(5, 'target-a'),
    roundB.addPage(5, 'target-b'),
  ]);

  expect(pageA.label).not.toBe(pageB.label);
  const ledger = await roundA.read(5);
  expect(
    Object.values(ledger.pages)
      .map((page) => page.targetId)
      .sort(),
  ).toStrictEqual(['target-a', 'target-b', 'target-seed']);
  expect(ledger.usedLabels).toStrictEqual(['p1', 'p2', 'p3']);
});

test('old ledger metadata is accepted and removed on the next write', async () => {
  const storage = new MemoryStorage();
  storage.store(12, {
    spaceId: 12,
    version: 4,
    writerRound: 'old-round',
    nextLabel: 2,
    usedLabels: ['p1'],
    releasedLabels: [],
    initialized: true,
    unmanagedTargets: {},
    pages: {
      p1: {
        targetId: 'target-old',
        openedBy: 'agent',
        openedAt: 100,
        lastUsedAt: 200,
      },
    },
    touchedAt: 200,
  });
  const store = new PageLedgerStore({ storage });

  expect(await store.getPage(12, 'p1')).toStrictEqual({
    label: 'p1',
    targetId: 'target-old',
    openedBy: 'agent',
  });
  await store.addPage(12, 'target-new');

  const persisted = storage.stored(12);
  expect(Object.hasOwn(persisted, 'version')).toBe(false);
  expect(Object.hasOwn(persisted, 'writerRound')).toBe(false);
  expect(Object.hasOwn(persisted, 'touchedAt')).toBe(false);
  const p1 = recordField(recordField(persisted, 'pages'), 'p1');
  expect(Object.hasOwn(p1, 'openedAt')).toBe(false);
  expect(Object.hasOwn(p1, 'lastUsedAt')).toBe(false);
});

test('old handoff baselines migrate to a pending user-control boundary', async () => {
  const storage = new MemoryStorage();
  storage.store(13, {
    spaceId: 13,
    nextLabel: 2,
    usedLabels: ['p1'],
    releasedLabels: [],
    initialized: true,
    handoffBaseline: ['target-agent'],
    unmanagedTargets: {},
    pages: {
      p1: { targetId: 'target-agent', openedBy: 'agent' },
    },
  });
  const store = new PageLedgerStore({ storage });

  const restored = await store.read(13);
  expect(restored.userControlPending).toBe(true);

  await store.reconcile(13, ['target-agent', 'target-user'], {
    autoAdoptNew: true,
  });
  const persisted = storage.stored(13);
  expect(persisted.userControlPending).toBe(false);
  expect(Object.hasOwn(persisted, 'handoffBaseline')).toBe(false);
  expect(recordField(persisted, 'unmanagedTargets')['target-user']).toBe('unknown');
});

test('legacy user origins are read conservatively as unknown', async () => {
  const storage = new MemoryStorage();
  storage.store(14, {
    spaceId: 14,
    nextLabel: 2,
    usedLabels: ['p1'],
    releasedLabels: [],
    initialized: true,
    unmanagedTargets: { 'target-unmanaged': 'user' },
    pages: {
      p1: { targetId: 'target-managed', openedBy: 'user' },
    },
  });

  const restored = await new PageLedgerStore({ storage }).read(14);

  expect(restored.pages.p1?.openedBy).toBe('unknown');
  expect(restored.unmanagedTargets['target-unmanaged']).toBe('unknown');
});

test('release removes a managed page without making its label reusable', async () => {
  const store = new PageLedgerStore({ storage: new MemoryStorage() });
  const released = await store.addPage(3, 'target-user', {
    openedBy: 'unknown',
  });

  expect(await store.releasePage(3, released.label)).toStrictEqual(released);
  await expect(store.getPage(3, released.label)).rejects.toThrow(/page p1 was released/);

  const next = await store.addPage(3, 'target-next');
  expect(next.label).toBe('p2');

  const reconciled = await store.reconcile(3, ['target-user', 'target-next'], {
    autoAdoptNew: true,
  });
  // A released user page must not be silently adopted again.
  expect(Object.values(reconciled.pages).some((page) => page.targetId === 'target-user')).toBe(
    false,
  );
  expect(reconciled.unmanagedTargets['target-user']).toBe('unknown');
});

test('different spaces update independently', async () => {
  const storage = new MemoryStorage();
  const first = new PageLedgerStore({ storage });
  const second = new PageLedgerStore({ storage });

  const [pageA, pageB] = await Promise.all([
    first.addPage(1, 'target-a'),
    second.addPage(2, 'target-b'),
  ]);

  expect(pageA.label).toBe('p1');
  expect(pageB.label).toBe('p1');
});

test('discard removes one completed space without affecting another', async () => {
  const store = new PageLedgerStore({ storage: new MemoryStorage() });
  await store.addPage(7, 'target-7');
  await store.addPage(8, 'target-8');

  await store.discard(7);

  expect((await store.read(7)).pages).toStrictEqual({});
  expect((await store.read(8)).pages).toStrictEqual({
    p1: { targetId: 'target-8', openedBy: 'agent' },
  });
});

test('reconciliation removes missing targets but permanently retires their labels', async () => {
  const store = new PageLedgerStore({ storage: new MemoryStorage() });
  await store.addPage(4, 'target-live');
  await store.addPage(4, 'target-closed');

  const reconciled = await store.reconcile(4, ['target-live']);

  expect(Object.keys(reconciled.pages)).toStrictEqual(['p1']);
  expect(reconciled.usedLabels).toStrictEqual(['p1', 'p2']);
  await expect(store.getPage(4, 'p2')).rejects.toThrow(/page p2 was closed/);
  const next = await store.addPage(4, 'target-next');
  expect(next.label).toBe('p3');
});

test('reconciliation leaves the ledger unchanged when every target is live', async () => {
  const store = new PageLedgerStore({ storage: new MemoryStorage() });
  await store.addPage(6, 'target-live');
  const before = await store.read(6);

  const after = await store.reconcile(6, ['target-live', 'target-unknown']);

  expect(after.pages).toStrictEqual(before.pages);
});

test('reconciliation protects the first control baseline and adopts later agent tabs', async () => {
  const store = new PageLedgerStore({ storage: new MemoryStorage() });

  const baseline = await store.reconcile(8, ['target-user'], {
    autoAdoptNew: true,
  });
  expect(baseline.pages).toStrictEqual({});
  expect(baseline.unmanagedTargets['target-user']).toBe('unknown');

  const reconciled = await store.reconcile(8, ['target-user', 'target-popup'], {
    autoAdoptNew: true,
  });
  expect(reconciled.pages.p1?.targetId).toBe('target-popup');
  expect(reconciled.pages.p1?.openedBy).toBe('agent');
  expect(reconciled.unmanagedTargets['target-user']).toBe('unknown');
});

test('tabs opened during handoff remain unknown after takeover', async () => {
  const storage = new MemoryStorage();
  const firstRound = new PageLedgerStore({ storage });
  await firstRound.addPage(8, 'target-agent');
  await firstRound.beginUserControl(8);

  const secondRound = new PageLedgerStore({ storage });
  const afterTakeover = await secondRound.reconcile(8, ['target-agent', 'target-user'], {
    autoAdoptNew: true,
  });

  expect(afterTakeover.userControlPending).toBe(false);
  expect(afterTakeover.unmanagedTargets['target-user']).toBe('unknown');
  expect(afterTakeover.pages).toStrictEqual({
    p1: { targetId: 'target-agent', openedBy: 'agent' },
  });

  const laterAgentPopup = await secondRound.reconcile(
    8,
    ['target-agent', 'target-user', 'target-popup'],
    { autoAdoptNew: true },
  );
  expect(laterAgentPopup.pages.p2?.targetId).toBe('target-popup');
  expect(laterAgentPopup.pages.p2?.openedBy).toBe('agent');
});

test('an explicitly unmanaged anchor is not adopted during reconciliation', async () => {
  const store = new PageLedgerStore({ storage: new MemoryStorage() });
  await store.reconcile(10, [], { autoAdoptNew: true });
  await store.keepUnmanaged(10, 'target-anchor', 'agent');

  const reconciled = await store.reconcile(10, ['target-anchor'], {
    autoAdoptNew: true,
  });

  expect(reconciled.pages).toStrictEqual({});
  expect(reconciled.unmanagedTargets['target-anchor']).toBe('agent');
});

test('retained targets default to empty for ledgers from earlier runtimes', async () => {
  const storage = new MemoryStorage();
  const store = new PageLedgerStore({ storage });
  await store.retainForUser(5, ['target-kept']);
  const retained = await store.read(5);
  expect(retained.retainedTargets).toStrictEqual(['target-kept']);
  expect(retained.unmanagedTargets).toStrictEqual({ 'target-kept': 'agent' });
  expect(retained.initialized).toBe(false);

  const stored = storage.stored(5);
  Reflect.deleteProperty(stored, 'retainedTargets');
  storage.store(5, stored);
  expect((await store.read(5)).retainedTargets).toStrictEqual([]);
});

test('the default storage keeps each ledger in the main process through the bindings', async () => {
  const bindings = new FakeBindings();
  restoreBindings = installBindings(bindings);
  const store = new PageLedgerStore();

  await store.addPage(7, 'target-a');

  expect(bindings.calls.filter(([name]) => name === 'ledgerLoad')).toContainEqual([
    'ledgerLoad',
    7,
  ]);
  const saved: unknown = JSON.parse(bindings.ledgers.get(7) ?? 'null');
  expect(recordField(saved, 'pages')).toStrictEqual({
    p1: { targetId: 'target-a', openedBy: 'agent' },
  });
  expect((await new PageLedgerStore().getPage(7, 'p1')).targetId).toBe('target-a');

  await store.discard(7);

  expect(bindings.calls.at(-1)).toStrictEqual(['ledgerSave', 7, '']);
  expect(bindings.ledgers.has(7)).toBe(false);
  expect((await store.read(7)).pages).toStrictEqual({});
});

test('a failed ledger binding surfaces its message and error code', async () => {
  restoreBindings = installBindings(
    new FakeBindings({
      ledgerLoad: () =>
        Promise.resolve({
          error: 'Task space not found: 7',
          error_code: 'EGO_TASK_SPACE_NOT_FOUND',
        }),
    }),
  );

  const failure: unknown = await new PageLedgerStore().read(7).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({
    message: 'page ledger: Task space not found: 7',
    error_code: 'EGO_TASK_SPACE_NOT_FOUND',
  });
});
