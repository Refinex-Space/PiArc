// Ported from ego-browser package/ego-browser/src/page-ref-registry.ts (ego-lite commit 56589ea8,
// MIT, see LICENSE). PiArc: typed refs (`SnapshotRef`, `StoredRef` exported), persisted state is
// validated from `unknown`; behavior unchanged.

import { isRecord } from './cdp-types.js';
import { RefMap, type FrameProvenance } from './ref-map.js';

const MAX_INVALIDATED_REFS_PER_TARGET = 10_000;

/** One ref as a snapshot reports it; `merge`/`replace` rewrite `refId` to the public id. */
export interface SnapshotRef {
  refId?: string | number | undefined;
  backendNodeId?: number | undefined;
  frameId?: string | undefined;
  frameProvenance?: FrameProvenance | undefined;
  role?: string | undefined;
  name?: string | undefined;
  documentId?: string | undefined;
}

export interface StoredRef extends Omit<SnapshotRef, 'refId'> {
  refId: string;
  active: boolean;
}

export interface PageRefState {
  nextRef: number;
  refs: StoredRef[];
}

/** Public Page refs retain node identity even when native snapshot ids restart. */
export class PageRefRegistry {
  readonly #targets = new Map<string, RefMap>();
  readonly #states = new Map<string, PageRefState>();

  forTarget(targetId: string): RefMap {
    assertTargetId(targetId);
    let refs = this.#targets.get(targetId);
    if (!refs) {
      refs = new RefMap({ allowFallback: false });
      this.#targets.set(targetId, refs);
    }
    return refs;
  }

  replace(targetId: string, snapshotRefs: readonly (SnapshotRef | null)[] = []): RefMap {
    return this.#register(targetId, snapshotRefs, true);
  }

  merge(targetId: string, snapshotRefs: readonly (SnapshotRef | null)[] = []): RefMap {
    return this.#register(targetId, snapshotRefs, false);
  }

  exportState(targetId: string): PageRefState | undefined {
    return structuredClone(this.#states.get(targetId));
  }

  restore(targetId: string, state?: PageRefState): void {
    this.clear(targetId);
    if (state) this.#states.set(targetId, validatePageRefState(state));
    this.#rebuild(targetId);
  }

  invalidateChangedDocuments(targetId: string, documents: Map<string, string>): void {
    const state = this.#states.get(targetId);
    if (!state) return;
    for (const ref of state.refs) {
      if (!ref.documentId || ref.documentId !== pageRefDocumentId(ref, documents)) {
        ref.active = false;
      }
    }
    this.#rebuild(targetId);
  }

  #register(
    targetId: string,
    snapshotRefs: readonly (SnapshotRef | null)[],
    replace: boolean,
  ): RefMap {
    assertTargetId(targetId);
    const state: PageRefState = this.#states.get(targetId) ?? { nextRef: 1, refs: [] };
    const byIdentity = new Map(
      state.refs
        .filter((ref) => ref.frameProvenance !== 'unknown')
        .map((ref) => [nodeIdentity(ref), ref]),
    );
    const byId = new Map(state.refs.map((ref) => [ref.refId, ref]));
    const firstUnused = state.nextRef;
    if (replace) for (const ref of state.refs) ref.active = false;
    for (const ref of snapshotRefs) {
      const backendNodeId = ref?.backendNodeId;
      if (
        !ref ||
        backendNodeId === undefined ||
        !Number.isSafeInteger(backendNodeId) ||
        backendNodeId <= 0
      )
        continue;
      // Unknown frame provenance cannot establish identity across snapshots.
      const previous =
        ref.frameProvenance === 'unknown' ? undefined : byIdentity.get(nodeIdentity(ref));
      let refId = previous?.refId;
      if (refId === undefined) {
        const nativeId = Number(ref.refId ?? backendNodeId);
        const candidate =
          Number.isSafeInteger(nativeId) && nativeId >= firstUnused && !byId.has(String(nativeId))
            ? nativeId
            : state.nextRef;
        refId = String(candidate);
        state.nextRef = Math.max(state.nextRef, candidate + 1);
        if (!Number.isSafeInteger(state.nextRef)) throw new Error('Page ref ids exhausted');
      }
      ref.refId = Number(refId);
      const stored: StoredRef = {
        refId,
        backendNodeId,
        role: ref.role,
        name: ref.name,
        frameId: ref.frameId,
        frameProvenance: ref.frameProvenance,
        documentId: ref.documentId,
        active: true,
      };
      byId.set(refId, stored);
      byIdentity.set(nodeIdentity(stored), stored);
    }
    state.refs = [...byId.values()];
    this.#states.set(targetId, state);
    return this.#rebuild(targetId);
  }

  invalidate(targetId: string): void {
    assertTargetId(targetId);
    const state = this.#states.get(targetId);
    if (state) for (const ref of state.refs) ref.active = false;
    this.#rebuild(targetId);
  }

  isInvalidated(targetId: string, refId: string): boolean {
    assertTargetId(targetId);
    return (
      this.#states.get(targetId)?.refs.some((ref) => ref.refId === refId && !ref.active) ?? false
    );
  }

  clear(targetId: string): void {
    assertTargetId(targetId);
    this.#targets.delete(targetId);
    this.#states.delete(targetId);
  }

  #rebuild(targetId: string): RefMap {
    const refs = new RefMap({ allowFallback: false });
    const state = this.#states.get(targetId);
    if (state) {
      let inactive = state.refs.filter((ref) => !ref.active).length;
      state.refs = state.refs.filter((ref) => {
        if (!ref.active && inactive > MAX_INVALIDATED_REFS_PER_TARGET) {
          inactive--;
          return false;
        }
        if (ref.active)
          refs.addWithFrame(
            ref.refId,
            ref.backendNodeId,
            ref.role,
            ref.name,
            undefined,
            ref.frameId,
            ref.frameProvenance,
          );
        return true;
      });
    }
    this.#targets.set(targetId, refs);
    return refs;
  }
}

const FRAME_PROVENANCES: readonly unknown[] = [undefined, 'page', 'frame', 'unknown'];

/** Reject corrupt persisted mappings instead of reconstructing native ids. */
export function validatePageRefState(value: unknown): PageRefState {
  const ids = new Set<string>();
  const nextRef = isRecord(value) ? value.nextRef : undefined;
  const refs = isRecord(value) ? value.refs : undefined;
  if (
    typeof nextRef !== 'number' ||
    !Number.isSafeInteger(nextRef) ||
    nextRef < 1 ||
    !Array.isArray(refs) ||
    refs.some((ref: unknown) => {
      if (
        !isRecord(ref) ||
        typeof ref.refId !== 'string' ||
        !/^[1-9]\d*$/.test(ref.refId) ||
        ids.has(ref.refId) ||
        Number(ref.refId) >= nextRef ||
        typeof ref.backendNodeId !== 'number' ||
        !Number.isSafeInteger(ref.backendNodeId) ||
        ref.backendNodeId <= 0 ||
        typeof ref.active !== 'boolean' ||
        !FRAME_PROVENANCES.includes(ref.frameProvenance) ||
        [ref.frameId, ref.documentId, ref.role, ref.name].some(
          (field) => field !== undefined && typeof field !== 'string',
        )
      )
        return true;
      ids.add(ref.refId);
      return false;
    })
  )
    throw new Error('Invalid persisted Page refs; take a new snapshot');
  // Every field the type declares was checked above.
  return structuredClone(value) as PageRefState;
}

function nodeIdentity(ref: SnapshotRef): string {
  return JSON.stringify([ref.frameId ?? null, ref.backendNodeId, ref.documentId ?? null]);
}

export function pageRefDocumentId(
  ref: SnapshotRef,
  documents: Map<string, string>,
): string | undefined {
  return ref.frameProvenance === 'unknown'
    ? JSON.stringify([...documents].sort(([a], [b]) => a.localeCompare(b)))
    : documents.get(ref.frameId ?? '');
}

function assertTargetId(targetId: unknown): void {
  if (typeof targetId !== 'string' || targetId.length === 0) {
    throw new TypeError('PageRefRegistry requires a non-empty targetId');
  }
}
