// Ported from ego-browser package/ego-browser/src/native-gate.test.mjs (ego-lite commit 56589ea8,
// MIT, see LICENSE). PiArc: Vitest. Without AsyncLocalStorage the gate judges by Space alone, so
// upstream's "rejects nested selection of another space" became "queues another space until the
// lease is released", and a same-space call during a lease joins it (both tested below).

import { expect, test } from 'vitest';

import { NativeOperationGate, type PageExecutionContext } from './native-gate.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function turn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function unusedSession(): Promise<string> {
  return Promise.reject(new Error('not used'));
}

test('NativeOperationGate holds the selected space for the full operation', async () => {
  const firstMayFinish = deferred();
  const log: string[] = [];
  let selectedSpace: number | null = null;
  let activeOperations = 0;
  let maxActiveOperations = 0;
  const gate = new NativeOperationGate({
    selectSpace(spaceId) {
      selectedSpace = spaceId;
      log.push(`select:${String(spaceId)}`);
    },
    ensureSession: unusedSession,
  });

  const first = gate.withSpace(1, async ({ spaceId }) => {
    activeOperations += 1;
    maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
    log.push(`start:${String(spaceId)}`);
    expect(selectedSpace).toBe(1);
    await firstMayFinish.promise;
    expect(selectedSpace, 'space must not change while work is pending').toBe(1);
    log.push(`end:${String(spaceId)}`);
    activeOperations -= 1;
    return 'first';
  });
  const second = gate.withSpace(2, ({ spaceId }) => {
    activeOperations += 1;
    maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
    log.push(`start:${String(spaceId)}`);
    expect(selectedSpace).toBe(2);
    log.push(`end:${String(spaceId)}`);
    activeOperations -= 1;
    return 'second';
  });

  await turn();
  expect(log).toEqual(['select:1', 'start:1']);
  firstMayFinish.resolve();

  expect(await Promise.all([first, second])).toEqual(['first', 'second']);
  expect(maxActiveOperations).toBe(1);
  expect(log).toEqual(['select:1', 'start:1', 'end:1', 'select:2', 'start:2', 'end:2']);
});

test('NativeOperationGate releases the queue after an operation fails', async () => {
  const selected: number[] = [];
  const gate = new NativeOperationGate({
    selectSpace(spaceId) {
      selected.push(spaceId);
    },
    ensureSession: unusedSession,
  });

  const failed = gate.withSpace(1, () => Promise.reject(new Error('operation failed')));
  const recovered = gate.withSpace(2, () => 'recovered');

  await expect(failed).rejects.toThrow(/operation failed/);
  expect(await recovered).toBe('recovered');
  expect(selected).toEqual([1, 2]);
});

test('NativeOperationGate releases the queue after space selection fails', async () => {
  const gate = new NativeOperationGate({
    selectSpace(spaceId) {
      if (spaceId === 1) throw new Error('selection failed');
    },
    ensureSession: unusedSession,
  });

  const failed = gate.withSpace(1, () => 'never');
  const recovered = gate.withSpace(2, () => 'recovered');

  await expect(failed).rejects.toThrow(/selection failed/);
  expect(await recovered).toBe('recovered');
});

test('NativeOperationGate resolves an explicit page session inside the space lock', async () => {
  const log: string[] = [];
  let selectedSpace: number | null = null;
  const gate = new NativeOperationGate({
    selectSpace(spaceId) {
      selectedSpace = spaceId;
      log.push(`select:${String(spaceId)}`);
    },
    ensureSession(targetId) {
      expect(selectedSpace, 'session attach must run after space selection').toBe(7);
      log.push(`attach:${targetId}`);
      return Promise.resolve('session-a');
    },
  });

  const result = await gate.withPage(
    { spaceId: 7, targetId: 'target-a' },
    (page: PageExecutionContext) => {
      log.push(`run:${page.sessionId}`);
      return page;
    },
  );

  expect(result).toEqual({
    spaceId: 7,
    targetId: 'target-a',
    sessionId: 'session-a',
  });
  expect(log).toEqual(['select:7', 'attach:target-a', 'run:session-a']);
});

test('NativeOperationGate reuses same-space ownership for nested operations', async () => {
  const log: string[] = [];
  const gate = new NativeOperationGate({
    selectSpace(spaceId) {
      log.push(`select:${String(spaceId)}`);
    },
    ensureSession(targetId) {
      log.push(`attach:${targetId}`);
      return Promise.resolve(`session:${targetId}`);
    },
  });

  const result = await gate.withSpace(7, () =>
    gate.withPage({ spaceId: 7, targetId: 'target-a' }, ({ sessionId }) => {
      log.push(`run:${sessionId}`);
      return 'nested';
    }),
  );

  expect(result).toBe('nested');
  expect(log).toEqual(['select:7', 'attach:target-a', 'run:session:target-a']);
});

test('NativeOperationGate queues another space until the lease is released', async () => {
  const outerMayFinish = deferred();
  const log: string[] = [];
  const gate = new NativeOperationGate({
    selectSpace(spaceId) {
      log.push(`select:${String(spaceId)}`);
    },
    ensureSession: unusedSession,
  });

  const outer = gate.withSpace(7, async () => {
    log.push('start:7');
    await outerMayFinish.promise;
    log.push('end:7');
  });
  const other = gate.withSpace(8, () => {
    log.push('run:8');
    return 'other';
  });

  await turn();
  expect(log).toEqual(['select:7', 'start:7']);
  outerMayFinish.resolve();
  await outer;
  expect(await other).toBe('other');
  expect(log).toEqual(['select:7', 'start:7', 'end:7', 'select:8', 'run:8']);
  expect(await gate.withSpace(9, () => 'recovered')).toBe('recovered');
});

test('NativeOperationGate keeps the lease until every joined same-space call finishes', async () => {
  const joinedMayFinish = deferred();
  const log: string[] = [];
  const gate = new NativeOperationGate({
    selectSpace(spaceId) {
      log.push(`select:${String(spaceId)}`);
    },
    ensureSession: unusedSession,
  });

  let joined: Promise<void> = Promise.resolve();
  await gate.withSpace(7, () => {
    // Started by the operation but not awaited by it.
    joined = gate.withSpace(7, async () => {
      log.push('joined:start');
      await joinedMayFinish.promise;
      log.push('joined:end');
    });
  });
  const other = gate.withSpace(8, () => {
    log.push('run:8');
  });

  await turn();
  expect(log).toEqual(['select:7', 'joined:start']);
  joinedMayFinish.resolve();
  await Promise.all([joined, other]);
  expect(log).toEqual(['select:7', 'joined:start', 'joined:end', 'select:8', 'run:8']);
});

test('NativeOperationGate forwards the withPage session budget to ensureSession', async () => {
  const budgets: (number | undefined)[] = [];
  const gate = new NativeOperationGate({
    selectSpace() {
      return undefined;
    },
    ensureSession(targetId, timeoutMs) {
      budgets.push(timeoutMs);
      return Promise.resolve(`session:${targetId}`);
    },
  });

  await gate.withPage({ spaceId: 7, targetId: 'target-a' }, () => 'a');
  await gate.withPage({ spaceId: 7, targetId: 'target-a' }, () => 'b', {
    sessionTimeoutMs: 1_234,
  });

  expect(budgets).toEqual([undefined, 1_234]);
});
