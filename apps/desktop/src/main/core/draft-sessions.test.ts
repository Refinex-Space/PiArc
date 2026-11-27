import { describe, expect, it } from 'vitest';

import { DraftSessions, type DraftContents, type DraftCore } from './draft-sessions.js';

type Listener = (details?: { isMainFrame: boolean; isSameDocument: boolean }) => void;

function fakeContents(id: number) {
  const listeners = new Map<string, Listener[]>();
  const add = (event: string, listener: Listener) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  };
  const contents: DraftContents = {
    id,
    once: (event, listener) => {
      add(event, listener);
    },
    on: (event: string, listener: unknown) => {
      add(event, listener as Listener);
    },
  };
  const fire = (event: string, details?: { isMainFrame: boolean; isSameDocument: boolean }) => {
    for (const listener of listeners.get(event) ?? []) listener(details);
  };
  return { contents, fire };
}

function fakeCore() {
  let next = 0;
  const discarded: string[] = [];
  const core: DraftCore = {
    createDraftSession: () => {
      next += 1;
      return Promise.resolve(JSON.stringify({ sessionId: `draft-${String(next)}` }));
    },
    discardDraftSession: (id: string) => {
      discarded.push(id);
      return Promise.resolve('null');
    },
  };
  return { core, discarded };
}

describe('draft sessions', () => {
  it('records the window that opened a draft and forgets one it discarded', async () => {
    const { core, discarded } = fakeCore();
    const drafts = new DraftSessions(core);
    const { contents } = fakeContents(7);
    expect(JSON.parse(await drafts.create(contents, '/w'))).toEqual({ sessionId: 'draft-1' });
    await drafts.create(contents, '/w');
    expect(drafts.ownedBy(7)).toEqual(['draft-1', 'draft-2']);
    await drafts.discard(contents, 'draft-1');
    expect(discarded).toEqual(['draft-1']);
    expect(drafts.ownedBy(7)).toEqual(['draft-2']);
  });

  it('discards the drafts of a page that reloads, crashes or closes', async () => {
    for (const gone of ['reload', 'render-process-gone', 'destroyed'] as const) {
      const { core, discarded } = fakeCore();
      const drafts = new DraftSessions(core);
      const { contents, fire } = fakeContents(3);
      await drafts.create(contents, '/w');
      // A hash route and a subframe keep the page.
      fire('did-start-navigation', { isMainFrame: true, isSameDocument: true });
      fire('did-start-navigation', { isMainFrame: false, isSameDocument: false });
      expect(discarded).toEqual([]);
      if (gone === 'reload')
        fire('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      else fire(gone);
      expect(discarded).toEqual(['draft-1']);
      expect(drafts.ownedBy(3)).toEqual([]);
    }
  });

  it('keeps going when Core refuses a draft that became a conversation', async () => {
    const { core } = fakeCore();
    const refusing: DraftCore = {
      ...core,
      discardDraftSession: () => Promise.reject(new Error('is not a draft session')),
    };
    const drafts = new DraftSessions(refusing);
    const { contents, fire } = fakeContents(1);
    await drafts.create(contents, '/w');
    expect(() => {
      fire('destroyed');
    }).not.toThrow();
    await Promise.resolve();
  });

  it("does not touch another window's drafts", async () => {
    const { core, discarded } = fakeCore();
    const drafts = new DraftSessions(core);
    const first = fakeContents(1);
    const second = fakeContents(2);
    await drafts.create(first.contents, '/w');
    await drafts.create(second.contents, '/w');
    first.fire('destroyed');
    expect(discarded).toEqual(['draft-1']);
    expect(drafts.ownedBy(2)).toEqual(['draft-2']);
  });
});
