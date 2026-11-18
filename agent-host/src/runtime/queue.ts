// The input queue of one session (architecture section 5.3, piarc-protocol `queue`): steering
// and follow-up messages waiting for the running turn, each with an id.
//
// Pi keeps queued messages as bare strings and offers no edit, so this table is the source of
// truth for ids, text and order:
//
// - Steering items go to Pi at once (`session.steer`): Pi injects them after the current step.
//   When Pi delivers one it removes the first equal string from its list and reports
//   `queue_update`; `reconcile` aligns the table with that list, so the delivered item leaves.
// - Follow-up items stay here; the session registry starts each as a new turn after the
//   running turn completed (Pi's own follow-up would continue the same run, without a turn
//   boundary).
// - Editing, deleting or reordering steering items clears Pi's queue and enqueues the remaining
//   steering items again in the new order; queue updates during that are ignored and the table
//   is aligned with Pi's list once at the end, so nothing is lost or delivered twice.
//
// Each item keeps its prepared input (input.ts): Pi holds the composed text (the user's text and
// any attached PDF's pages) with the images, the table shows what the user wrote.
import { randomUUID } from 'node:crypto';

import type { ImageContent } from '@earendil-works/pi-ai';
import type { QueueItem, QueueKind } from '@piarc/protocol';

import { AhpError } from '../protocol/errors.js';
import { composedText, withText, type PreparedInput } from './input.js';

/** What the queue needs from Pi's session. */
export interface PiQueue {
  steer(text: string, images?: ImageContent[]): Promise<unknown>;
  clearQueue(): unknown;
  getSteeringMessages(): readonly string[];
}

/** A queued input: the item Core sees and the input Pi gets. */
interface Entry {
  readonly item: QueueItem;
  readonly prepared: PreparedInput;
}

function itemOf(itemId: string, kind: QueueKind, prepared: PreparedInput): QueueItem {
  const { text, mentions, attachments } = prepared.input;
  return {
    itemId,
    kind,
    text: text.toWellFormed(),
    ...(mentions.length === 0 ? {} : { mentions: [...mentions] }),
    ...(attachments.length === 0 ? {} : { attachments: [...attachments] }),
  };
}

export class InputQueue {
  readonly #sessionId: string;
  readonly #pi: PiQueue;
  readonly #changed: (items: readonly QueueItem[]) => void;
  #items: Entry[] = [];
  /** Set while the steering items are being enqueued again. */
  #rebuilding = false;
  /** The turn settled during a rebuild: settle once the rebuild is done. */
  #settleAfterRebuild = false;

  readonly #delivered: (prepared: PreparedInput) => void;

  /**
   * `changed` receives the whole queue after every change (`session/queueChanged`);
   * `delivered` each steering input Pi took out of its queue to deliver.
   */
  constructor(
    sessionId: string,
    pi: PiQueue,
    changed: (items: readonly QueueItem[]) => void,
    delivered: (prepared: PreparedInput) => void = () => undefined,
  ) {
    this.#sessionId = sessionId;
    this.#pi = pi;
    this.#changed = changed;
    this.#delivered = delivered;
  }

  get items(): readonly QueueItem[] {
    return this.#items.map((entry) => entry.item);
  }

  /** Adds a steering message; Pi delivers it after the current step. */
  async steer(prepared: PreparedInput): Promise<string> {
    const entry = this.#add('steer', prepared);
    try {
      await this.#pi.steer(composedText(prepared), [...prepared.images]);
    } catch (error) {
      this.#items = this.#items.filter((current) => current !== entry);
      this.#emit();
      throw error;
    }
    return entry.item.itemId;
  }

  /** Adds a follow-up message. */
  followUp(prepared: PreparedInput): string {
    return this.#add('followUp', prepared).item.itemId;
  }

  /** Takes the first follow-up item out of the queue, to start it as the next turn. */
  takeFollowUp(): { readonly item: QueueItem; readonly prepared: PreparedInput } | undefined {
    const index = this.#items.findIndex((entry) => entry.item.kind === 'followUp');
    if (index === -1) {
      return undefined;
    }
    const [entry] = this.#items.splice(index, 1);
    this.#emit();
    return entry;
  }

  /**
   * The turn settled: steering items Pi did not deliver (they arrived after its last step) are
   * taken out of Pi and become follow-ups at the front, so they run as the next turn.
   */
  settle(): void {
    if (this.#rebuilding) {
      this.#settleAfterRebuild = true;
      return;
    }
    this.reconcile(this.#pi.getSteeringMessages());
    if (!this.#items.some((entry) => entry.item.kind === 'steer')) {
      return;
    }
    this.#pi.clearQueue();
    const late = this.#items.filter((entry) => entry.item.kind === 'steer');
    this.#items = [
      ...late.map((entry) => ({
        ...entry,
        item: { ...entry.item, kind: 'followUp' as const },
      })),
      ...this.#items.filter((entry) => entry.item.kind === 'followUp'),
    ];
    this.#emit();
  }

  /** Empties the queue (abort, close) and returns what it held. */
  takeAll(): QueueItem[] {
    const entries = this.#items;
    this.#items = [];
    if (entries.some((entry) => entry.item.kind === 'steer')) {
      this.#pi.clearQueue();
    }
    if (entries.length > 0) {
      this.#emit();
    }
    return entries.map((entry) => entry.item);
  }

  /** Aligns the steering items with Pi's list after Pi delivered some (`queue_update`). */
  reconcile(piSteering: readonly string[]): void {
    if (this.#rebuilding) {
      return;
    }
    const steering = this.#items.filter((entry) => entry.item.kind === 'steer');
    const kept = new Set<Entry>();
    let next = 0;
    for (const text of piSteering) {
      while (next < steering.length && composedOf(steering[next]) !== text) {
        next += 1;
      }
      const entry = steering[next];
      if (entry === undefined) {
        break;
      }
      kept.add(entry);
      next += 1;
    }
    const before = this.#items.length;
    for (const entry of steering) {
      if (!kept.has(entry)) {
        this.#delivered(entry.prepared);
      }
    }
    this.#items = this.#items.filter((entry) => entry.item.kind !== 'steer' || kept.has(entry));
    if (this.#items.length !== before) {
      this.#emit();
    }
  }

  async edit(itemId: string, text: string): Promise<readonly QueueItem[]> {
    const entry = this.#find(itemId);
    const prepared = withText(entry.prepared, text);
    const edited: Entry = { item: itemOf(itemId, entry.item.kind, prepared), prepared };
    const next = this.#items.map((current) => (current === entry ? edited : current));
    await this.#replace(next, entry.item.kind === 'steer');
    return this.items;
  }

  async delete(itemId: string): Promise<readonly QueueItem[]> {
    const entry = this.#find(itemId);
    await this.#replace(
      this.#items.filter((current) => current !== entry),
      entry.item.kind === 'steer',
    );
    return this.items;
  }

  async reorder(itemIds: readonly string[]): Promise<readonly QueueItem[]> {
    const unique = new Set(itemIds);
    if (unique.size !== itemIds.length || unique.size !== this.#items.length) {
      throw new AhpError(
        'invalidParams',
        `session/queue/reorder: itemIds must list each of the ${String(this.#items.length)} queued items once`,
        { details: { sessionId: this.#sessionId } },
      );
    }
    const next = itemIds.map((id) => this.#find(id));
    const steerOrder = (entries: readonly Entry[]): string =>
      entries
        .filter((entry) => entry.item.kind === 'steer')
        .map((entry) => entry.item.itemId)
        .join('\n');
    await this.#replace(next, steerOrder(next) !== steerOrder(this.#items));
    return this.items;
  }

  #add(kind: QueueKind, prepared: PreparedInput): Entry {
    const entry: Entry = { item: itemOf(`queue-${randomUUID()}`, kind, prepared), prepared };
    this.#items = [...this.#items, entry];
    this.#emit();
    return entry;
  }

  #find(itemId: string): Entry {
    const entry = this.#items.find((current) => current.item.itemId === itemId);
    if (entry === undefined) {
      throw new AhpError(
        'queueItemNotFound',
        `no queued item ${itemId}: it was delivered or removed`,
        {
          details: { sessionId: this.#sessionId, itemId },
        },
      );
    }
    return entry;
  }

  /** Installs `next` as the queue; rebuilds Pi's steering queue when its content changed. */
  async #replace(next: Entry[], steeringChanged: boolean): Promise<void> {
    this.#items = next;
    if (steeringChanged) {
      this.#rebuilding = true;
      try {
        this.#pi.clearQueue();
        for (const entry of next.filter((current) => current.item.kind === 'steer')) {
          await this.#pi.steer(composedText(entry.prepared), [...entry.prepared.images]);
        }
      } finally {
        this.#rebuilding = false;
      }
      // Pi may have delivered some while they were enqueued again.
      this.reconcile(this.#pi.getSteeringMessages());
      if (this.#settleAfterRebuild) {
        this.#settleAfterRebuild = false;
        this.settle();
      }
    }
    this.#emit();
  }

  #emit(): void {
    this.#changed(this.items);
  }
}

function composedOf(entry: Entry | undefined): string | undefined {
  return entry === undefined ? undefined : composedText(entry.prepared);
}
