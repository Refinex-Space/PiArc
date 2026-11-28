// @vitest-environment happy-dom
// A session picked from the list is reopened as it is shown: the context card mounts before
// Core has the session, whose usage request then fails with `sessionNotFound`. The usage loads
// once the session is open, without another message.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppStore } from './app-store.js';
import { StoreContext, useContextUsage } from './hooks.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = 's-1';
const USAGE = {
  tokens: 1500,
  contextWindow: 200_000,
  autoCompactThreshold: 182_904,
  categories: {
    systemPrompt: 500,
    tools: 400,
    mcpTools: 0,
    memory: 0,
    skills: 0,
    conversation: 300,
    toolResults: 0,
    unclassified: 300,
  },
  source: 'provider',
  autoCompact: 'on',
};

function Tokens() {
  const usage = useContextUsage(SESSION);
  return <span>{usage === undefined ? 'none' : String(usage.tokens)}</span>;
}

let unmount: (() => void) | undefined;

afterEach(() => {
  unmount?.();
  unmount = undefined;
  vi.unstubAllGlobals();
});

describe('context usage of a session reopened from the list', () => {
  it('loads once Core has opened the session', async () => {
    let open = false;
    const contextUsage = vi.fn(() =>
      open
        ? Promise.resolve(JSON.stringify(USAGE))
        : Promise.reject(new Error('[piarc:sessionNotFound] no open session')),
    );
    vi.stubGlobal('piarc', { contextUsage });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new AppStore();
    store.applySessions({ revision: 1, sessions: [{ id: SESSION, status: 'idle', open: false }] });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <StoreContext.Provider value={store}>
          <Tokens />
        </StoreContext.Provider>,
      );
      await Promise.resolve();
    });
    unmount = () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    };
    expect(container.textContent).toBe('none');

    // Core reopens the session (the conversation resumes it as it is shown).
    open = true;
    await act(async () => {
      store.applySessions({ revision: 2, sessions: [{ id: SESSION, status: 'idle', open: true }] });
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toBe('1500');
  });
});
