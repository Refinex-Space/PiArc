// Workspace pages follow their files (design addendum B1.6.1): every file the workspace scheme
// served is watched (resolved through Core like the Files panel, project-file-watch.ts; the OS
// watch only says "changed", the next read still goes through Core), and 300 ms after the last
// change the session's workspace pages reload. Chromium keeps the scroll position on reload.
// A changed file's watch is dropped and set up again when the reload serves it: editors often
// replace a file, and a watch follows the old one.

/** The quiet time before reloading, and the files watched per session. */
export const LIVE_RELOAD = { delayMs: 300, files: 200 } as const;

export interface LiveReloadDeps {
  /** The absolute path of a session-relative file, through Core; undefined when unknown. */
  resolve(sessionId: string, relative: string): Promise<string | undefined>;
  watch(file: string, onChange: () => void): { close(): void };
  /** Reloads the session's workspace pages. */
  reload(sessionId: string): void;
}

interface Watched {
  close(): void;
}

interface SessionWatch {
  /** Insertion order: the oldest goes first when over the limit. */
  readonly files: Map<string, Watched | 'pending'>;
  timer: NodeJS.Timeout | undefined;
}

export class LiveReload {
  readonly #sessions = new Map<string, SessionWatch>();

  constructor(private readonly deps: LiveReloadDeps) {}

  /** The scheme served `relative` to a page of `sessionId`. */
  served(sessionId: string, relative: string): void {
    let session = this.#sessions.get(sessionId);
    if (session === undefined) {
      session = { files: new Map(), timer: undefined };
      this.#sessions.set(sessionId, session);
    }
    if (session.files.has(relative)) return;
    session.files.set(relative, 'pending');
    while (session.files.size > LIVE_RELOAD.files) {
      const [oldest, watched] = session.files.entries().next().value ?? [];
      if (oldest === undefined) break;
      if (watched !== undefined && watched !== 'pending') watched.close();
      session.files.delete(oldest);
    }
    void this.#watch(sessionId, session, relative);
  }

  /** Stops watching the files of `sessionId` (its tabs are gone). */
  forget(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    this.#sessions.delete(sessionId);
    if (session.timer !== undefined) clearTimeout(session.timer);
    for (const watched of session.files.values()) if (watched !== 'pending') watched.close();
  }

  async #watch(sessionId: string, session: SessionWatch, relative: string): Promise<void> {
    let file: string | undefined;
    try {
      file = await this.deps.resolve(sessionId, relative);
    } catch {
      file = undefined;
    }
    // Forgotten, dropped over the limit or already changed while resolving.
    if (this.#sessions.get(sessionId) !== session || session.files.get(relative) !== 'pending') {
      return;
    }
    if (file === undefined) {
      session.files.delete(relative);
      return;
    }
    try {
      const watched = this.deps.watch(file, () => {
        this.#changed(sessionId, session, relative);
      });
      session.files.set(relative, watched);
    } catch {
      session.files.delete(relative);
    }
  }

  #changed(sessionId: string, session: SessionWatch, relative: string): void {
    const watched = session.files.get(relative);
    if (watched !== undefined && watched !== 'pending') watched.close();
    session.files.delete(relative);
    if (session.timer !== undefined) clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      session.timer = undefined;
      if (this.#sessions.get(sessionId) === session) this.deps.reload(sessionId);
    }, LIVE_RELOAD.delayMs);
  }
}
