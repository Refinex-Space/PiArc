// @vitest-environment happy-dom
// T18-A09: streaming deltas re-render only the last item's subscribers (counted renders of
// real React components), older snapshot revisions are dropped, and the optimistic echo is
// replaced by Core's message without ever showing twice.
import { act, memo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { AppStore } from './app-store.js';
import { StoreContext, useRow, useRowIds, useSession, useSessions } from './hooks.js';
import { attentionCount, badgeOf } from './status.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = 's-1';

function started(turnId: string, item: Record<string, unknown>) {
  return { method: 'item/started', params: { sessionId: SESSION, turnId, seq: 1, ts: 0, item } };
}

function delta(turnId: string, itemId: string, text: string) {
  return {
    method: 'item/agentMessage/delta',
    params: { sessionId: SESSION, turnId, itemId, delta: text, seq: 2, ts: 0 },
  };
}

function agent(itemId: string, text: string) {
  return { itemId, type: 'agentMessage', status: 'inProgress', text };
}

function sessionsSnapshot(revision: number, sessions: Record<string, unknown>[]) {
  return { revision, sessions };
}

let unmount: (() => void) | undefined;

afterEach(() => {
  unmount?.();
  unmount = undefined;
});

function render(store: AppStore, node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<StoreContext.Provider value={store}>{node}</StoreContext.Provider>);
  });
  unmount = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  return container;
}

describe('transcript subscriptions', () => {
  it('a streaming delta re-renders only the last item', () => {
    const store = new AppStore();
    const transcript = store.transcript(SESSION);
    transcript.apply([
      started('t1', agent('m1', 'first')),
      started('t1', agent('m2', 'second')),
      started('t2', agent('m3', 'third')),
    ]);
    const renders = new Map<string, number>();
    const Row = memo(function Row({ id }: { id: string }) {
      const row = useRow(SESSION, id);
      renders.set(id, (renders.get(id) ?? 0) + 1);
      return <p>{row?.kind === 'item' && 'text' in row.item ? row.item.text : ''}</p>;
    });
    let listRenders = 0;
    function List() {
      const ids = useRowIds(SESSION);
      listRenders += 1;
      return (
        <>
          {ids.map((id) => (
            <Row key={id} id={id} />
          ))}
        </>
      );
    }
    const container = render(store, <List />);
    expect(Object.fromEntries(renders)).toEqual({ m1: 1, m2: 1, m3: 1 });
    for (const chunk of [' a', ' b', ' c', ' d', ' e']) {
      act(() => {
        transcript.apply([delta('t2', 'm3', chunk)]);
      });
    }
    expect(Object.fromEntries(renders)).toEqual({ m1: 1, m2: 1, m3: 6 });
    expect(listRenders).toBe(1);
    expect(container.textContent).toBe('firstsecondthird a b c d e');
  });
});

describe('entity snapshots', () => {
  it('drops older revisions and keeps unchanged entries', () => {
    const store = new AppStore();
    const a = { id: 'a', status: 'idle', title: 'A' };
    const b = { id: 'b', status: 'running', title: 'B' };
    expect(store.applySessions(sessionsSnapshot(2, [a, b]))).toBe(true);
    const firstA = store.session('a');
    expect(store.applySessions(sessionsSnapshot(1, [a]))).toBe(false);
    expect(store.applySessions(sessionsSnapshot(2, [a]))).toBe(false);
    expect(store.applySessions({ revision: 'x', sessions: [] })).toBe(false);
    expect(store.sessions().map((s) => s.id)).toEqual(['a', 'b']);
    expect(
      store.applySessions(sessionsSnapshot(3, [a, { ...b, status: 'idle', unread: true }])),
    ).toBe(true);
    expect(store.session('a')).toBe(firstA);
    expect(store.session('b')?.unread).toBe(true);
  });

  it('re-renders only the subscribers of the session that changed', () => {
    const store = new AppStore();
    store.applySessions(
      sessionsSnapshot(1, [
        { id: 'a', status: 'idle' },
        { id: 'b', status: 'idle' },
      ]),
    );
    const renders: Record<string, number> = { a: 0, b: 0 };
    function Entry({ id }: { id: string }) {
      const session = useSession(id);
      renders[id] = (renders[id] ?? 0) + 1;
      return <span>{session?.status}</span>;
    }
    const Item = memo(Entry);
    function List() {
      const sessions = useSessions();
      return (
        <>
          {sessions.map((s) => (
            <Item key={s.id} id={s.id} />
          ))}
        </>
      );
    }
    render(store, <List />);
    act(() => {
      store.applySessions(
        sessionsSnapshot(2, [
          { id: 'a', status: 'idle' },
          { id: 'b', status: 'running' },
        ]),
      );
    });
    expect(renders).toEqual({ a: 1, b: 2 });
  });
});

describe('optimistic echo', () => {
  const user = (turnId: string, text: string) =>
    started(turnId, { itemId: `${turnId}:user:0`, type: 'userMessage', status: 'completed', text });

  it('is replaced in place by Core’s message once confirmed, never twice', () => {
    const transcript = new AppStore().transcript(SESSION);
    transcript.apply([started('t0', agent('m0', 'earlier'))]);
    transcript.addOptimistic('c1', { text: 'Hello', mentions: [], attachments: [] });
    expect(transcript.rowIds()).toEqual(['m0', 'optimistic:c1']);
    transcript.confirm('c1', 't1');
    transcript.apply([user('t1', 'Hello'), started('t1', agent('m1', 'Hi'))]);
    expect(transcript.rowIds()).toEqual(['m0', 't1:user:0', 'm1']);
  });

  it('handles Core’s message arriving before the prompt’s reply', () => {
    const transcript = new AppStore().transcript(SESSION);
    transcript.addOptimistic('c1', { text: 'Hello', mentions: [], attachments: [] });
    transcript.apply([user('t1', 'Hello')]);
    expect(transcript.rowIds()).toEqual(['t1:user:0']);
    transcript.confirm('c1', 't1');
    expect(transcript.rowIds()).toEqual(['t1:user:0']);
  });

  it('rolls back a failed input', () => {
    const transcript = new AppStore().transcript(SESSION);
    transcript.addOptimistic('c1', { text: 'Hello', mentions: [], attachments: [] });
    transcript.rollback('c1');
    expect(transcript.rowIds()).toEqual([]);
  });
});

describe('status', () => {
  const base = { status: 'idle' as const, pendingApprovals: 0, unread: false };

  it('takes the highest badge: error > awaiting > running > unread > idle', () => {
    expect(badgeOf({ ...base, status: 'error', pendingApprovals: 1, unread: true })).toBe('error');
    expect(badgeOf({ ...base, status: 'running', pendingApprovals: 2, unread: true })).toBe(
      'awaiting',
    );
    expect(badgeOf({ ...base, status: 'running', unread: true })).toBe('running');
    expect(badgeOf({ ...base, unread: true })).toBe('unread');
    expect(badgeOf(base)).toBe('idle');
  });

  it('counts sessions that need the user, never archived ones', () => {
    const store = new AppStore();
    store.applySessions(
      sessionsSnapshot(1, [
        { id: 'a', status: 'error' },
        { id: 'b', status: 'idle', unread: true },
        { id: 'c', status: 'running' },
        { id: 'd', status: 'idle', unread: true, archived: true },
        { id: 'e', status: 'running', pendingApprovals: 1 },
      ]),
    );
    expect(attentionCount(store.sessions())).toBe(3);
  });
});
