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
import type { EditorDraft } from '../composer/session-draft.js';
import { sameRequest } from './approvals.js';
import { TaskList } from './tasks.js';
import { SessionTranscript } from './transcript.js';

/** A notice for the user from Core (`core/notices`, for example a missing Git Bash). */
export interface Notice {
  /** Unique among the shown notices: the type, or `hook:<id>` for a hook's notice. */
  readonly key: string;
  readonly type: string;
  readonly message: string;
  readonly downloadUrl: string | undefined;
  /** A hook's `systemMessage` or error (T25): its event, and whether it is an error. */
  readonly hook?: { readonly event: string; readonly error: boolean };
  /** A client notice about a workspace (T35: add `.piarc/worktrees/` to its `.gitignore`). */
  readonly workspace?: string;
}

/** Hook notices kept on screen; older ones give way to new ones. */
const MAX_HOOK_NOTICES = 5;

export class AppStore {
  private readonly drafts = new Map<string, EditorDraft>();

  /** Stable editor storage, dropped with the corresponding entity in Core's next snapshot. */
  editorDraft(scope: 'workspace' | 'session', id: string): EditorDraft {
    const key = `${scope}:${id}`;
    const existing = this.drafts.get(key);
    if (existing !== undefined) return existing;
    const draft: EditorDraft = {};
    this.drafts.set(key, draft);
    return draft;
  }

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
  private readonly transcriptListeners = new Set<(transcript: SessionTranscript) => void>();

  /** Background tasks (T32): the `core/tasks` snapshot. */
  readonly tasks = new TaskList();

  workspaces = (): readonly WorkspaceEntry[] => this.workspaceList;
  sessions = (): readonly SessionEntry[] => this.sessionList;
  notices = (): readonly Notice[] => this.noticeList;

  /** Whether a workspace snapshot arrived (ADR-0110: the first-run guide waits for it). */
  hasWorkspaces = (): boolean => this.workspaceRevision >= 0;

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
      const session = this.sessionById.get(id);
      transcript.setApprovals(session?.approvals ?? []);
      if (session !== undefined) transcript.syncStatus(session.status);
      this.transcripts.set(id, transcript);
      for (const listener of [...this.transcriptListeners]) {
        listener(transcript);
      }
    }
    return transcript;
  }

  /** Hears every transcript created from now on (the streaming driver follows them all). */
  onTranscript(listener: (transcript: SessionTranscript) => void): () => void {
    for (const transcript of this.transcripts.values()) {
      listener(transcript);
    }
    return subscribe(this.transcriptListeners, listener);
  }

  /** Applies a `core/workspaces` event; false when it was stale or malformed. */
  applyWorkspaces(value: unknown): boolean {
    const snapshot = parseWorkspaces(value);
    if (snapshot === undefined || snapshot.revision <= this.workspaceRevision) {
      return false;
    }
    const previous = new Map(this.workspaceList.map((w) => [w.path, w]));
    const next = snapshot.entries.map((entry) => {
      const old = previous.get(entry.path);
      previous.delete(entry.path);
      return old !== undefined && sameEntry(old, entry) ? old : entry;
    });
    for (const path of previous.keys()) this.drafts.delete(`workspace:${path}`);
    const first = this.workspaceRevision < 0;
    this.workspaceRevision = snapshot.revision;
    if (!sameList(this.workspaceList, next) || first) {
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
    const next = snapshot.entries.map((snapshotEntry) => {
      seen.add(snapshotEntry.id);
      const old = this.sessionById.get(snapshotEntry.id);
      const approvals = snapshotEntry.approvals;
      const entry =
        old?.approvals.length === approvals.length &&
        old.approvals.every((a, i) => approvals[i] !== undefined && sameRequest(a, approvals[i]))
          ? { ...snapshotEntry, approvals: old.approvals }
          : snapshotEntry;
      if (old !== undefined && sameEntry(old, entry)) {
        return old;
      }
      const transcript = this.transcripts.get(entry.id);
      transcript?.setApprovals(entry.approvals);
      // A turn this window did not see start (or end) still shows in its composer.
      if (old?.status !== entry.status) transcript?.syncStatus(entry.status);
      this.sessionById.set(entry.id, entry);
      changed.push(entry.id);
      return entry;
    });
    for (const id of [...this.sessionById.keys()]) {
      if (!seen.has(id)) {
        this.transcripts.get(id)?.setApprovals([]);
        this.sessionById.delete(id);
        this.drafts.delete(`session:${id}`);
        changed.push(id);
      }
    }
    // Drafts stay reachable by id (their tools) but are no session of any list (ADR-0099).
    const listed = next.some((entry) => entry.draft) ? next.filter((entry) => !entry.draft) : next;
    if (first || !sameList(this.sessionList, listed)) {
      this.sessionList = listed;
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
    const { type, message, downloadUrl, id, event, level } = value as Record<string, unknown>;
    if (typeof type !== 'string' || typeof message !== 'string') {
      return;
    }
    const hook =
      type === 'hook' && typeof id === 'string'
        ? { event: typeof event === 'string' ? event : 'Hook', error: level === 'error' }
        : undefined;
    const key = hook !== undefined && typeof id === 'string' ? `hook:${id}` : type;
    if (this.noticeList.some((notice) => notice.key === key)) {
      return;
    }
    const url =
      typeof downloadUrl === 'string' && downloadUrl.startsWith('https://')
        ? downloadUrl
        : undefined;
    let list = [
      ...this.noticeList,
      { key, type, message, downloadUrl: url, ...(hook === undefined ? {} : { hook }) },
    ];
    const hooks = list.filter((notice) => notice.hook !== undefined);
    if (hooks.length > MAX_HOOK_NOTICES) {
      const dropped = new Set(hooks.slice(0, hooks.length - MAX_HOOK_NOTICES));
      list = list.filter((notice) => !dropped.has(notice));
    }
    this.noticeList = list;
    emit(this.noticeListeners);
  }

  /** Shows a notice the window itself raised (T35), once per key. */
  addLocalNotice(notice: Notice): void {
    if (this.noticeList.some((shown) => shown.key === notice.key)) return;
    this.noticeList = [...this.noticeList, notice];
    emit(this.noticeListeners);
  }

  dismissNotice(key: string): void {
    this.noticeList = this.noticeList.filter((notice) => notice.key !== key);
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

function subscribe<T>(set: Set<T>, listener: T): () => void {
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
