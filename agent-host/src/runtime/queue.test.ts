import type { QueueItem } from '@piarc/protocol';
import { describe, expect, it } from 'vitest';

import type { AhpError } from '../protocol/errors.js';
import { plainInput } from './input.js';
import { InputQueue, type PiQueue } from './queue.js';

/** Pi's queue as the session keeps it: steering strings, delivered from the front. */
class FakePi implements PiQueue {
  steering: string[] = [];
  readonly enqueued: string[] = [];
  /** Called inside `steer`, after the string is queued: simulates a delivery in that gap. */
  onSteer: (() => void) | undefined;

  steer(text: string): Promise<unknown> {
    this.steering.push(text);
    this.enqueued.push(text);
    this.onSteer?.();
    return Promise.resolve('queued');
  }

  clearQueue(): unknown {
    const cleared = this.steering;
    this.steering = [];
    return cleared;
  }

  getSteeringMessages(): readonly string[] {
    return this.steering;
  }

  /** Pi delivers its first steering message; returns it. */
  deliver(): string | undefined {
    return this.steering.shift();
  }
}

function setup(): { pi: FakePi; queue: InputQueue; changes: QueueItem[][] } {
  const pi = new FakePi();
  const changes: QueueItem[][] = [];
  const queue = new InputQueue('s1', pi, (items) => changes.push([...items]));
  return { pi, queue, changes };
}

const texts = (items: readonly QueueItem[]): string[] =>
  items.map((item) => `${item.kind}:${item.text}`);

describe('InputQueue', () => {
  it('gives every input an id and reports each change with the whole queue', async () => {
    const { pi, queue, changes } = setup();
    const a = await queue.steer(plainInput('a'));
    const b = queue.followUp(plainInput('b'));
    expect(a).not.toBe(b);
    expect(pi.steering).toEqual(['a']);
    expect(changes.map(texts)).toEqual([['steer:a'], ['steer:a', 'followUp:b']]);
  });

  it('drops a steering item once Pi delivered it', async () => {
    const { pi, queue } = setup();
    await queue.steer(plainInput('same'));
    await queue.steer(plainInput('same'));
    await queue.steer(plainInput('other'));
    pi.deliver();
    queue.reconcile(pi.steering);
    expect(texts(queue.items)).toEqual(['steer:same', 'steer:other']);
  });

  it('edits, deletes and reorders by rebuilding Pi’s steering queue without loss or repeats', async () => {
    const { pi, queue } = setup();
    const a = await queue.steer(plainInput('a'));
    const b = queue.followUp(plainInput('b'));
    const c = await queue.steer(plainInput('c'));
    await queue.edit(a, 'A');
    expect(pi.steering).toEqual(['A', 'c']);
    await queue.reorder([b, c, a]);
    expect(texts(queue.items)).toEqual(['followUp:b', 'steer:c', 'steer:A']);
    expect(pi.steering).toEqual(['c', 'A']);
    await queue.delete(c);
    expect(pi.steering).toEqual(['A']);
    expect(texts(queue.items)).toEqual(['followUp:b', 'steer:A']);
    // Editing a follow-up leaves Pi's queue alone.
    const before = pi.enqueued.length;
    await queue.edit(b, 'B');
    expect(pi.enqueued.length).toBe(before);
    expect(texts(queue.items)).toEqual(['followUp:B', 'steer:A']);
  });

  it('keeps the table right when Pi delivers during a rebuild', async () => {
    const { pi, queue } = setup();
    const a = await queue.steer(plainInput('a'));
    await queue.steer(plainInput('b'));
    // The first re-enqueued item is delivered at once.
    pi.onSteer = () => {
      pi.onSteer = undefined;
      pi.deliver();
    };
    await queue.edit(a, 'a2');
    expect(texts(queue.items)).toEqual(['steer:b']);
    expect(pi.steering).toEqual(['b']);
  });

  it('turns steering items Pi never delivered into the next follow-ups when the turn settles', async () => {
    const { pi, queue } = setup();
    queue.followUp(plainInput('later'));
    await queue.steer(plainInput('late'));
    queue.settle();
    expect(pi.steering).toEqual([]);
    expect(texts(queue.items)).toEqual(['followUp:late', 'followUp:later']);
    expect(queue.takeFollowUp()?.item.text).toBe('late');
    expect(queue.takeFollowUp()?.item.text).toBe('later');
    expect(queue.takeFollowUp()).toBeUndefined();
  });

  it('keeps attachments with an item, sends Pi the composed text and reports deliveries', async () => {
    const pi = new FakePi();
    const delivered: string[] = [];
    const queue = new InputQueue(
      's1',
      pi,
      () => undefined,
      (prepared) => delivered.push(prepared.input.text),
    );
    const attachment = {
      kind: 'pdf' as const,
      name: 'a.pdf',
      mimeType: 'application/pdf',
      blob: { path: '/d/a.pdf', sha256: 'e'.repeat(64), size: 9 },
      pageCount: 1,
    };
    const id = await queue.steer({
      input: {
        text: 'read it',
        mentions: [{ path: 'x', start: 0, end: 1 }],
        attachments: [attachment],
      },
      sections: '\n\n<attachment>…</attachment>',
      images: [],
    });
    expect(pi.steering).toEqual(['read it\n\n<attachment>…</attachment>']);
    expect(queue.items[0]).toMatchObject({ text: 'read it', attachments: [attachment] });
    await queue.edit(id, 'read it twice');
    expect(pi.steering).toEqual(['read it twice\n\n<attachment>…</attachment>']);
    expect(queue.items[0]?.mentions).toBeUndefined();
    pi.deliver();
    queue.reconcile(pi.steering);
    expect(delivered).toEqual(['read it twice']);
    expect(queue.items).toEqual([]);
  });

  it('hands everything back on abort and refuses unknown ids', async () => {
    const { pi, queue } = setup();
    await queue.steer(plainInput('a'));
    queue.followUp(plainInput('b'));
    expect(texts(queue.takeAll())).toEqual(['steer:a', 'followUp:b']);
    expect(pi.steering).toEqual([]);
    await expect(queue.delete('queue-gone')).rejects.toMatchObject({
      kind: 'queueItemNotFound',
    } satisfies Partial<AhpError>);
    await expect(queue.reorder(['x'])).rejects.toMatchObject({ kind: 'invalidParams' });
  });
});
