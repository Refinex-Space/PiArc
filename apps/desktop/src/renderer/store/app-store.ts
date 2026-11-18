// The renderer's store (architecture section 8.3): written for `useSyncExternalStore`. Business
// state comes only from Core's events — the entity snapshots (gated by `revision`: an older or
// equal revision is dropped) and each session's notifications. Subscriptions are fine-grained:
// the workspace list, the session list, one session's entry, one transcript row. An entry that
// did not change keeps its object, so its subscribers do not re-render.
import {
  parseSessions,
  parseWorkspaces,
  sameEntry,
  type SessionEntry,
  type WorkspaceEntry,
} from './snapshots.js';
import { SessionTranscript } from './transcript.js';

/** A notice for the user from Core (`core/notices`, for example a missing Git Bash). */
export interface Notice {
  readonly type: string;
  readonly message: string;
  readonly downloadUrl: string | undefined;
}

export class AppStore {
  private workspaceRevision = -1;
  private sessionRevision = -1;
  private workspaceList: readonly WorkspaceEntry[] = [];
  private sessionList: readonly SessionEntry[] = [];
  private readonly sessionById = new Map<string, SessionEntry>();
  private readonly transcripts = new Map<string, SessionTranscript>();
  private noticeList: readonly Notice[] = [];
  private readonly workspaceListeners = new Set<() => void>();
  private readonly sessionListeners = new Set<() => void>();
  private readonly entryListeners = new Map<string, Set<() => void>>();
  private readonly noticeListeners = new Set<() => void>();

  workspaces = (): readonly WorkspaceEntry[] => this.workspaceList;
  sessions = (): readonly SessionEntry[] => this.sessionList;
  notices = (): readonly Notice[] => this.noticeList;

  /** Whether a session snapshot arrived (the sidebar shows Core's data). */
  hasSessions(): boolean {
    return this.sessionRevision >= 0;
  }

  session(id: string): SessionEntry | undefined {
    return this.sessionById.get(id);
  }

  /** The transcript of session `id` (created on first use). */
  transcript(id: string): SessionTranscript {
    let transcript = this.transcripts.get(id);
    if (transcript === undefined) {
      transcript = new SessionTranscript();
      this.transcripts.set(id, transcript);
    }
    return transcript;
  }

  /** Applies a `core/workspaces` event; false when it was stale or malformed. */
  applyWorkspaces(value: unknown): boolean {
    const snapshot = parseWorkspaces(value);
    if (snapshot === undefined || snapshot.revision <= this.workspaceRevision) {
      return false;
    }
    this.workspaceRevision = snapshot.revision;
    const previous = new Map(this.workspaceList.map((w) => [w.path, w]));
    const next = snapshot.entries.map((entry) => {
      const old = previous.get(entry.path);
      return old !== undefined && sameEntry(old, entry) ? old : entry;
    });
    if (!sameList(this.workspaceList, next)) {
      this.workspaceList = next;
      emit(this.workspaceListeners);
    }
    return true;
  }

  /** Applies a `core/sessions` event; false when it was stale or malformed. */
  applySessions(value: unknown): boolean {
    const snapshot = parseSessions(value);
    if (snapshot === undefined || snapshot.revision <= this.sessionRevision) {
      return false;
    }
    const first = this.sessionRevision < 0;
    this.sessionRevision = snapshot.revision;
    const changed: string[] = [];
    const seen = new Set<string>();
    const next = snapshot.entries.map((entry) => {
      seen.add(entry.id);
      const old = this.sessionById.get(entry.id);
      if (old !== undefined && sameEntry(old, entry)) {
        return old;
      }
      this.sessionById.set(entry.id, entry);
      changed.push(entry.id);
      return entry;
    });
    for (const id of [...this.sessionById.keys()]) {
      if (!seen.has(id)) {
        this.sessionById.delete(id);
        changed.push(id);
      }
    }
    if (first || !sameList(this.sessionList, next)) {
      this.sessionList = next;
      emit(this.sessionListeners);
    }
    for (const id of changed) {
      emit(this.entryListeners.get(id));
    }
    return true;
  }

  /** Applies a `core/notices` event. */
  applyNotice(value: unknown): void {
    if (typeof value !== 'object' || value === null) {
      return;
    }
    const { type, message, downloadUrl } = value as Record<string, unknown>;
    if (typeof type !== 'string' || typeof message !== 'string') {
      return;
    }
    if (this.noticeList.some((notice) => notice.type === type)) {
      return;
    }
    const url =
      typeof downloadUrl === 'string' && downloadUrl.startsWith('https://')
        ? downloadUrl
        : undefined;
    this.noticeList = [...this.noticeList, { type, message, downloadUrl: url }];
    emit(this.noticeListeners);
  }

  dismissNotice(type: string): void {
    this.noticeList = this.noticeList.filter((notice) => notice.type !== type);
    emit(this.noticeListeners);
  }

  subscribeWorkspaces = (listener: () => void): (() => void) =>
    subscribe(this.workspaceListeners, listener);

  subscribeSessions = (listener: () => void): (() => void) =>
    subscribe(this.sessionListeners, listener);

  subscribeNotices = (listener: () => void): (() => void) =>
    subscribe(this.noticeListeners, listener);

  subscribeSession(id: string, listener: () => void): () => void {
    let listeners = this.entryListeners.get(id);
    if (listeners === undefined) {
      listeners = new Set();
      this.entryListeners.set(id, listeners);
    }
    const set = listeners;
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.entryListeners.delete(id);
      }
    };
  }
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry === b[i]);
}

function emit(listeners: Set<() => void> | undefined): void {
  for (const listener of [...(listeners ?? [])]) {
    listener();
  }
}

function subscribe(set: Set<() => void>, listener: () => void): () => void {
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
