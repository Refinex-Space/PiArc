// Unsaved text lives with its file and session. A tile may unmount while a save is in flight.
// Keep only those drafts in memory; clean files are released with their last viewer.
import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { reason } from '../shell/errors.js';
import { readProjectFile, saveProjectFile, type ProjectFile } from './api.js';

interface Snapshot {
  file: ProjectFile | undefined;
  draft: string;
  saving: boolean;
  failure: string | undefined;
  conflict: ProjectFile | undefined;
  forced: boolean;
}

const documents = new Map<string, FileDocument>();
let unloadGuard = false;
function warnOnUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
}
function syncUnloadGuard() {
  const needed = Array.from(documents.values()).some((doc) => doc.hasUnsavedWork);
  if (needed === unloadGuard) return;
  unloadGuard = needed;
  if (needed) window.addEventListener('beforeunload', warnOnUnload);
  else window.removeEventListener('beforeunload', warnOnUnload);
}

function keyOf(sessionId: string, path: string) {
  return JSON.stringify([sessionId, path]);
}

export function discardViewerDraft(sessionId: string, path: string) {
  documents.delete(keyOf(sessionId, path));
  syncUnloadGuard();
}

class FileDocument {
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private snapshot: Snapshot = {
    file: undefined,
    draft: '',
    saving: false,
    failure: undefined,
    conflict: undefined,
    forced: false,
  };
  constructor(
    private readonly sessionId: string,
    private readonly path: string,
  ) {}
  readonly get = () => this.snapshot;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    documents.set(keyOf(this.sessionId, this.path), this);
    return () => {
      this.listeners.delete(listener);
      this.releaseClean();
    };
  };
  private get dirty() {
    return this.snapshot.file?.kind === 'text' && this.snapshot.file.text !== this.snapshot.draft;
  }
  get hasUnsavedWork() {
    return this.dirty || this.snapshot.saving;
  }
  private releaseClean() {
    const key = keyOf(this.sessionId, this.path);
    if (!this.listeners.size && !this.dirty && !this.snapshot.saving && documents.get(key) === this)
      documents.delete(key);
  }
  private update(changes: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener();
    this.releaseClean();
    syncUnloadGuard();
  }
  readonly setDraft = (draft: string) => {
    this.update({ draft });
  };
  readonly load = async (force: boolean, discard = false) => {
    if (this.snapshot.saving || (this.dirty && !discard)) return;
    const start = ++this.generation,
      original = this.snapshot.draft;
    try {
      const next = await readProjectFile(this.sessionId, this.path, force);
      if (start !== this.generation || original !== this.snapshot.draft || (this.dirty && !discard))
        return;
      this.update({
        file: next,
        draft: next.text ?? '',
        failure: undefined,
        conflict: undefined,
        forced: force,
      });
    } catch (error) {
      if (start === this.generation) this.update({ failure: reason(error) });
    }
  };
  readonly save = async (override?: ProjectFile, create = false) => {
    const { file, draft, saving } = this.snapshot;
    if (saving || !file || (!this.dirty && !create)) return;
    const base = override ?? file;
    if (!base.editable || (base.kind !== 'text' && base.kind !== 'missing')) return;
    ++this.generation;
    this.update({ saving: true, failure: undefined, conflict: undefined });
    try {
      const saved = await saveProjectFile(this.sessionId, this.path, draft, base.revision ?? null);
      this.update({
        file: { ...base, ...saved, path: this.path, text: draft, kind: 'text', editable: true },
      });
    } catch (error) {
      this.update({ failure: reason(error) });
      try {
        // Offer to replace only the disk version we just observed. A later writer still wins the CAS check.
        const disk = await readProjectFile(this.sessionId, this.path, false);
        if (disk.revision !== base.revision || disk.kind !== base.kind)
          this.update({ conflict: disk });
      } catch (readError) {
        this.update({ failure: reason(error) + ' · ' + reason(readError) });
      }
    } finally {
      this.update({ saving: false });
    }
  };
}

export function useFileDocument(
  sessionId: string,
  path: string,
  visible: boolean,
  refreshKey: number,
  autoSave: boolean,
  onDirtyChange?: (path: string, dirty: boolean) => void,
) {
  const doc = useMemo(
    () => documents.get(keyOf(sessionId, path)) ?? new FileDocument(sessionId, path),
    [sessionId, path],
  );
  const state = useSyncExternalStore(doc.subscribe, doc.get);
  const dirty = state.file?.kind === 'text' && state.file.text !== state.draft;
  useLayoutEffect(() => {
    onDirtyChange?.(path, dirty);
  }, [onDirtyChange, path, dirty]);
  useEffect(() => {
    if (visible) void doc.load(doc.get().forced);
  }, [doc, visible, refreshKey]);
  useEffect(() => {
    if (!autoSave || !dirty || state.saving || state.failure || state.conflict) return;
    const timer = setTimeout(() => {
      void doc.save();
    }, 850);
    return () => {
      clearTimeout(timer);
    };
  }, [autoSave, dirty, doc, state.draft, state.saving, state.failure, state.conflict]);
  return { ...state, dirty, setDraft: doc.setDraft, load: doc.load, save: doc.save };
}
