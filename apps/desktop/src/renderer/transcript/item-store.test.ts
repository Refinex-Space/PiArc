import { describe, expect, it } from 'vitest';

import { FixtureSession, generateHistory, planTurn } from '../lab/fixtures/synthesizer.js';
import { TranscriptStore } from './item-store.js';

describe('TranscriptStore', () => {
  it('reduces a streamed turn into rows and tracks the running state', () => {
    const store = new TranscriptStore();
    const session = new FixtureSession('s', () => 0);
    const batches = planTurn(session, {
      turnId: 't1',
      messages: ['Hello **world**', 'Second'],
      tokensPerSecond: 50,
    });
    const running: boolean[] = [];
    store.subscribeRunning(() => running.push(store.isRunning()));
    for (const batch of batches) {
      store.apply(batch.notifications);
    }
    expect(store.rowIds()).toEqual(['t1-msg-1', 't1-msg-2']);
    expect(store.row('t1-msg-1')).toMatchObject({
      kind: 'agentMessage',
      item: { text: 'Hello **world**', status: 'completed' },
    });
    expect(running).toEqual([true, false]);
  });

  it('notifies only the row a delta belongs to', () => {
    const store = new TranscriptStore();
    const session = new FixtureSession('s', () => 0);
    store.apply(generateHistory({ count: 3, seed: 1, session }));
    store.apply(
      planTurn(session, { turnId: 't', messages: ['abc'], tokensPerSecond: 10 })
        .slice(0, 2)
        .flatMap((batch) => batch.notifications),
    );
    const notified: string[] = [];
    for (const id of store.rowIds()) {
      store.subscribeRow(id, () => notified.push(id));
    }
    let listChanges = 0;
    store.subscribeList(() => (listChanges += 1));
    const before = store.row('history-1');
    store.apply([
      {
        jsonrpc: '2.0',
        method: 'item/agentMessage/delta',
        params: { ...session.header(), turnId: 't', itemId: 't-msg-1', delta: 'x' },
      },
    ]);
    expect(notified).toEqual(['t-msg-1']);
    expect(listChanges).toBe(0);
    expect(store.row('history-1')).toBe(before);
  });

  it('echoes user input as its own row', () => {
    const store = new TranscriptStore();
    store.addUserMessage('c1', [{ kind: 'text', text: 'hi' }], 'hi');
    expect(store.rowIds()).toEqual(['user:c1']);
    expect(store.row('user:c1')).toMatchObject({ kind: 'user', text: 'hi' });
  });
});
