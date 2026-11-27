// Ported from ego-browser package/ego-browser/src/native-gate.ts (ego-lite commit 56589ea8, MIT,
// see LICENSE). PiArc: AsyncLocalStorage is not available in the page, so the gate keeps the
// active lease in an explicit field: a call for the leased Space while the lease is held joins it
// without queueing (upstream: only calls nested in the operation do), a call for another Space
// queues (upstream: a nested one rejects).

import { browserEgo, ensureSession } from './browser-runtime.js';
import { invokeEgo } from './ego-errors.js';

interface SpaceScope {
  spaceId: number;
}

export type PageExecutionContext = SpaceScope & {
  targetId: string;
  sessionId: string;
};

interface NativeGateServices {
  selectSpace(spaceId: number): unknown;
  ensureSession(targetId: string, timeoutMs?: number): Promise<string>;
}

export interface WithPageOptions {
  /** Budget for attaching and preparing the Page session. */
  sessionTimeoutMs?: number;
}

interface PageTarget {
  spaceId: number;
  targetId: string;
}

/** The selected Space held by the running operation and every call that joined it. */
interface GateLease {
  readonly spaceId: number;
  holders: number;
  release(): void;
}

/**
 * Serializes native operations that rely on the process-wide selected task
 * space. The queue covers the entire async operation, so another caller
 * cannot change the selected space while a request is still in flight.
 *
 * Without AsyncLocalStorage the gate cannot tell a call nested in the running
 * operation from a concurrent one, so it judges by Space alone: a call for the
 * leased Space joins the lease (the selection it needs is already in place and
 * cannot change until every holder finishes), a call for another Space waits
 * for the lease to be released.
 */
export class NativeOperationGate {
  readonly #services: NativeGateServices;
  #lease: GateLease | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(services: NativeGateServices) {
    if (typeof services.selectSpace !== 'function') {
      throw new TypeError('NativeOperationGate requires selectSpace');
    }
    if (typeof services.ensureSession !== 'function') {
      throw new TypeError('NativeOperationGate requires ensureSession');
    }
    this.#services = services;
  }

  withSpace<T>(spaceId: number, operation: (scope: SpaceScope) => T | Promise<T>): Promise<T> {
    assertSpaceId(spaceId);
    if (typeof operation !== 'function') {
      throw new TypeError('withSpace requires an operation function');
    }

    const lease = this.#lease;
    if (lease?.spaceId === spaceId) {
      // Joining deliberately bypasses the FIFO because the lease already holds
      // this space. Joined callers that must not overlap still have to await
      // each other; Promise.all here issues concurrent native requests.
      lease.holders += 1;
      return Promise.resolve()
        .then(() => operation({ spaceId }))
        .finally(() => {
          this.#releaseHolder(lease);
        });
    }

    let released: () => void = () => undefined;
    const fullyReleased = new Promise<void>((resolve) => {
      released = resolve;
    });
    const run = async () => {
      try {
        await this.#services.selectSpace(spaceId);
      } catch (error) {
        released();
        throw error;
      }
      const acquired: GateLease = { spaceId, holders: 1, release: released };
      this.#lease = acquired;
      try {
        return await operation({ spaceId });
      } finally {
        // Late work started by the operation but not awaited by it either
        // joined the lease (and keeps it until it finishes) or arrives after
        // the release and queues normally.
        this.#releaseHolder(acquired);
      }
    };
    const result = this.#tail.then(run);
    // The queue is intentionally unbounded and covers long waits: changing the
    // selected space during any in-flight native operation would misroute it.
    // A failure rejects its caller without poisoning later FIFO entries.
    this.#tail = result.then(
      () => fullyReleased,
      () => fullyReleased,
    );
    return result;
  }

  withPage<T>(
    page: PageTarget,
    operation: (context: PageExecutionContext) => T | Promise<T>,
    options: WithPageOptions = {},
  ): Promise<T> {
    if (typeof page !== 'object') {
      throw new TypeError('withPage requires a page target');
    }
    assertSpaceId(page.spaceId);
    if (typeof page.targetId !== 'string' || page.targetId.length === 0) {
      throw new TypeError('withPage requires a non-empty targetId');
    }
    if (typeof operation !== 'function') {
      throw new TypeError('withPage requires an operation function');
    }

    return this.withSpace(page.spaceId, async () => {
      const sessionId = await this.#services.ensureSession(page.targetId, options.sessionTimeoutMs);
      return operation({
        spaceId: page.spaceId,
        targetId: page.targetId,
        sessionId,
      });
    });
  }

  #releaseHolder(lease: GateLease): void {
    lease.holders -= 1;
    if (lease.holders > 0) return;
    if (this.#lease === lease) this.#lease = undefined;
    lease.release();
  }
}

function assertSpaceId(spaceId: number): void {
  if (!Number.isInteger(spaceId) || spaceId < 0) {
    throw new TypeError('spaceId must be a non-negative integer');
  }
}

const defaultGate = new NativeOperationGate({
  async selectSpace(spaceId) {
    const ego = browserEgo();
    if (typeof ego.useTaskSpace !== 'function') {
      throw new Error('withSpace requires ego.useTaskSpace');
    }
    await invokeEgo('withSpace', () => ego.useTaskSpace(spaceId));
  },
  ensureSession,
});

export function withSpace<T>(
  spaceId: number,
  operation: (scope: SpaceScope) => T | Promise<T>,
): Promise<T> {
  return defaultGate.withSpace(spaceId, operation);
}

export function withPage<T>(
  page: PageTarget,
  operation: (context: PageExecutionContext) => T | Promise<T>,
  options: WithPageOptions = {},
): Promise<T> {
  return defaultGate.withPage(page, operation, options);
}
