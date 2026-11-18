// T19: one reducer for Core's live notifications and history windows — tool groups, error and
// uncertain rows, the working row and turn state, the queue, undelivered inputs and exchanges.
import type { Item } from '@piarc/protocol';
import { describe, expect, it } from 'vitest';

import { SessionTranscript, WORKING_ROW } from './transcript.js';

const S = 's-1';
let seq = 0;

function note(method: string, params: Record<string, unknown>, ts = 1000) {
  seq += 1;
  return { method, params: { sessionId: S, seq, ts, ...params } };
}

const read = (id: string, status: Item['status'] = 'completed'): Item => ({
  type: 'dynamicToolCall',
  itemId: id,
  status,
  tool: 'Read',
  arguments: { path: `${id}.ts` },
});
const bash = (id: string, status: Item['status'] = 'completed'): Item => ({
  type: 'commandExecution',
  itemId: id,
  status,
  tool: 'Bash',
  arguments: {},
  command: 'ls',
});
const edit = (id: string): Item => ({
  type: 'fileChange',
  itemId: id,
  status: 'completed',
  tool: 'Edit',
  arguments: {},
  path: 'a.ts',
});
const text = (id: string, value: string, status: Item['status'] = 'completed'): Item => ({
  type: 'agentMessage',
  itemId: id,
  status,
  text: value,
});
const user = (id: string, value: string): Item => ({
  type: 'userMessage',
  itemId: id,
  status: 'completed',
  text: value,
});

/** A completed turn as live notifications. */
function liveTurn(turnId: string, items: readonly Item[]) {
  return [
    note('turn/started', { turnId }),
    ...items.flatMap((item) => [
      note('item/started', { turnId, item: { ...item, status: 'inProgress' } }),
      note('item/completed', { turnId, item }),
    ]),
    note('turn/completed', { turnId, status: 'completed' }),
  ];
}

describe('SessionTranscript rows', () => {
  const items = [
    user('u1', 'Fix it'),
    read('r1'),
    read('r2'),
    edit('e1'),
    bash('b1'),
    read('r3'),
    text('m1', 'Done.'),
  ];

  it('folds consecutive tool calls other than commands into groups', () => {
    const transcript = new SessionTranscript();
    transcript.apply(liveTurn('t1', items));
    expect(transcript.rowIds()).toEqual(['u1', 'group:r1', 'b1', 'group:r3', 'm1']);
    expect(transcript.row('group:r1')).toEqual({
      kind: 'group',
      id: 'group:r1',
      members: ['r1', 'r2', 'e1'],
    });
  });

  it('shows a history window with the same rows as the live stream', () => {
    const live = new SessionTranscript();
    live.apply(liveTurn('t1', items));
    const history = new SessionTranscript();
    history.load(
      items.map((item) => ({ entryId: 'entry', item })),
      0,
    );
    expect(history.rowIds()).toEqual(live.rowIds());
    expect(history.historyStart()).toBe(0);
    // Earlier history goes in front and joins nothing it should not.
    history.prepend([{ entryId: 'e0', item: text('m0', 'Earlier.') }], 0);
    expect(history.rowIds()[0]).toBe('m0');
  });

  it('keeps the working row last while a turn runs and tracks the turn', () => {
    const transcript = new SessionTranscript();
    transcript.apply([note('turn/started', { turnId: 't1' }, 5000)]);
    expect(transcript.rowIds()).toEqual([WORKING_ROW]);
    expect(transcript.turnInfo()).toMatchObject({ running: true, turnId: 't1', startedAt: 5000 });
    transcript.apply([note('item/started', { turnId: 't1', item: read('r1', 'inProgress') })]);
    expect(transcript.rowIds()).toEqual(['group:r1', WORKING_ROW]);
    expect(transcript.turnInfo().openTools).toEqual(['r1']);
    transcript.apply([
      note('turn/retrying', {
        turnId: 't1',
        attempt: 2,
        maxAttempts: 3,
        delayMs: 5,
        errorMessage: 'x',
      }),
    ]);
    expect(transcript.turnInfo().retry).toEqual({ attempt: 2, max: 3 });
    transcript.apply([
      note('turn/usage', {
        turnId: 't1',
        usage: {
          inputTokens: 10,
          outputTokens: 42,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
        },
      }),
      note('item/completed', { turnId: 't1', item: read('r1') }),
      note('item/started', {
        turnId: 't1',
        item: { type: 'contextCompaction', itemId: 'c1', status: 'inProgress' },
      }),
    ]);
    expect(transcript.turnInfo()).toMatchObject({
      retry: undefined,
      openTools: [],
      compacting: true,
      usage: { outputTokens: 42 },
    });
    transcript.apply([note('turn/completed', { turnId: 't1', status: 'completed' })]);
    expect(transcript.rowIds()).toEqual(['group:r1', 'c1']);
    expect(transcript.isRunning()).toBe(false);
  });

  it('adds an error card with Core’s kind and an uncertain card after a restart', () => {
    const transcript = new SessionTranscript();
    transcript.apply([
      note('turn/started', { turnId: 't1' }),
      note('item/completed', { turnId: 't1', item: user('u1', 'Hi') }),
      note('turn/completed', {
        turnId: 't1',
        status: 'failed',
        errorMessage: '401 refused',
        errorKind: 'auth',
        retryable: false,
      }),
      note('turn/started', { turnId: 't2' }),
      note('session/uncertain', { turnId: 't2', method: 'session/prompt' }),
    ]);
    expect(transcript.rowIds()).toEqual(['u1', 'error:t1', 'uncertain:t2']);
    expect(transcript.row('error:t1')).toMatchObject({
      kind: 'error',
      errorKind: 'auth',
      retryable: false,
      message: '401 refused',
    });
    expect(transcript.isRunning()).toBe(false);
    expect(transcript.retryInput('t1')).toEqual({
      kind: 'stored',
      input: { text: 'Hi', mentions: [], attachments: [] },
    });
  });

  it('marks an input Core did not take as undelivered and sends it again in place', () => {
    const transcript = new SessionTranscript();
    transcript.addOptimistic('c1', { text: 'Hello', mentions: [], attachments: [] });
    transcript.markUndelivered('c1', 'offline');
    expect(transcript.row('optimistic:c1')).toMatchObject({
      state: 'undelivered',
      failure: 'offline',
    });
    transcript.markSending('c1');
    transcript.confirm('c1', 't1');
    transcript.apply([note('item/completed', { turnId: 't1', item: user('u1', 'Hello') })]);
    expect(transcript.rowIds()).toEqual(['u1']);
  });

  it('keeps Core’s queue and asks for a reload after lost notifications', () => {
    const transcript = new SessionTranscript();
    transcript.apply([
      note('session/queueChanged', {
        items: [
          { itemId: 'q1', kind: 'steer', text: 'also this' },
          {
            itemId: 'q2',
            kind: 'followUp',
            text: 'then that',
            attachments: [
              {
                kind: 'pdf',
                name: 'a.pdf',
                mimeType: 'application/pdf',
                blob: { path: '/x', sha256: 'f', size: 10 },
                pageCount: 2,
              },
            ],
          },
          { kind: 'bogus' },
        ],
      }),
      note('session/resync', { since: 1, next: 5 }),
    ]);
    expect(transcript.queue()).toEqual([
      { itemId: 'q1', kind: 'steer', text: 'also this', attachments: [] },
      {
        itemId: 'q2',
        kind: 'followUp',
        text: 'then that',
        attachments: [
          { kind: 'pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 10, pageCount: 2 },
        ],
      },
    ]);
    expect(transcript.needsReload()).toBe(true);
    transcript.load([]);
    expect(transcript.needsReload()).toBe(false);
  });

  it('finds the rows of an exchange: from a user message to the next', () => {
    const transcript = new SessionTranscript();
    transcript.apply([
      ...liveTurn('t1', items),
      ...liveTurn('t2', [user('u2', 'More'), text('m2', 'Ok')]),
    ]);
    expect(transcript.exchangeOf('b1')).toEqual(['u1', 'group:r1', 'b1', 'group:r3', 'm1']);
    expect(transcript.exchangeOf('m2')).toEqual(['u2', 'm2']);
  });

  it('keeps steering messages in their running turn and separates the next prompt', () => {
    const transcript = new SessionTranscript();
    const first = [user('u1', 'Start'), read('r1'), user('steer', 'Also this'), text('m1', 'Done')];
    const second = [user('u2', 'Next'), text('m2', 'Okay')];
    transcript.apply([...liveTurn('t1', first), ...liveTurn('t2', second)]);
    expect(transcript.exchangeOf('steer')).toEqual(['u1', 'group:r1', 'steer', 'm1']);
    expect(transcript.exchangeOf('m2')).toEqual(['u2', 'm2']);
    const history = new SessionTranscript();
    history.load(
      second.map((item) => ({ entryId: item.itemId, turnId: 't2', item })),
      first.length,
    );
    history.prepend(
      first.map((item) => ({ entryId: item.itemId, turnId: 't1', item })),
      0,
    );
    expect(history.exchangeOf('group:r1')).toEqual(transcript.exchangeOf('steer'));
  });

  it('records when items started and ended (thinking time, command timers)', () => {
    const transcript = new SessionTranscript();
    transcript.apply([
      note('turn/started', { turnId: 't1' }, 1000),
      note(
        'item/started',
        { turnId: 't1', item: { type: 'reasoning', itemId: 'th', status: 'inProgress', text: '' } },
        1000,
      ),
      note('item/reasoning/delta', { turnId: 't1', itemId: 'th', delta: 'hmm' }, 2000),
      note(
        'item/completed',
        {
          turnId: 't1',
          item: { type: 'reasoning', itemId: 'th', status: 'completed', text: 'hmm' },
        },
        4200,
      ),
    ]);
    expect(transcript.row('th')).toMatchObject({
      startedAt: 1000,
      endedAt: 4200,
      item: { text: 'hmm' },
    });
  });
});
