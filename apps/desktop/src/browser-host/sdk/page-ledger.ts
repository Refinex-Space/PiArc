// Ported from ego-browser package/ego-browser/src/page-ledger.ts (ego-lite commit 56589ea8, MIT,
// see LICENSE). PiArc: the host has no file system, so the ledger is one JSON document per Space
// kept by the main process (`ego.ledgerLoad` / `ego.ledgerSave` through an injectable storage
// port). The versioned files, lock retries, write conflicts, browser instance ids
// (`runtimeInstanceId`) and stale-file cleanup are gone; in-process updates of one Space are
// serialized per storage instead. Ledger semantics (labels, reconcile, user control) unchanged.

import { invokeEgo } from './ego-errors.js';
import { validatePageRefState, type PageRefState } from './page-ref-registry.js';

export type PageOrigin = 'agent' | 'unknown';

export interface PageLedgerEntry {
  targetId: string;
  openedBy: PageOrigin;
  refs?: PageRefState;
}

export interface ManagedPage extends PageLedgerEntry {
  label: string;
}

export interface PageLedger {
  spaceId: number;
  nextLabel: number;
  usedLabels: string[];
  releasedLabels: string[];
  initialized: boolean;
  userControlPending: boolean;
  unmanagedTargets: Record<string, PageOrigin>;
  /** Agent tabs an earlier finish() left open for the user. */
  retainedTargets: string[];
  pages: Record<string, PageLedgerEntry>;
}

/**
 * Where ledgers live: one JSON document per Space. `load` answers null (or an empty string)
 * when the Space has none; `save` with an empty string discards it.
 */
export interface PageLedgerStorage {
  load(spaceId: number): Promise<string | null>;
  save(spaceId: number, data: string): Promise<void>;
}

interface PageLedgerStoreOptions {
  /** Defaults to the main process through `globalThis.ego`. */
  storage?: PageLedgerStorage;
}

interface AddPageOptions {
  as?: string;
  openedBy?: PageOrigin;
}

interface ReconcileOptions {
  autoAdoptNew?: boolean;
  afterUserControl?: boolean;
}

/** The main process keeps each Space's ledger in memory for the app's lifetime. */
const bindingsStorage: PageLedgerStorage = {
  async load(spaceId) {
    const ego = globalThis.ego;
    if (!ego) throw new Error('page ledger requires ego.ledgerLoad');
    return invokeEgo('page ledger', () => ego.ledgerLoad(spaceId));
  },
  async save(spaceId, data) {
    const ego = globalThis.ego;
    if (!ego) throw new Error('page ledger requires ego.ledgerSave');
    await invokeEgo('page ledger', () => ego.ledgerSave(spaceId, data));
  },
};

/**
 * Updates queued per storage and Space. Upstream's numbered versions let concurrent writers
 * detect each other; with one document per Space, every store sharing a storage serializes its
 * read-modify-write cycles on that Space instead, so no update is lost.
 */
const updateQueues = new WeakMap<PageLedgerStorage, Map<number, Promise<unknown>>>();

/**
 * Stores durable page labels in one JSON document per task space. Space ids are only meaningful
 * within one PiArc run, and the main process keeps the documents in memory for that run, so a
 * restarted app starts with no ledgers.
 */
export class PageLedgerStore {
  readonly #storage: PageLedgerStorage;

  constructor(options: PageLedgerStoreOptions = {}) {
    this.#storage = options.storage ?? bindingsStorage;
  }

  async read(spaceId: number): Promise<PageLedger> {
    assertSpaceId(spaceId);
    const ledger = await this.#readCurrent(spaceId);
    return cloneLedger(ledger);
  }

  /** Replace any stale state for a newly created space with its Agent-owned p1. */
  async initializeCreatedSpace(spaceId: number, targetId: string): Promise<ManagedPage> {
    assertSpaceId(spaceId);
    assertTargetId(targetId);
    return this.#serialized(spaceId, async () => {
      const ledger = emptyLedger(spaceId);
      const label = nextAutomaticLabel(ledger, new Set());
      const entry: PageLedgerEntry = { targetId, openedBy: 'agent' };
      ledger.initialized = true;
      ledger.usedLabels.push(label);
      ledger.pages[label] = entry;
      await this.#write(spaceId, ledger);
      return { label, ...entry };
    });
  }

  /** Remove all Page-model state after its task space is finished or closed. */
  async discard(spaceId: number): Promise<void> {
    assertSpaceId(spaceId);
    await this.#serialized(spaceId, () => this.#storage.save(spaceId, ''));
  }

  /**
   * End a task whose space stays open for the user. Labels end with the task,
   * but the origin of the tabs the agent left open survives so a later claim
   * does not mistake them for user tabs. The ledger stays uninitialized: every
   * other tab found at the claim is still treated as unknown.
   */
  async retainForUser(spaceId: number, targetIds: string[]): Promise<void> {
    assertSpaceId(spaceId);
    targetIds.forEach(assertTargetId);
    const ledger = emptyLedger(spaceId);
    for (const targetId of targetIds) {
      ledger.unmanagedTargets[targetId] = 'agent';
    }
    ledger.retainedTargets = [...targetIds];
    await this.#serialized(spaceId, () => this.#write(spaceId, ledger));
  }

  async getPage(spaceId: number, label: string): Promise<ManagedPage> {
    assertLabel(label);
    const ledger = await this.read(spaceId);
    const entry = ledger.pages[label];
    if (entry) return { label, ...entry };
    if (ledger.releasedLabels.includes(label)) {
      throw new Error(`page ${label} was released`);
    }
    if (ledger.usedLabels.includes(label)) {
      throw new Error(`page ${label} was closed`);
    }
    throw new Error(`page label not found: ${label}`);
  }

  async addPage(
    spaceId: number,
    targetId: string,
    options: AddPageOptions = {},
  ): Promise<ManagedPage> {
    assertTargetId(targetId);
    if (options.as !== undefined) assertLabel(options.as);
    let added: ManagedPage | undefined;
    await this.#update(spaceId, (ledger) => {
      const existing = Object.entries(ledger.pages).find(([, page]) => page.targetId === targetId);
      if (existing) {
        throw new Error(`target ${targetId} is already page ${existing[0]}`);
      }

      const used = new Set(ledger.usedLabels);
      const label = options.as ?? nextAutomaticLabel(ledger, used);
      if (used.has(label)) {
        throw new Error(`page label already used: ${label}`);
      }
      const entry: PageLedgerEntry = {
        targetId,
        openedBy: options.openedBy ?? 'agent',
      };
      ledger.initialized = true;
      Reflect.deleteProperty(ledger.unmanagedTargets, targetId);
      ledger.usedLabels.push(label);
      ledger.pages[label] = entry;
      added = { label, ...entry };
    });
    return definedResult(added);
  }

  async setPageRefs(spaceId: number, label: string, refs: PageRefState): Promise<void> {
    assertLabel(label);
    await this.#update(spaceId, (ledger) => {
      const page = ledger.pages[label];
      if (!page) throw new Error(`page label not found: ${label}`);
      page.refs = validatePageRefState(refs);
    });
  }

  async closePage(spaceId: number, label: string): Promise<ManagedPage> {
    assertLabel(label);
    let removed: ManagedPage | undefined;
    await this.#update(spaceId, (ledger) => {
      const entry = ledger.pages[label];
      if (!entry) {
        if (ledger.releasedLabels.includes(label)) {
          throw new Error(`page ${label} was released`);
        }
        if (ledger.usedLabels.includes(label)) {
          throw new Error(`page ${label} was closed`);
        }
        throw new Error(`page label not found: ${label}`);
      }
      removed = { label, ...entry };
      Reflect.deleteProperty(ledger.pages, label);
    });
    return definedResult(removed);
  }

  async releasePage(spaceId: number, label: string): Promise<ManagedPage> {
    assertLabel(label);
    let removed: ManagedPage | undefined;
    await this.#update(spaceId, (ledger) => {
      const entry = ledger.pages[label];
      if (!entry) {
        if (ledger.releasedLabels.includes(label)) {
          throw new Error(`page ${label} was released`);
        }
        if (ledger.usedLabels.includes(label)) {
          throw new Error(`page ${label} was closed`);
        }
        throw new Error(`page label not found: ${label}`);
      }
      removed = { label, ...entry };
      Reflect.deleteProperty(ledger.pages, label);
      ledger.releasedLabels.push(label);
      ledger.unmanagedTargets[entry.targetId] = entry.openedBy;
    });
    return definedResult(removed);
  }

  async keepUnmanaged(
    spaceId: number,
    targetId: string,
    openedBy: PageOrigin = 'unknown',
  ): Promise<void> {
    assertTargetId(targetId);
    if (!isPageOrigin(openedBy)) {
      throw new TypeError(`invalid unmanaged page origin: ${String(openedBy)}`);
    }
    await this.#update(spaceId, (ledger) => {
      const existing = Object.entries(ledger.pages).find(([, page]) => page.targetId === targetId);
      if (existing) {
        throw new Error(`target ${targetId} is already page ${existing[0]}`);
      }
      ledger.initialized = true;
      ledger.unmanagedTargets[targetId] = openedBy;
    });
  }

  /** Mark the next reconciliation as crossing a user-control boundary. */
  async beginUserControl(spaceId: number): Promise<void> {
    await this.#update(spaceId, (ledger) => {
      ledger.userControlPending = true;
    });
  }

  /** Roll back a boundary marker when the native handoff itself fails. */
  async cancelUserControl(spaceId: number): Promise<void> {
    await this.#update(spaceId, (ledger) => {
      ledger.userControlPending = false;
    });
  }

  async reconcile(
    spaceId: number,
    liveTargetIds: Iterable<string>,
    options: ReconcileOptions = {},
  ): Promise<PageLedger> {
    const live = new Set(liveTargetIds);
    const current = await this.read(spaceId);
    const hasMissingPage = Object.values(current.pages).some((page) => !live.has(page.targetId));
    const hasMissingUnmanaged = Object.keys(current.unmanagedTargets).some(
      (targetId) => !live.has(targetId),
    );
    const knownTargets = new Set([
      ...Object.values(current.pages).map((page) => page.targetId),
      ...Object.keys(current.unmanagedTargets),
    ]);
    const newTargets = [...live].filter((targetId) => !knownTargets.has(targetId));
    const needsInitialization = !current.initialized;
    const protectsUserTabs = options.afterUserControl === true || current.userControlPending;
    const shouldAdopt =
      current.initialized &&
      options.autoAdoptNew === true &&
      !protectsUserTabs &&
      newTargets.length > 0;
    if (
      !hasMissingPage &&
      !hasMissingUnmanaged &&
      !needsInitialization &&
      !protectsUserTabs &&
      !shouldAdopt
    ) {
      return current;
    }

    return this.#update(spaceId, (ledger) => {
      for (const [label, page] of Object.entries(ledger.pages)) {
        if (!live.has(page.targetId)) Reflect.deleteProperty(ledger.pages, label);
      }
      for (const targetId of Object.keys(ledger.unmanagedTargets)) {
        if (!live.has(targetId)) Reflect.deleteProperty(ledger.unmanagedTargets, targetId);
      }
      ledger.retainedTargets = ledger.retainedTargets.filter((targetId) => live.has(targetId));

      const managedTargets = new Set(Object.values(ledger.pages).map((page) => page.targetId));
      const untracked = [...live].filter(
        (targetId) =>
          !managedTargets.has(targetId) && !Object.hasOwn(ledger.unmanagedTargets, targetId),
      );
      if (!ledger.initialized) {
        // The first observable tab set is the control boundary. It may contain
        // user pages from before claim/takeover, so preserve it rather than
        // guessing that those tabs were opened by the current agent.
        for (const targetId of untracked) {
          ledger.unmanagedTargets[targetId] = 'unknown';
        }
        ledger.initialized = true;
        ledger.userControlPending = false;
        return;
      }
      if (protectsUserTabs) {
        for (const targetId of untracked) {
          ledger.unmanagedTargets[targetId] = 'unknown';
        }
        ledger.userControlPending = false;
        return;
      }
      if (options.autoAdoptNew !== true) return;

      const used = new Set(ledger.usedLabels);
      for (const targetId of untracked) {
        const label = nextAutomaticLabel(ledger, used);
        used.add(label);
        ledger.usedLabels.push(label);
        ledger.pages[label] = {
          targetId,
          openedBy: 'agent',
        };
      }
    });
  }

  async #update(spaceId: number, mutate: (ledger: PageLedger) => void): Promise<PageLedger> {
    assertSpaceId(spaceId);
    return this.#serialized(spaceId, async () => {
      const ledger = await this.#readCurrent(spaceId);
      mutate(ledger);
      await this.#write(spaceId, ledger);
      return cloneLedger(ledger);
    });
  }

  /**
   * The current ledger. A document that does not parse reads as no ledger, as upstream skips a
   * version that is still being written; a parsed document with the wrong shape is reported.
   */
  async #readCurrent(spaceId: number): Promise<PageLedger> {
    const raw = await this.#storage.load(spaceId);
    if (raw === null || raw === '') return emptyLedger(spaceId);
    let stored: unknown;
    try {
      stored = JSON.parse(raw);
    } catch {
      return emptyLedger(spaceId);
    }
    return validateLedger(stored, spaceId, `space ${String(spaceId)}`);
  }

  async #write(spaceId: number, ledger: PageLedger): Promise<void> {
    await this.#storage.save(spaceId, `${JSON.stringify(ledger, null, 2)}\n`);
  }

  /** Run one read-modify-write cycle after every earlier one on the same storage and Space. */
  #serialized<T>(spaceId: number, operation: () => Promise<T>): Promise<T> {
    let queues = updateQueues.get(this.#storage);
    if (!queues) {
      queues = new Map();
      updateQueues.set(this.#storage, queues);
    }
    const previous = queues.get(spaceId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    queues.set(spaceId, tail);
    void tail.then(() => {
      if (queues.get(spaceId) === tail) queues.delete(spaceId);
    });
    return result;
  }
}

function emptyLedger(spaceId: number): PageLedger {
  return {
    spaceId,
    nextLabel: 1,
    usedLabels: [],
    releasedLabels: [],
    initialized: false,
    userControlPending: false,
    unmanagedTargets: {},
    retainedTargets: [],
    pages: {},
  };
}

function nextAutomaticLabel(ledger: PageLedger, used: Set<string>): string {
  let sequence = ledger.nextLabel;
  let label = `p${String(sequence)}`;
  while (used.has(label)) {
    sequence += 1;
    label = `p${String(sequence)}`;
  }
  ledger.nextLabel = sequence + 1;
  return label;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

const STORED_ORIGINS: readonly unknown[] = ['agent', 'user', 'unknown'];

function validateLedger(value: unknown, expectedSpaceId: number, path: string): PageLedger {
  if (!isObject(value)) {
    throw new Error(`invalid page ledger ${path}: expected an object`);
  }
  const stored = value;
  // Defaults keep ledgers written by earlier runtimes readable. They start
  // uninitialized so the first new runtime observes a safe control baseline
  // instead of silently adopting pre-existing user tabs.
  const usedLabels = stored.usedLabels;
  const nextLabel = stored.nextLabel;
  const storedPages = stored.pages;
  const releasedLabels = stored.releasedLabels ?? [];
  const initialized = stored.initialized ?? false;
  const legacyHandoffBaseline = stored.handoffBaseline;
  const userControlPending =
    stored.userControlPending ??
    (legacyHandoffBaseline !== undefined && legacyHandoffBaseline !== null);
  const unmanagedTargets = stored.unmanagedTargets ?? {};
  const retainedTargets = stored.retainedTargets ?? [];
  if (
    stored.spaceId !== expectedSpaceId ||
    typeof nextLabel !== 'number' ||
    !Number.isInteger(nextLabel) ||
    nextLabel < 1 ||
    !isStringArray(usedLabels) ||
    !isStringArray(releasedLabels) ||
    releasedLabels.some(
      (label) =>
        !usedLabels.includes(label) || (isObject(storedPages) && Object.hasOwn(storedPages, label)),
    ) ||
    typeof initialized !== 'boolean' ||
    typeof userControlPending !== 'boolean' ||
    (legacyHandoffBaseline !== undefined &&
      legacyHandoffBaseline !== null &&
      (!Array.isArray(legacyHandoffBaseline) ||
        legacyHandoffBaseline.some(
          (targetId) => typeof targetId !== 'string' || targetId.length === 0,
        ))) ||
    !isObject(unmanagedTargets) ||
    Object.entries(unmanagedTargets).some(
      ([targetId, openedBy]) => targetId.length === 0 || !STORED_ORIGINS.includes(openedBy),
    ) ||
    !isStringArray(retainedTargets) ||
    retainedTargets.some((targetId) => targetId.length === 0) ||
    !isObject(storedPages)
  ) {
    throw new Error(`invalid page ledger ${path}: schema mismatch`);
  }
  const pages: Record<string, PageLedgerEntry> = {};
  for (const [label, page] of Object.entries(storedPages)) {
    if (
      !usedLabels.includes(label) ||
      !isObject(page) ||
      typeof page.targetId !== 'string' ||
      !STORED_ORIGINS.includes(page.openedBy)
    ) {
      throw new Error(`invalid page ledger ${path}: invalid page ${label}`);
    }
    if (Object.hasOwn(unmanagedTargets, page.targetId)) {
      throw new Error(
        `invalid page ledger ${path}: target ${page.targetId} is both managed and unmanaged`,
      );
    }
    pages[label] = {
      targetId: page.targetId,
      openedBy: normalizePageOrigin(page.openedBy),
      ...(page.refs === undefined ? {} : { refs: validatePageRefState(page.refs) }),
    };
  }
  const normalizedUnmanagedTargets = Object.fromEntries(
    Object.entries(unmanagedTargets).map(([targetId, openedBy]) => [
      targetId,
      normalizePageOrigin(openedBy),
    ]),
  );
  return {
    spaceId: expectedSpaceId,
    nextLabel,
    usedLabels: [...usedLabels],
    releasedLabels: [...releasedLabels],
    initialized,
    userControlPending,
    unmanagedTargets: normalizedUnmanagedTargets,
    retainedTargets: [...retainedTargets],
    pages,
  };
}

function normalizePageOrigin(value: unknown): PageOrigin {
  return value === 'agent' ? 'agent' : 'unknown';
}

function isPageOrigin(value: unknown): value is PageOrigin {
  return value === 'agent' || value === 'unknown';
}

function cloneLedger(ledger: PageLedger): PageLedger {
  return structuredClone(ledger);
}

/** The value an update callback assigned; the callback either assigns it or throws. */
function definedResult(page: ManagedPage | undefined): ManagedPage {
  if (page === undefined) throw new Error('page ledger update produced no page');
  return page;
}

function assertSpaceId(spaceId: number): void {
  if (!Number.isInteger(spaceId) || spaceId < 0) {
    throw new TypeError('spaceId must be a non-negative integer');
  }
}

function assertTargetId(targetId: unknown): void {
  if (typeof targetId !== 'string' || targetId.length === 0) {
    throw new TypeError('targetId must be a non-empty string');
  }
}

function assertLabel(label: unknown): void {
  if (typeof label !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(label)) {
    throw new TypeError(
      'page label must start with a letter and contain only letters, numbers, _ or -',
    );
  }
}
