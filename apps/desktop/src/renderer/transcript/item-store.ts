// A minimal transcript store for the T09 prototype: reduces the protocol's turn and item
// notifications into rows and lets components subscribe per row (`useSyncExternalStore`), so a
// streaming delta re-renders only the row it belongs to (architecture section 8.3, rule 3).
// The session store of T18 replaces it; T19 feeds it Core's events.
import type {
  Item,
  ItemAgentMessageDeltaNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
  TurnCompletedNotification,
  TurnStartedNotification,
} from '@piarc/protocol';
import { useSyncExternalStore } from 'react';

/** The session notifications the transcript understands. */
export type TranscriptNotification =
  | TurnStartedNotification
  | TurnCompletedNotification
  | ItemStartedNotification
  | ItemAgentMessageDeltaNotification
  | ItemCompletedNotification;

export type AgentMessageItem = Extract<Item, { type: 'agentMessage' }>;
export type ToolCallItem = Extract<Item, { type: 'dynamicToolCall' }>;

/** A mention as the user saw it in the composer. */
export interface MentionSegment {
  readonly kind: 'mention';
  readonly label: string;
  readonly path: string;
}

export type UserSegment = { readonly kind: 'text'; readonly text: string } | MentionSegment;

export type Row =
  | { readonly kind: 'agentMessage'; readonly id: string; readonly item: AgentMessageItem }
  | { readonly kind: 'toolCall'; readonly id: string; readonly item: ToolCallItem }
  /** The user's input, echoed locally until Core confirms it (architecture section 8.3, rule 1). */
  | {
      readonly kind: 'user';
      readonly id: string;
      readonly segments: readonly UserSegment[];
      readonly text: string;
    };

function rowOf(item: Item): Row {
  return item.type === 'agentMessage'
    ? { kind: 'agentMessage', id: item.itemId, item }
    : { kind: 'toolCall', id: item.itemId, item };
}

export class TranscriptStore {
  private ids: readonly string[] = [];
  private readonly rows = new Map<string, Row>();
  private running = false;
  private readonly rowListeners = new Map<string, Set<() => void>>();
  private readonly listListeners = new Set<() => void>();
  private readonly runningListeners = new Set<() => void>();
  private readonly changeListeners = new Set<(ids: readonly string[]) => void>();

  rowIds(): readonly string[] {
    return this.ids;
  }

  row(id: string): Row | undefined {
    return this.rows.get(id);
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Applies one batch of notifications; subscribers hear about each changed row once. */
  apply(notifications: readonly TranscriptNotification[]): void {
    const changed = new Set<string>();
    const added: string[] = [];
    let runningChanged = false;
    for (const notification of notifications) {
      switch (notification.method) {
        case 'turn/started':
        case 'turn/completed': {
          const running = notification.method === 'turn/started';
          runningChanged ||= running !== this.running;
          this.running = running;
          break;
        }
        case 'item/started':
        case 'item/completed': {
          const { item } = notification.params;
          if (!this.rows.has(item.itemId)) {
            added.push(item.itemId);
          }
          this.rows.set(item.itemId, rowOf(item));
          changed.add(item.itemId);
          break;
        }
        case 'item/agentMessage/delta': {
          const { itemId, delta } = notification.params;
          const row = this.rows.get(itemId);
          if (row?.kind !== 'agentMessage') {
            console.warn(`[transcript] delta for unknown message ${itemId}`);
            break;
          }
          this.rows.set(itemId, { ...row, item: { ...row.item, text: row.item.text + delta } });
          changed.add(itemId);
          break;
        }
      }
    }
    if (added.length > 0) {
      this.ids = [...this.ids, ...added];
    }
    this.notify(changed, added.length > 0, runningChanged);
  }

  /** Echoes the user's input as a row. */
  addUserMessage(clientId: string, segments: readonly UserSegment[], text: string): void {
    const id = `user:${clientId}`;
    this.rows.set(id, { kind: 'user', id, segments, text });
    this.ids = [...this.ids, id];
    this.notify(new Set([id]), true, false);
  }

  /** Removes every row. */
  clear(): void {
    const ids = this.ids;
    this.ids = [];
    this.rows.clear();
    this.running = false;
    this.notify(new Set(ids), true, true);
  }

  subscribeList(listener: () => void): () => void {
    return this.add(this.listListeners, listener);
  }

  subscribeRunning(listener: () => void): () => void {
    return this.add(this.runningListeners, listener);
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

  /** Every applied batch, with the ids of the rows it changed (streaming driver, tests). */
  subscribeChanges(listener: (ids: readonly string[]) => void): () => void {
    return this.add(this.changeListeners, listener);
  }

  private add<T>(set: Set<T>, listener: T): () => void {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  private notify(
    changed: ReadonlySet<string>,
    listChanged: boolean,
    runningChanged: boolean,
  ): void {
    if (listChanged) {
      this.listListeners.forEach((listener) => {
        listener();
      });
    }
    for (const id of changed) {
      this.rowListeners.get(id)?.forEach((listener) => {
        listener();
      });
    }
    if (runningChanged) {
      this.runningListeners.forEach((listener) => {
        listener();
      });
    }
    if (changed.size > 0) {
      const ids = [...changed];
      this.changeListeners.forEach((listener) => {
        listener(ids);
      });
    }
  }
}

export function useRowIds(store: TranscriptStore): readonly string[] {
  return useSyncExternalStore(
    (listener) => store.subscribeList(listener),
    () => store.rowIds(),
  );
}

export function useRow(store: TranscriptStore, id: string): Row | undefined {
  return useSyncExternalStore(
    (listener) => store.subscribeRow(id, listener),
    () => store.row(id),
  );
}

export function useRunning(store: TranscriptStore): boolean {
  return useSyncExternalStore(
    (listener) => store.subscribeRunning(listener),
    () => store.isRunning(),
  );
}
