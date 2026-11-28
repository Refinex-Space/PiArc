import { describe, expect, it } from 'vitest';

import { AppStore } from './app-store.js';

describe('notices', () => {
  it('shows one notice per type and one per hook notice id', () => {
    const store = new AppStore();
    store.applyNotice({ type: 'gitBashMissing', message: 'missing' });
    store.applyNotice({ type: 'gitBashMissing', message: 'again' });
    store.applyNotice({
      type: 'hook',
      id: 'a',
      sessionId: 's',
      event: 'PreToolUse',
      level: 'error',
      message: 'exited with code 1: lint failed',
    });
    store.applyNotice({
      type: 'hook',
      id: 'b',
      event: 'Stop',
      level: 'message',
      message: 'Saved.',
    });
    store.applyNotice({
      type: 'hook',
      id: 'b',
      event: 'Stop',
      level: 'message',
      message: 'Saved.',
    });
    expect(store.notices().map((n) => [n.key, n.hook])).toEqual([
      ['gitBashMissing', undefined],
      ['hook:a', { event: 'PreToolUse', error: true }],
      ['hook:b', { event: 'Stop', error: false }],
    ]);
    store.dismissNotice('hook:a');
    expect(store.notices().map((n) => n.key)).toEqual(['gitBashMissing', 'hook:b']);
  });

  it('keeps the five newest hook notices', () => {
    const store = new AppStore();
    store.applyNotice({ type: 'gitBashMissing', message: 'missing' });
    for (let n = 0; n < 7; n += 1) {
      store.applyNotice({ type: 'hook', id: String(n), event: 'Stop', message: `m${String(n)}` });
    }
    expect(store.notices().map((n) => n.key)).toEqual([
      'gitBashMissing',
      'hook:2',
      'hook:3',
      'hook:4',
      'hook:5',
      'hook:6',
    ]);
  });
});

it('drops a removed owner’s draft and preserves drafts of the remaining owners', () => {
  const store = new AppStore();
  store.applySessions({ revision: 1, sessions: [{ id: 'session' }] });
  store.applyWorkspaces({ revision: 1, workspaces: [{ path: '/one' }, { path: '/two' }] });
  const session = store.editorDraft('session', 'session');
  const first = store.editorDraft('workspace', '/one');
  const second = store.editorDraft('workspace', '/two');
  store.applySessions({ revision: 2, sessions: [] });
  store.applyWorkspaces({ revision: 2, workspaces: [{ path: '/two' }] });
  expect(store.editorDraft('session', 'session')).not.toBe(session);
  expect(store.editorDraft('workspace', '/one')).not.toBe(first);
  expect(store.editorDraft('workspace', '/two')).toBe(second);
});

describe('draft sessions', () => {
  it('reaches a draft by id but leaves it out of the session list until it takes an input', () => {
    const store = new AppStore();
    store.applySessions({
      revision: 1,
      sessions: [
        { id: 'kept', status: 'idle', workspace: '/w' },
        { id: 'draft', status: 'idle', workspace: '/w', open: true, draft: true },
      ],
    });
    expect(store.sessions().map((s) => s.id)).toEqual(['kept']);
    expect(store.session('draft')?.draft).toBe(true);
    expect(store.session('draft')?.workspace).toBe('/w');

    store.applySessions({
      revision: 2,
      sessions: [
        { id: 'kept', status: 'idle', workspace: '/w' },
        { id: 'draft', status: 'running', workspace: '/w', open: true },
      ],
    });
    expect(store.sessions().map((s) => s.id)).toEqual(['kept', 'draft']);
    expect(store.session('draft')?.draft).toBe(false);
  });
});

it('tells listeners about the first workspace snapshot even when it is empty (ADR-0110)', () => {
  const store = new AppStore();
  let calls = 0;
  store.subscribeWorkspaces(() => {
    calls += 1;
  });
  expect(store.hasWorkspaces()).toBe(false);
  store.applyWorkspaces({ revision: 1, workspaces: [] });
  expect(store.hasWorkspaces()).toBe(true);
  expect(calls).toBe(1);
  store.applyWorkspaces({ revision: 2, workspaces: [] });
  expect(calls).toBe(1);
});
