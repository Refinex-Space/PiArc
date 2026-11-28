// Ported from ego-browser package/ego-browser/src/sdk-lifecycle.test.mjs (ego-lite commit 56589ea8,
// MIT, see LICENSE). PiArc: Vitest, in-process instead of a child Node process; the download
// waiter has no directory or marker file, so disposal is checked through the waiter itself; the
// "browser globals belong inside Page.evaluate" test moved to run.test.ts (the hint now comes
// from parameter shadows); tests for installEgoSdk's binding wrappers are added.

import { afterEach, expect, test } from 'vitest';

import { FakeBindings, installBindings, type CdpRequestMessage } from '../testing.js';
import {
  browserCdp,
  clearPreferredTarget,
  ensureSession,
  invalidateSession,
  setPreferredTarget,
} from './browser-runtime.js';
import { preparePageDownload } from './driver/downloads.js';
import { disposeEgoSdk, installEgoSdk } from './index.js';
import { state } from './state.js';

let restoreBindings: () => void = () => undefined;

afterEach(() => {
  disposeEgoSdk(globalThis);
  invalidateSession();
  clearPreferredTarget();
  restoreBindings();
  restoreBindings = () => undefined;
});

function install(fake: FakeBindings): FakeBindings {
  restoreBindings = installBindings(fake);
  installEgoSdk(globalThis);
  return fake;
}

/** Answers every command; attaching to a target answers `session:<targetId>`. */
function answerAll(request: CdpRequestMessage): Record<string, unknown> {
  if (request.method === 'Target.attachToTarget') {
    return { sessionId: `session:${String(request.params.targetId)}` };
  }
  return {};
}

function attachCount(fake: FakeBindings): number {
  return fake.sent.filter((request) => request.method === 'Target.attachToTarget').length;
}

test('disposeEgoSdk releases native callbacks and rejects pending CDP work', async () => {
  let respond = true;
  const ego = new FakeBindings({
    cdp: () => (respond ? { targetInfos: [] } : undefined),
  });
  restoreBindings = installBindings(ego);

  await browserCdp('Target.getTargets', {}, undefined, 1_000);
  expect(typeof ego.onCDPMessage, 'CDP callbacks were not installed').toBe('function');
  respond = false;
  const pending = browserCdp('Target.getTargets', {}, undefined, 10_000);
  const downloadWait = preparePageDownload(
    {
      cdp: () => Promise.reject(new Error('the download waiter sends no command')),
      subscribePageEvents: () => () => undefined,
    },
    'target-download',
    { timeoutMs: 10_000 },
  );
  await downloadWait.ready('session-download');

  disposeEgoSdk(globalThis);

  expect(ego.onCDPMessage, 'disposeEgoSdk left native callbacks installed').toBeUndefined();
  expect(ego.onSendCDPMessageError).toBeUndefined();
  await expect(pending).rejects.toThrow(/disposed/);
  await expect(downloadWait.event).rejects.toThrow(/disposed/);
  await expect(downloadWait.ready('session-download')).rejects.toThrow(/no longer active/);
});

test('installEgoSdk without bindings is a no-op', () => {
  const target = {};
  expect(() => {
    installEgoSdk(target);
  }).not.toThrow();
  expect(target).toEqual({});
});

test('a created tab becomes the preferred target', async () => {
  const ego = install(
    new FakeBindings({
      createTab: (url) =>
        Promise.resolve({
          index: 1,
          targetId: 'target-new',
          url,
          title: '',
          active: true,
          openedBy: 'agent',
        }),
    }),
  );

  const tab = await ego.createTab('https://example.test/');

  expect(tab).toMatchObject({ targetId: 'target-new' });
  expect(state.preferredTargetId).toBe('target-new');
});

test('a failed createTab leaves the preferred target alone', async () => {
  const ego = install(
    new FakeBindings({
      createTab: () =>
        Promise.resolve({ error: 'location', error_code: 'EGO_TASK_SPACE_USER_IN_CONTROL' }),
    }),
  );
  setPreferredTarget('target-old');

  await ego.createTab('https://example.test/');

  expect(state.preferredTargetId).toBe('target-old');
});

test('re-selecting the same Space keeps sessions; another Space invalidates them', async () => {
  const ego = install(new FakeBindings({ cdp: answerAll }));

  ego.useTaskSpace(1);
  expect(await ensureSession('target-a')).toBe('session:target-a');
  expect(attachCount(ego)).toBe(1);

  setPreferredTarget('target-a');
  ego.useTaskSpace(1);
  expect(await ensureSession('target-a')).toBe('session:target-a');
  expect(attachCount(ego), 'the same Space must keep its CDP session').toBe(1);
  expect(state.preferredTargetId).toBe('target-a');

  ego.useTaskSpace(2);
  expect(state.preferredTargetId).toBeNull();
  expect(await ensureSession('target-a')).toBe('session:target-a');
  expect(attachCount(ego), 'another Space must attach again').toBe(2);
  expect(ego.calls.filter(([name]) => name === 'useTaskSpace')).toEqual([
    ['useTaskSpace', 1],
    ['useTaskSpace', 1],
    ['useTaskSpace', 2],
  ]);
});

test('closing, creating or claiming a Space invalidates sessions and the selection', async () => {
  const ego = install(new FakeBindings({ cdp: answerAll }));
  const operations: [string, () => Promise<unknown>][] = [
    ['closeTaskSpace', () => ego.closeTaskSpace()],
    ['createTaskSpace', () => ego.createTaskSpace('research')],
    ['claimTaskSpace', () => ego.claimTaskSpace(3, 'research')],
  ];

  let attaches = 0;
  for (const [name, operation] of operations) {
    ego.useTaskSpace(1);
    await ensureSession('target-a');
    attaches += 1;
    expect(attachCount(ego), name).toBe(attaches);
    setPreferredTarget('target-a');

    await operation();

    expect(state.preferredTargetId, name).toBeNull();
    // The selection was reset too: selecting the same Space again starts from scratch.
    ego.useTaskSpace(1);
    await ensureSession('target-a');
    attaches += 1;
    expect(attachCount(ego), name).toBe(attaches);
    invalidateSession();
    attaches = attachCount(ego);
  }
  expect(
    ego.calls.filter(([name]) => name.endsWith('TaskSpace') && name !== 'useTaskSpace'),
  ).toEqual([
    ['closeTaskSpace'],
    ['createTaskSpace', 'research'],
    ['claimTaskSpace', 3, 'research'],
  ]);
});

test('installing twice does not wrap the bindings twice', () => {
  const ego = install(new FakeBindings());
  const names = [
    'createTab',
    'useTaskSpace',
    'closeTaskSpace',
    'createTaskSpace',
    'claimTaskSpace',
  ];
  const methods = (): unknown[] => names.map((name): unknown => Reflect.get(ego, name));
  const wrapped = methods();
  // The wrappers are own properties of the bindings object, unlike the class methods.
  expect(names.every((name) => Object.hasOwn(ego, name))).toBe(true);

  installEgoSdk(globalThis);

  const after = methods();
  expect(after.every((method, index) => method === wrapped[index])).toBe(true);
});
