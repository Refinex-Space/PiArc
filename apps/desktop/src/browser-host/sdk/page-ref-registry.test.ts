// Ported from ego-browser package/ego-browser/src/page-ref-registry.test.mjs (ego-lite commit
// 56589ea8, MIT, see LICENSE). PiArc: Vitest.

import { expect, test } from 'vitest';

import { PageRefRegistry, validatePageRefState, type SnapshotRef } from './page-ref-registry.js';

test('equal backend ids in different frames retain distinct public refs', () => {
  const registry = new PageRefRegistry();
  registry.replace('page', [
    { refId: 1, backendNodeId: 42, frameId: 'first' },
    { refId: 2, backendNodeId: 42, frameId: 'second' },
  ]);
  const subtree: SnapshotRef[] = [
    { refId: 1, backendNodeId: 42, frameId: 'second', name: 'Renamed' },
  ];
  registry.merge('page', subtree);
  expect(subtree[0]?.refId).toBe(2);
  expect(registry.forTarget('page').get('1')?.frameId).toBe('first');
  expect(registry.forTarget('page').get('2')?.name).toBe('Renamed');
});

test('full snapshots expire omitted refs and never recycle them after restoring state', () => {
  const registry = new PageRefRegistry();
  registry.replace('page', [{ refId: 1, backendNodeId: 42 }]);
  registry.replace('page', []);
  const restored = new PageRefRegistry();
  restored.restore('page', registry.exportState('page'));
  const replacement: SnapshotRef[] = [{ refId: 1, backendNodeId: 43 }];
  restored.merge('page', replacement);
  expect(restored.isInvalidated('page', '1')).toBe(true);
  expect(replacement[0]?.refId).toBe(2);
});

test('persisted refs reject duplicate ids and counters that would reuse a published id', () => {
  const ref = { refId: '1', backendNodeId: 42, active: true };
  for (const state of [
    { nextRef: 1, refs: [ref] },
    { nextRef: 2, refs: [ref, { ...ref, backendNodeId: 43 }] },
    { nextRef: 2, refs: [{ ...ref, backendNodeId: 0 }] },
  ])
    expect(() => validatePageRefState(state)).toThrow(/Invalid persisted Page refs/);
});

test('partial snapshots allocate a new public ref when native ids collide', () => {
  const registry = new PageRefRegistry();
  registry.replace('page-target', [
    { refId: 1, backendNodeId: 35, role: 'iframe' },
    { refId: 2, backendNodeId: 36, role: 'iframe' },
  ]);
  const subtree: SnapshotRef[] = [
    { refId: 1, backendNodeId: 35, role: 'iframe' },
    { refId: 2, backendNodeId: 43, role: 'button', frameId: 'first-frame' },
  ];

  registry.merge('page-target', subtree);

  expect(registry.forTarget('page-target').get('2')?.backendNodeId).toBe(36);
  expect(String(subtree[1]?.refId)).not.toBe('2');
  expect(registry.forTarget('page-target').get(String(subtree[1]?.refId))?.backendNodeId).toBe(43);
});

test('the same node keeps its public ref when native snapshot numbering changes', () => {
  const registry = new PageRefRegistry();
  registry.replace('page-target', [
    { refId: 1, backendNodeId: 35, role: 'iframe' },
    { refId: 2, backendNodeId: 36, role: 'iframe' },
  ]);
  const subtree: SnapshotRef[] = [{ refId: 1, backendNodeId: 36, role: 'iframe' }];

  registry.merge('page-target', subtree);

  expect(String(subtree[0]?.refId)).toBe('2');
  expect(registry.forTarget('page-target').get('1')?.backendNodeId).toBe(35);
});

test('Page refs preserve native frame provenance and an explicit ref id', () => {
  const refs = new PageRefRegistry().replace('page-target', [
    {
      refId: 901,
      backendNodeId: 21,
      frameId: 'frame-target',
      frameProvenance: 'frame',
      role: 'button',
      name: 'Run iframe action',
    },
  ]);

  expect(refs.get('901')).toStrictEqual({
    backendNodeId: 21,
    role: 'button',
    name: 'Run iframe action',
    nth: undefined,
    frameId: 'frame-target',
    frameProvenance: 'frame',
  });
  // A renderer-local backend node id must not replace the printed ref id.
  expect(refs.get('21')).toBeUndefined();
});

test('an explicit snapshot gives a replacement node a new ref and keeps old refs stale', () => {
  const registry = new PageRefRegistry();
  registry.replace('page-target', [
    { refId: 21, backendNodeId: 21, role: 'button', name: 'Old action' },
    { refId: 22, backendNodeId: 22, role: 'button', name: 'Removed action' },
  ]);

  registry.invalidate('page-target');

  expect(registry.forTarget('page-target').get('21')).toBeUndefined();
  expect(registry.isInvalidated('page-target', '21')).toBe(true);

  registry.replace('page-target', [
    { refId: 21, backendNodeId: 42, role: 'button', name: 'New action' },
  ]);

  expect(registry.isInvalidated('page-target', '21')).toBe(true);
  // An explicit snapshot only revives refs that it advertises.
  expect(registry.isInvalidated('page-target', '22')).toBe(true);
  expect(registry.forTarget('page-target').get('21')).toBeUndefined();
  expect(registry.forTarget('page-target').get('23')?.backendNodeId).toBe(42);
});

test('partial snapshots merge refs without invalidating omitted targets', () => {
  const registry = new PageRefRegistry();
  registry.replace('page-target', [
    { refId: 21, backendNodeId: 21, role: 'button', name: 'First' },
    { refId: 22, backendNodeId: 22, role: 'button', name: 'Second' },
  ]);

  registry.merge('page-target', [
    { refId: 21, backendNodeId: 42, role: 'button', name: 'Updated' },
  ]);

  expect(registry.forTarget('page-target').get('21')?.backendNodeId).toBe(21);
  expect(registry.forTarget('page-target').get('23')?.backendNodeId).toBe(42);
  expect(registry.forTarget('page-target').get('22')?.backendNodeId).toBe(22);
  expect(registry.isInvalidated('page-target', '22')).toBe(false);
});

test('partial snapshots revive only the invalidated refs they advertise', () => {
  const registry = new PageRefRegistry();
  registry.replace('page-target', [
    { refId: 21, backendNodeId: 21, role: 'button', name: 'First' },
    { refId: 22, backendNodeId: 22, role: 'button', name: 'Second' },
  ]);
  registry.invalidate('page-target');

  registry.merge('page-target', [
    { refId: 99, backendNodeId: 21, role: 'button', name: 'Updated' },
  ]);

  expect(registry.forTarget('page-target').get('21')?.backendNodeId).toBe(21);
  expect(registry.isInvalidated('page-target', '21')).toBe(false);
  expect(registry.forTarget('page-target').get('22')).toBeUndefined();
  expect(registry.isInvalidated('page-target', '22')).toBe(true);
});

test('stale ref tombstones stay bounded for long-lived pages', () => {
  const registry = new PageRefRegistry();
  registry.replace(
    'page-target',
    Array.from({ length: 10_001 }, (_, index) => ({
      refId: index + 1,
      backendNodeId: index + 1,
      role: 'button',
      name: `Action ${String(index + 1)}`,
    })),
  );

  registry.invalidate('page-target');

  expect(registry.isInvalidated('page-target', '1')).toBe(false);
  expect(registry.isInvalidated('page-target', '10001')).toBe(true);
});
