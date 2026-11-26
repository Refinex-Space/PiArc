// A session's Git state for the panel and the rail card (ADR-0084): the status, the changes of
// each scope, the branch's commits and the branches, each with its loading and failure. Data
// comes only from Core; a refresh keeps the previous answer on screen until the next arrives,
// and an answer older than one already applied is dropped. `core/git` events tell sessions of
// the same repository that an operation changed it, and carry progress for operations.
import { useCallback, useSyncExternalStore } from 'react';

import {
  DEFAULT_DISPLAY,
  scopeKey,
  type DisplayPrefs,
  type ScopeChoice,
  gitScope,
} from './model.js';
import {
  branchesOf,
  changesOf,
  commitsOf,
  gitCall,
  probeOf,
  statusOf,
  type Branches,
  type Changes,
  type Commits,
  type Failure,
  type Reply,
  type Status,
} from './protocol.js';

/** One answer and its request's state. */
export interface Load<T> {
  readonly value?: T | undefined;
  readonly failure?: Failure | undefined;
  readonly loading: boolean;
  /** The value was read before the repository last changed. */
  readonly stale: boolean;
}

const EMPTY: Load<never> = { loading: false, stale: false };

export interface Progress {
  readonly phase: string;
  readonly percent?: number | undefined;
}

export interface GitSnapshot {
  readonly status: Load<Status>;
  readonly changes: ReadonlyMap<string, Load<Changes>>;
  readonly commits: Load<Commits>;
  readonly branches: Load<Branches>;
  /** Progress of running operations, by operation id. */
  readonly progress: ReadonlyMap<string, Progress>;
}

let opCounter = 0;

/** A fresh operation id. */
export function newOpId(): string {
  opCounter += 1;
  return `git-${Date.now().toString(36)}-${opCounter.toString(36)}`;
}

/** The repository's change key: what a reload of the diff depends on. */
function changeKey(status: Status | undefined): string {
  if (status === undefined) return '';
  const r = status.repository;
  const files = status.files.map(
    (f) =>
      `${f.path}:${f.staged ?? ''}:${f.unstaged ?? ''}:${String(f.added ?? '')}:${String(f.removed ?? '')}`,
  );
  return [r.head ?? '', r.branch ?? '', r.base?.mergeBase ?? '', ...files].join('\n');
}

export class GitSession {
  #snapshot: GitSnapshot = {
    status: EMPTY,
    changes: new Map(),
    commits: EMPTY,
    branches: EMPTY,
    progress: new Map(),
  };
  readonly #listeners = new Set<() => void>();
  /** Request generations: an answer applies only if no newer request of its kind started. */
  readonly #generations = new Map<string, number>();
  #fingerprint = '';
  #key = '';

  constructor(readonly sessionId: string) {}

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  snapshot(): GitSnapshot {
    return this.#snapshot;
  }

  #set(next: Partial<GitSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...next };
    for (const listener of this.#listeners) listener();
  }

  #begin(kind: string): number {
    const generation = (this.#generations.get(kind) ?? 0) + 1;
    this.#generations.set(kind, generation);
    return generation;
  }

  #current(kind: string, generation: number): boolean {
    return this.#generations.get(kind) === generation;
  }

  /** The repository root, when known (to match `core/git` events). */
  root(): string | undefined {
    return this.#snapshot.status.value?.repository.root;
  }

  async refreshStatus(): Promise<void> {
    const generation = this.#begin('status');
    this.#set({ status: { ...this.#snapshot.status, loading: true } });
    const reply = await gitCall(this.sessionId, { op: 'status' }, statusOf);
    if (!this.#current('status', generation)) return;
    if (reply.ok) {
      this.#fingerprint = reply.value.fingerprint;
      const key = changeKey(reply.value);
      const changed = key !== this.#key;
      this.#key = key;
      this.#set({ status: { value: reply.value, loading: false, stale: false } });
      if (changed) this.#markStale();
    } else {
      this.#set({ status: { failure: reply.failure, loading: false, stale: false } });
    }
  }

  /** Polls the cheap fingerprint; refreshes the status when the repository moved. */
  async probe(): Promise<void> {
    if (this.#snapshot.status.loading) return;
    const reply = await gitCall(this.sessionId, { op: 'probe' }, probeOf);
    if (reply.ok && reply.value !== this.#fingerprint) await this.refreshStatus();
  }

  #markStale(): void {
    const changes = new Map<string, Load<Changes>>();
    for (const [key, load] of this.#snapshot.changes) changes.set(key, { ...load, stale: true });
    this.#set({
      changes,
      commits: { ...this.#snapshot.commits, stale: true },
      branches: { ...this.#snapshot.branches, stale: true },
    });
  }

  changes(choice: ScopeChoice, ignoreWhitespace: boolean): Load<Changes> {
    return this.#snapshot.changes.get(cacheKey(choice, ignoreWhitespace)) ?? EMPTY;
  }

  /** Loads the scope's changes unless a fresh answer is there (or `force`). */
  async loadChanges(choice: ScopeChoice, ignoreWhitespace: boolean, force = false): Promise<void> {
    const scope = gitScope(choice);
    if (scope === undefined) return;
    const key = cacheKey(choice, ignoreWhitespace);
    const current = this.#snapshot.changes.get(key);
    if (!force && current !== undefined && (current.loading || (!current.stale && current.value)))
      return;
    const generation = this.#begin(`changes:${key}`);
    this.#setChanges(key, { ...(current ?? EMPTY), loading: true });
    const request = ignoreWhitespace
      ? { op: 'changes', scope, ignoreWhitespace: true }
      : { op: 'changes', scope };
    const reply = await gitCall(this.sessionId, request, changesOf);
    if (!this.#current(`changes:${key}`, generation)) return;
    this.#setChanges(key, loadOf(reply, current?.value));
  }

  #setChanges(key: string, load: Load<Changes>): void {
    const changes = new Map(this.#snapshot.changes);
    changes.set(key, load);
    this.#set({ changes });
  }

  async loadCommits(base: string | undefined, force = false): Promise<void> {
    const current = this.#snapshot.commits;
    if (!force && (current.loading || (!current.stale && current.value))) return;
    const generation = this.#begin('commits');
    this.#set({ commits: { ...current, loading: true } });
    const reply = await gitCall(
      this.sessionId,
      base === undefined ? { op: 'commits' } : { op: 'commits', base },
      commitsOf,
    );
    if (!this.#current('commits', generation)) return;
    this.#set({ commits: loadOf(reply, current.value) });
  }

  async loadBranches(force = false): Promise<void> {
    const current = this.#snapshot.branches;
    if (!force && (current.loading || (!current.stale && current.value))) return;
    const generation = this.#begin('branches');
    this.#set({ branches: { ...current, loading: true } });
    const reply = await gitCall(this.sessionId, { op: 'branches' }, branchesOf);
    if (!this.#current('branches', generation)) return;
    this.#set({ branches: loadOf(reply, current.value) });
  }

  /** The repository changed (an operation here or in another window). */
  changed(): void {
    void this.refreshStatus();
    this.#markStale();
  }

  setProgress(opId: string, progress: Progress | undefined): void {
    const next = new Map(this.#snapshot.progress);
    if (progress === undefined) next.delete(opId);
    else next.set(opId, progress);
    this.#set({ progress: next });
  }
}

function cacheKey(choice: ScopeChoice, ignoreWhitespace: boolean): string {
  return `${scopeKey(choice)}|${ignoreWhitespace ? 'w' : ''}`;
}

function loadOf<T>(reply: Reply<T>, previous: T | undefined): Load<T> {
  return reply.ok
    ? { value: reply.value, loading: false, stale: false }
    : { value: previous, failure: reply.failure, loading: false, stale: false };
}

const sessions = new Map<string, GitSession>();
let listening = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `core/git` events: progress to the session that runs the operation, changes to every
 * session of the same repository. */
function listen(): void {
  // Unit tests render without a preload: there are no events to follow.
  if (listening || typeof window === 'undefined' || !('piarc' in window)) return;
  listening = true;
  void window.piarc.subscribeEvents('core/git', (batch) => {
    let events: unknown;
    try {
      events = JSON.parse(new TextDecoder().decode(batch.payload));
    } catch {
      return;
    }
    if (!Array.isArray(events)) return;
    for (const event of events) {
      if (!isRecord(event)) continue;
      if (event.type === 'changed' && typeof event.root === 'string') {
        for (const session of sessions.values())
          if (session.root() === event.root) session.changed();
      } else if (
        event.type === 'progress' &&
        typeof event.sessionId === 'string' &&
        typeof event.opId === 'string' &&
        typeof event.phase === 'string'
      ) {
        sessions.get(event.sessionId)?.setProgress(event.opId, {
          phase: event.phase,
          percent: typeof event.percent === 'number' ? event.percent : undefined,
        });
      }
    }
  });
}

/** Session `sessionId`'s Git state (one per session for the window's lifetime). */
export function gitSession(sessionId: string): GitSession {
  listen();
  let session = sessions.get(sessionId);
  if (session === undefined) {
    session = new GitSession(sessionId);
    sessions.set(sessionId, session);
  }
  return session;
}

/** Re-renders on every change of session `sessionId`'s Git state. */
export function useGit(sessionId: string): GitSnapshot {
  const session = gitSession(sessionId);
  const subscribe = useCallback((l: () => void) => session.subscribe(l), [session]);
  return useSyncExternalStore(subscribe, () => session.snapshot());
}

export { DEFAULT_DISPLAY, type DisplayPrefs };
