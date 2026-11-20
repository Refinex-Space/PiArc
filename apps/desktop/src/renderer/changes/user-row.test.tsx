// @vitest-environment happy-dom
// T28: the first user message of a turn offers "rewind to here" and "branch from here", a turn
// with sibling branches shows "‹ n / m ›", and the prototype page (no such actions) shows none.
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { SessionTranscript } from '../store/transcript.js';
import { HighlightClient } from '../transcript/highlight/highlight-client.js';
import { MarkdownClient } from '../transcript/markdown/markdown-client.js';
import { RowHeights } from '../transcript/row-heights.js';
import {
  Expansion,
  TranscriptContext,
  type TranscriptActions,
  type TranscriptServices,
} from '../transcript/services.js';
import { StreamingDriver } from '../transcript/streaming-driver.js';
import { RowView } from '../transcript/rows/RowView.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const port = { postMessage: () => undefined, addEventListener: () => undefined };

function services(): TranscriptServices {
  const markdown = new MarkdownClient(port);
  return {
    markdown,
    highlight: new HighlightClient(port),
    driver: new StreamingDriver(markdown, {
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => undefined,
    }),
    heights: new RowHeights(),
    expansion: new Expansion(),
    renderCounter: null,
  };
}

let unmount: (() => void) | undefined;

beforeAll(() => {
  Object.assign(window, { piarc: { onAppEvent: () => () => undefined } });
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
});

async function render(
  transcript: SessionTranscript,
  ids: readonly string[],
  actions: TranscriptActions,
): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const node: ReactNode = (
    <AppProvider
      initial={{
        platform: 'darwin',
        preferences: { ...DEFAULT_PREFERENCES, language: 'en' },
        locale: 'en',
        focused: true,
      }}
    >
      <TranscriptContext.Provider value={{ services: services(), transcript, actions }}>
        {ids.map((id) => (
          <RowView key={id} id={id} />
        ))}
      </TranscriptContext.Provider>
    </AppProvider>
  );
  await act(async () => {
    root.render(node);
    await Promise.resolve();
  });
  unmount = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  return container;
}

function history(): SessionTranscript {
  const transcript = new SessionTranscript();
  const user = (id: string, text: string) => ({
    type: 'userMessage',
    itemId: id,
    status: 'completed',
    text,
  });
  transcript.load([
    { entryId: 'u1', turnId: 't1', item: user('u1', 'First request') },
    { entryId: 'u2', turnId: 't2', item: user('u2', 'Second request') },
    { entryId: 's2', turnId: 't2', item: user('s2', 'A steer in the same turn') },
  ]);
  transcript.branches.load([
    {
      turnId: 't2',
      index: 1,
      options: [
        { entryId: 'tip-a', turnId: 't-old', preview: 'Earlier attempt' },
        { entryId: 'tip-b', turnId: 't2', preview: 'Second request' },
      ],
    },
  ]);
  return transcript;
}

describe('user message actions', () => {
  it('rewinds, branches and switches from the first message of a turn', async () => {
    const actions = {
      retry: vi.fn(),
      resend: vi.fn(),
      rewind: vi.fn(),
      branchFrom: vi.fn(),
      switchBranch: vi.fn(),
    };
    const root = await render(history(), ['u1', 'u2', 's2'], actions);
    const rows = [...root.querySelectorAll<HTMLElement>('[data-testid="user-row"]')];
    expect(rows.map((row) => row.querySelector('[data-testid="rewind-here"]') !== null)).toEqual([
      true,
      true,
      false,
    ]);
    const second = rows[1];
    if (second === undefined) throw new Error('no second row');
    act(() => {
      second.querySelector<HTMLElement>('[data-testid="rewind-here"]')?.click();
      second.querySelector<HTMLElement>('[data-testid="branch-from-here"]')?.click();
    });
    expect(actions.rewind).toHaveBeenCalledWith('t2', 'Second request');
    expect(actions.branchFrom).toHaveBeenCalledWith('t2', 'Second request');
    expect(second.querySelector('[data-testid="branch-position"]')?.textContent).toBe('2 / 2');
    expect(rows[0]?.querySelector('[data-testid="branch-switcher"]')).toBeNull();
    const next = second.querySelector<HTMLButtonElement>('[data-testid="branch-next"]');
    expect(next?.disabled).toBe(true);
    act(() => {
      second.querySelector<HTMLElement>('[data-testid="branch-previous"]')?.click();
    });
    expect(actions.switchBranch).toHaveBeenCalledWith('tip-a');
  });

  it('shows none of them without the actions (the prototype page)', async () => {
    const root = await render(history(), ['u1', 'u2'], { retry: vi.fn(), resend: vi.fn() });
    expect(root.querySelector('[data-testid="rewind-here"]')).toBeNull();
    expect(root.querySelector('[data-testid="branch-from-here"]')).toBeNull();
    expect(root.querySelector('[data-testid="branch-switcher"]')).toBeNull();
  });
});
