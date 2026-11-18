// One session's conversation in the renderer (architecture section 8.3): Core's session
// notifications reduced into rows, each row with its own subscribers, so a streaming delta
// re-renders only the row it extends (rule 3). The user's input is echoed at once as an
// optimistic row carrying a `clientId`; Core's user message replaces it in place when it
// arrives, and never shows twice (rule 1).
import type { Item } from '@piarc/protocol';

/** A row of the conversation. */
export type TranscriptRow =
  | { readonly kind: 'item'; readonly id: string; readonly turnId: string; readonly item: Item }
  | {
      readonly kind: 'optimistic';
      readonly id: string;
      readonly clientId: string;
      readonly text: string;
      /** The turn Core started for it, once the prompt was accepted. */
      readonly turnId: string | undefined;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An item as Core sends it: an object with string `itemId` and `type`. */
function isItem(value: unknown): value is Item {
  return isRecord(value) && typeof value.itemId === 'string' && typeof value.type === 'string';
}

function optimisticId(clientId: string): string {
  return `optimistic:${clientId}`;
}

export class SessionTranscript {
  private ids: readonly string[] = [];
  private readonly rows = new Map<string, TranscriptRow>();
  private running = false;
  private failure: string | undefined;
  private readonly rowListeners = new Map<string, Set<() => void>>();
  private readonly listListeners = new Set<() => void>();
  private readonly stateListeners = new Set<() => void>();

  rowIds(): readonly string[] {
    return this.ids;
  }

  row(id: string): TranscriptRow | undefined {
    return this.rows.get(id);
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Why the last turn failed, until the next turn starts. */
  lastError(): string | undefined {
    return this.failure;
  }

  /**
   * Applies Core's notifications for this session (`{ method, params }`, in `seq` order).
   * Malformed or unknown notifications are skipped.
   */
  apply(notifications: readonly unknown[]): void {
    const changed = new Set<string>();
    let listChanged = false;
    let stateChanged = false;
    for (const notification of notifications) {
      if (!isRecord(notification) || !isRecord(notification.params)) {
        continue;
      }
      const { params } = notification;
      switch (notification.method) {
        case 'turn/started':
          stateChanged ||= !this.running || this.failure !== undefined;
          this.running = true;
          this.failure = undefined;
          break;
        case 'turn/completed':
          stateChanged = true;
          this.running = false;
          this.failure =
            params.status === 'failed'
              ? typeof params.errorMessage === 'string'
                ? params.errorMessage
                : ''
              : undefined;
          break;
        case 'item/started':
        case 'item/updated':
        case 'item/completed': {
          const { item } = params;
          const turnId = typeof params.turnId === 'string' ? params.turnId : '';
          if (!isItem(item)) {
            break;
          }
          listChanged = this.upsert(item, turnId, changed) || listChanged;
          break;
        }
        case 'item/agentMessage/delta':
        case 'item/reasoning/delta': {
          const { itemId, delta } = params;
          if (typeof itemId !== 'string' || typeof delta !== 'string') {
            break;
          }
          const row = this.rows.get(itemId);
          if (row?.kind !== 'item' || !('text' in row.item)) {
            break;
          }
          this.rows.set(itemId, { ...row, item: { ...row.item, text: row.item.text + delta } });
          changed.add(itemId);
          break;
        }
        default:
          break;
      }
    }
    this.notify(changed, listChanged, stateChanged);
  }

  /** Replaces the rows with a window of the persisted conversation (a session opened again). */
  load(items: readonly { readonly entryId: string; readonly item: unknown }[]): void {
    const pending = this.ids.filter((id) => this.rows.get(id)?.kind === 'optimistic');
    const previous = this.ids;
    this.ids = [];
    const kept = new Map(pending.map((id) => [id, this.rows.get(id)]));
    this.rows.clear();
    for (const { entryId, item } of items) {
      if (isItem(item) && !this.rows.has(item.itemId)) {
        this.rows.set(item.itemId, { kind: 'item', id: item.itemId, turnId: entryId, item });
        this.ids = [...this.ids, item.itemId];
      }
    }
    for (const [id, row] of kept) {
      if (row !== undefined) {
        this.rows.set(id, row);
        this.ids = [...this.ids, id];
      }
    }
    this.notify(new Set([...previous, ...this.ids]), true, false);
  }

  /** Shows the user's input at once (before Core has it). */
  addOptimistic(clientId: string, text: string): void {
    const id = optimisticId(clientId);
    this.rows.set(id, { kind: 'optimistic', id, clientId, text, turnId: undefined });
    this.ids = [...this.ids, id];
    this.notify(new Set([id]), true, false);
  }

  /** Core accepted the input as turn `turnId`. */
  confirm(clientId: string, turnId: string): void {
    const id = optimisticId(clientId);
    const row = this.rows.get(id);
    if (row?.kind !== 'optimistic') {
      return;
    }
    const echoed = this.ids.some((other) => {
      const candidate = this.rows.get(other);
      return (
        candidate?.kind === 'item' &&
        candidate.turnId === turnId &&
        candidate.item.type === 'userMessage'
      );
    });
    if (echoed) {
      this.remove(id);
      return;
    }
    this.rows.set(id, { ...row, turnId });
    this.notify(new Set([id]), false, false);
  }

  /** The input failed: the optimistic row goes away. */
  rollback(clientId: string): void {
    this.remove(optimisticId(clientId));
  }

  subscribeList(listener: () => void): () => void {
    return subscribe(this.listListeners, listener);
  }

  subscribeState(listener: () => void): () => void {
    return subscribe(this.stateListeners, listener);
  }

  subscribeRow(id: string, listener: () => void): () => void {
    let listeners = this.rowListeners.get(id);
    if (listeners === undefined) {
      listeners = new Set();
      this.rowListeners.set(id, listeners);
    }
    const set = listeners;
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.rowListeners.delete(id);
      }
    };
  }

  /** Inserts or updates an item; returns whether the row list changed. */
  private upsert(item: Item, turnId: string, changed: Set<string>): boolean {
    const existing = this.rows.get(item.itemId);
    if (existing !== undefined) {
      this.rows.set(item.itemId, { kind: 'item', id: item.itemId, turnId, item });
      changed.add(item.itemId);
      return false;
    }
    const row: TranscriptRow = { kind: 'item', id: item.itemId, turnId, item };
    const echo = item.type === 'userMessage' ? this.optimisticFor(turnId, item.text) : undefined;
    this.rows.set(item.itemId, row);
    changed.add(item.itemId);
    if (echo === undefined) {
      this.ids = [...this.ids, item.itemId];
      return true;
    }
    // Core's message takes the optimistic row's place.
    this.ids = this.ids.map((id) => (id === echo ? item.itemId : id));
    this.rows.delete(echo);
    changed.add(echo);
    return true;
  }

  /** The optimistic row Core's user message of `turnId` confirms. */
  private optimisticFor(turnId: string, text: string): string | undefined {
    let unconfirmed: string | undefined;
    for (const id of this.ids) {
      const row = this.rows.get(id);
      if (row?.kind !== 'optimistic') {
        continue;
      }
      if (row.turnId === turnId) {
        return id;
      }
      // The event can overtake the prompt's reply: the first unconfirmed row with the same text.
      if (row.turnId === undefined && row.text === text) {
        unconfirmed ??= id;
      }
    }
    return unconfirmed;
  }

  private remove(id: string): void {
    if (!this.rows.delete(id)) {
      return;
    }
    this.ids = this.ids.filter((other) => other !== id);
    this.notify(new Set([id]), true, false);
  }

  private notify(changed: ReadonlySet<string>, listChanged: boolean, stateChanged: boolean): void {
    if (listChanged) {
      for (const listener of [...this.listListeners]) {
        listener();
      }
    }
    for (const id of changed) {
      for (const listener of [...(this.rowListeners.get(id) ?? [])]) {
        listener();
      }
    }
    if (stateChanged) {
      for (const listener of [...this.stateListeners]) {
        listener();
      }
    }
  }
}

function subscribe(set: Set<() => void>, listener: () => void): () => void {
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
