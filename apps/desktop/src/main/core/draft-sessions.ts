// Draft sessions (ADR-0099): the new-session view opens one when the user first reaches for a
// tool before sending anything. The window that opened a draft owns it here: when its page
// goes away (reload, crash, close) its drafts are discarded, since no page knows them any more.
// Core refuses to discard a session that took an input, so a draft that became a conversation
// is never removed by this.
import type { CoreRuntime } from './native/piarc-core.js';

/** The part of Core drafts use. */
export type DraftCore = Pick<CoreRuntime, 'createDraftSession' | 'discardDraftSession'>;

/** The fields of Electron's `did-start-navigation` details this reads. */
interface NavigationDetails {
  readonly isMainFrame: boolean;
  readonly isSameDocument: boolean;
}

/** The part of a window's `WebContents` this needs. */
export interface DraftContents {
  readonly id: number;
  once(event: 'destroyed', listener: () => void): unknown;
  on(event: 'render-process-gone', listener: () => void): unknown;
  on(event: 'did-start-navigation', listener: (details: NavigationDetails) => void): unknown;
}

function sessionIdOf(created: string): string | undefined {
  try {
    const value: unknown = JSON.parse(created);
    if (typeof value === 'object' && value !== null && 'sessionId' in value) {
      return typeof value.sessionId === 'string' ? value.sessionId : undefined;
    }
  } catch {
    // Not JSON: no id.
  }
  return undefined;
}

export class DraftSessions {
  /** Window → the drafts it opened. */
  readonly #drafts = new Map<number, Set<string>>();
  readonly #watched = new WeakSet<DraftContents>();
  readonly #core: DraftCore;

  constructor(core: DraftCore) {
    this.#core = core;
  }

  /** Opens a draft in `workspace` for `contents`; resolves with Core's create answer. */
  async create(contents: DraftContents, workspace: string): Promise<string> {
    this.#watch(contents);
    const created = await this.#core.createDraftSession(workspace);
    const id = sessionIdOf(created);
    if (id !== undefined) {
      const owned = this.#drafts.get(contents.id) ?? new Set<string>();
      owned.add(id);
      this.#drafts.set(contents.id, owned);
    }
    return created;
  }

  /** Discards draft `id`; Core refuses a session that took an input. */
  async discard(contents: DraftContents, id: string): Promise<void> {
    this.#drafts.get(contents.id)?.delete(id);
    await this.#core.discardDraftSession(id);
  }

  /** The drafts window `windowId` opened and has not discarded. */
  ownedBy(windowId: number): readonly string[] {
    return [...(this.#drafts.get(windowId) ?? [])];
  }

  #watch(contents: DraftContents): void {
    if (this.#watched.has(contents)) return;
    this.#watched.add(contents);
    const windowId = contents.id;
    contents.once('destroyed', () => {
      this.#discardAll(windowId);
    });
    contents.on('render-process-gone', () => {
      this.#discardAll(windowId);
    });
    contents.on('did-start-navigation', (details) => {
      // Hash routes are same-document; subframes open no drafts.
      if (details.isMainFrame && !details.isSameDocument) this.#discardAll(windowId);
    });
  }

  #discardAll(windowId: number): void {
    const owned = this.#drafts.get(windowId);
    this.#drafts.delete(windowId);
    for (const id of owned ?? []) {
      // A draft that became a conversation is refused, and one already gone is not found.
      this.#core.discardDraftSession(id).catch(() => undefined);
    }
  }
}
