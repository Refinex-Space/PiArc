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
import { randomUUID } from 'node:crypto';

import type { QueueItem, QueueKind } from '@piarc/protocol';

import { AhpError } from '../protocol/errors.js';

/** What the queue needs from Pi's session. */
export interface PiQueue {
  steer(text: string): Promise<unknown>;
  clearQueue(): unknown;
  getSteeringMessages(): readonly string[];
}

export class InputQueue {
  readonly #sessionId: string;
  readonly #pi: PiQueue;
  readonly #changed: (items: readonly QueueItem[]) => void;
  #items: QueueItem[] = [];
  /** Set while the steering items are being enqueued again. */
  #rebuilding = false;
  /** The turn settled during a rebuild: settle once the rebuild is done. */
  #settleAfterRebuild = false;

  /** `changed` receives the whole queue after every change (`session/queueChanged`). */
  constructor(sessionId: string, pi: PiQueue, changed: (items: readonly QueueItem[]) => void) {
    this.#sessionId = sessionId;
    this.#pi = pi;
    this.#changed = changed;
  }

  get items(): readonly QueueItem[] {
    return this.#items;
  }

  /** Adds a steering message; Pi delivers it after the current step. */
  async steer(text: string): Promise<string> {
    const item = this.#add('steer', text);
    try {
      await this.#pi.steer(text);
    } catch (error) {
      this.#items = this.#items.filter((current) => current !== item);
      this.#emit();
      throw error;
    }
    return item.itemId;
  }

  /** Adds a follow-up message. */
  followUp(text: string): string {
    return this.#add('followUp', text).itemId;
  }

  /** Takes the first follow-up item out of the queue, to start it as the next turn. */
  takeFollowUp(): QueueItem | undefined {
    const index = this.#items.findIndex((item) => item.kind === 'followUp');
    if (index === -1) {
      return undefined;
    }
    const [item] = this.#items.splice(index, 1);
    this.#emit();
    return item;
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
    if (!this.#items.some((item) => item.kind === 'steer')) {
      return;
    }
    this.#pi.clearQueue();
    const late = this.#items.filter((item) => item.kind === 'steer');
    this.#items = [
      ...late.map((item) => ({ ...item, kind: 'followUp' as const })),
      ...this.#items.filter((item) => item.kind === 'followUp'),
    ];
    this.#emit();
  }

  /** Empties the queue (abort, close) and returns what it held. */
  takeAll(): QueueItem[] {
    const items = this.#items;
    this.#items = [];
    if (items.some((item) => item.kind === 'steer')) {
      this.#pi.clearQueue();
    }
    if (items.length > 0) {
      this.#emit();
    }
    return items;
  }

  /** Aligns the steering items with Pi's list after Pi delivered some (`queue_update`). */
  reconcile(piSteering: readonly string[]): void {
    if (this.#rebuilding) {
      return;
    }
    const steering = this.#items.filter((item) => item.kind === 'steer');
    const kept = new Set<QueueItem>();
    let next = 0;
    for (const text of piSteering) {
      while (next < steering.length && steering[next]?.text !== text) {
        next += 1;
      }
      const item = steering[next];
      if (item === undefined) {
        break;
      }
      kept.add(item);
      next += 1;
    }
    const before = this.#items.length;
    this.#items = this.#items.filter((item) => item.kind !== 'steer' || kept.has(item));
    if (this.#items.length !== before) {
      this.#emit();
    }
  }

  async edit(itemId: string, text: string): Promise<readonly QueueItem[]> {
    const item = this.#find(itemId);
    const next = this.#items.map((current) => (current === item ? { ...current, text } : current));
    await this.#replace(next, item.kind === 'steer');
    return this.#items;
  }

  async delete(itemId: string): Promise<readonly QueueItem[]> {
    const item = this.#find(itemId);
    await this.#replace(
      this.#items.filter((current) => current !== item),
      item.kind === 'steer',
    );
    return this.#items;
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
    const steerOrder = (items: readonly QueueItem[]): string =>
      items
        .filter((item) => item.kind === 'steer')
        .map((item) => item.itemId)
        .join('\n');
    await this.#replace(next, steerOrder(next) !== steerOrder(this.#items));
    return this.#items;
  }

  #add(kind: QueueKind, text: string): QueueItem {
    const item: QueueItem = { itemId: `queue-${randomUUID()}`, kind, text: text.toWellFormed() };
    this.#items = [...this.#items, item];
    this.#emit();
    return item;
  }

  #find(itemId: string): QueueItem {
    const item = this.#items.find((current) => current.itemId === itemId);
    if (item === undefined) {
      throw new AhpError(
        'queueItemNotFound',
        `no queued item ${itemId}: it was delivered or removed`,
        {
          details: { sessionId: this.#sessionId, itemId },
        },
      );
    }
    return item;
  }

  /** Installs `next` as the queue; rebuilds Pi's steering queue when its content changed. */
  async #replace(next: QueueItem[], steeringChanged: boolean): Promise<void> {
    this.#items = next;
    if (steeringChanged) {
      this.#rebuilding = true;
      try {
        this.#pi.clearQueue();
        for (const item of next.filter((current) => current.kind === 'steer')) {
          await this.#pi.steer(item.text);
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
    this.#changed(this.#items);
  }
}
