// A session's changes (T28, architecture section 8.2): Core's `ChangesView` of the files the
// session wrote through its file tools, each against its content before the session first
// wrote it. The Changes panel and the rail's changes card read it; it is fetched when shown,
// after each turn and after a discard, a rewind or a branch change.
import type { ChangesFile, ChangesView, DiffHunk, DiffLine } from '@piarc/protocol';
import { reason } from '../shell/errors.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function lineOf(value: unknown): DiffLine | undefined {
  if (!isRecord(value) || typeof value.text !== 'string') return undefined;
  if (value.kind !== 'context' && value.kind !== 'added' && value.kind !== 'removed') {
    return undefined;
  }
  return {
    kind: value.kind,
    text: value.text,
    ...(value.noNewline === true ? { noNewline: true } : {}),
  };
}

function hunkOf(value: unknown): DiffHunk | undefined {
  if (!isRecord(value) || !Array.isArray(value.lines)) return undefined;
  const lines = value.lines.map(lineOf);
  if (lines.some((line) => line === undefined)) return undefined;
  return {
    oldStart: count(value.oldStart),
    oldLines: count(value.oldLines),
    newStart: count(value.newStart),
    newLines: count(value.newLines),
    lines: lines.filter((line): line is DiffLine => line !== undefined),
  };
}

function fileOf(value: unknown): ChangesFile | undefined {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    typeof value.label !== 'string' ||
    typeof value.version !== 'string' ||
    (value.kind !== 'created' && value.kind !== 'modified' && value.kind !== 'deleted')
  ) {
    return undefined;
  }
  const diff = isRecord(value.diff) ? value.diff : undefined;
  const hunks = Array.isArray(diff?.hunks) ? diff.hunks.map(hunkOf) : [];
  return {
    path: value.path,
    label: value.label,
    kind: value.kind,
    version: value.version,
    added: count(value.added),
    removed: count(value.removed),
    ...(value.binary === true ? { binary: true } : {}),
    ...(diff === undefined || hunks.some((hunk) => hunk === undefined)
      ? {}
      : {
          diff: {
            path: typeof diff.path === 'string' ? diff.path : value.label,
            added: count(diff.added),
            removed: count(diff.removed),
            unified: typeof diff.unified === 'string' ? diff.unified : '',
            hunks: hunks.filter((hunk): hunk is DiffHunk => hunk !== undefined),
            ...(diff.created === true ? { created: true } : {}),
            ...(diff.degraded === true ? { degraded: true } : {}),
          },
        }),
  };
}

/** Core's `ChangesView` JSON, or an empty view when it is not one. */
export function changesOf(text: string): ChangesView {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.files)) {
    return { files: [], added: 0, removed: 0 };
  }
  return {
    files: value.files.flatMap((file: unknown) => {
      const parsed = fileOf(file);
      return parsed === undefined ? [] : [parsed];
    }),
    added: count(value.added),
    removed: count(value.removed),
    ...(value.degraded === true ? { degraded: true } : {}),
  };
}

export interface ChangesState {
  /** The last view Core gave; undefined before the first answer. */
  readonly view: ChangesView | undefined;
  readonly loading: boolean;
  /** Why the last request failed. */
  readonly failure: string | undefined;
}

const INITIAL: ChangesState = { view: undefined, loading: false, failure: undefined };

export class SessionChanges {
  private snapshot: ChangesState = INITIAL;
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  state(): ChangesState {
    return this.snapshot;
  }

  /** Fetches the view again with `fetch`; a newer request supersedes an older one. */
  refresh(fetch: () => Promise<string>): Promise<void> {
    const generation = ++this.generation;
    this.set({ ...this.snapshot, loading: true });
    return fetch().then(
      (text) => {
        if (generation === this.generation) {
          this.set({ view: changesOf(text), loading: false, failure: undefined });
        }
      },
      (error: unknown) => {
        if (generation === this.generation) {
          this.set({
            ...this.snapshot,
            loading: false,
            failure: reason(error),
          });
        }
      },
    );
  }

  /** Puts one file's fresh view in place (after a discard), or removes it when it has no
   * change left. */
  replaceFile(path: string, file: ChangesFile | undefined): void {
    const view = this.snapshot.view;
    if (view === undefined) return;
    const files = view.files.flatMap((f) =>
      f.path !== path ? [f] : file === undefined ? [] : [file],
    );
    this.set({
      ...this.snapshot,
      view: {
        ...view,
        files,
        added: files.reduce((sum, f) => sum + f.added, 0),
        removed: files.reduce((sum, f) => sum + f.removed, 0),
      },
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(next: ChangesState): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}
