// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useHomeTools, type HomeTools } from './home-draft.js';
import type { View } from './ui.js';

const { toggled } = vi.hoisted(() => ({ toggled: [] as string[] }));
vi.mock('./registry.js', () => ({
  togglePanel: (id: string) => {
    toggled.push(id);
  },
}));

function harness() {
  const created: string[] = [];
  const discarded: string[] = [];
  let next = 0;
  const api = {
    createDraftSession: (workspace: string) => {
      created.push(workspace);
      next += 1;
      return Promise.resolve(JSON.stringify({ sessionId: `draft-${String(next)}` }));
    },
    discardDraftSession: (id: string) => {
      discarded.push(id);
      return Promise.resolve();
    },
  };
  let tools: HomeTools | undefined;
  function Probe({ view }: { readonly view: View }) {
    tools = useHomeTools(view, api);
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (view: View) => {
    act(() => {
      root.render(<Probe view={view} />);
    });
  };
  const current = () => {
    if (tools === undefined) throw new Error('not rendered');
    return tools;
  };
  return { api, created, discarded, render, current, root };
}

const home: View = { kind: 'home', workspace: '/w' };

describe('the new-session view’s draft session', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    toggled.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens one draft for the first tool, then the tool; the message keeps it', async () => {
    const h = harness();
    h.render(home);
    expect(h.current().open).toBeUndefined();
    act(() => {
      h.current().report('/w', false);
    });
    expect(h.current().sessionId).toBeUndefined();
    await act(async () => {
      h.current().open?.('terminal');
      h.current().open?.('files');
      await Promise.resolve();
    });
    expect(h.created).toEqual(['/w']);
    expect(h.current().sessionId).toBe('draft-1');
    expect(toggled).toEqual(['terminal', 'files']);
    // With the draft open, a tool opens at once.
    act(() => {
      h.current().open?.('changes');
    });
    expect(toggled.at(-1)).toBe('changes');
    // The first message moves the view to the draft: it is a conversation now.
    h.render({ kind: 'session', id: 'draft-1' });
    expect(h.discarded).toEqual([]);
    h.root.unmount();
  });

  it('discards the draft when the view leaves it, changes folder or picks a worktree', async () => {
    for (const leave of ['session', 'folder', 'worktree'] as const) {
      const h = harness();
      h.render(home);
      act(() => {
        h.current().report('/w', false);
      });
      await act(async () => {
        await h.current().prepare?.();
      });
      expect(h.current().sessionId).toBe('draft-1');
      if (leave === 'session') h.render({ kind: 'session', id: 'other' });
      else
        act(() => {
          h.current().report(leave === 'folder' ? '/other' : '/w', leave === 'worktree');
        });
      expect(h.discarded).toEqual(['draft-1']);
      expect(h.current().sessionId).toBeUndefined();
      h.root.unmount();
    }
  });

  it('opens nothing in a worktree: the tools wait for the first message', async () => {
    const h = harness();
    h.render(home);
    act(() => {
      h.current().report('/w', true);
    });
    expect(h.current().waiting).toBe(true);
    expect(h.current().open).toBeUndefined();
    expect(h.current().prepare).toBeUndefined();
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.created).toEqual([]);
    h.root.unmount();
  });

  it('discards a draft that opened after the view moved on', async () => {
    const h = harness();
    let resolve: (text: string) => void = () => undefined;
    h.api.createDraftSession = (workspace: string) => {
      h.created.push(workspace);
      return new Promise<string>((done) => {
        resolve = done;
      });
    };
    h.render(home);
    act(() => {
      h.current().report('/w', false);
    });
    let opened: Promise<string | undefined> | undefined;
    act(() => {
      opened = h.current().prepare?.();
    });
    h.render({ kind: 'session', id: 'other' });
    await act(async () => {
      resolve(JSON.stringify({ sessionId: 'late' }));
      await opened;
    });
    expect(h.discarded).toEqual(['late']);
    expect(h.current().sessionId).toBeUndefined();
    h.root.unmount();
  });
});
