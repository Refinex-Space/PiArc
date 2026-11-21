// @vitest-environment happy-dom
// T43-A04: a turn whose reply streams at 100 tokens a second for 20 s updates the live region
// once per interval, not per token, and announces the result once when the turn ends.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { SessionTranscript } from '../store/transcript.js';
import { LIVE_ANNOUNCE } from './constants.js';
import { HighlightClient } from './highlight/highlight-client.js';
import { LiveRegion } from './LiveRegion.js';
import { MarkdownClient } from './markdown/markdown-client.js';
import { RowHeights } from './row-heights.js';
import { Expansion, TranscriptContext } from './services.js';
import { StreamingDriver } from './streaming-driver.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let seq = 0;
function note(method: string, params: Record<string, unknown>) {
  seq += 1;
  return { method, params: { sessionId: 's', seq, ts: 0, ...params } };
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(window, { piarc: { onAppEvent: () => () => undefined } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveRegion', () => {
  it('updates once per interval while a reply streams, then announces the result once', async () => {
    const transcript = new SessionTranscript();
    const port = { postMessage: () => undefined, addEventListener: () => undefined };
    const markdown = new MarkdownClient(port);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <AppProvider
          initial={{
            platform: 'darwin',
            preferences: { ...DEFAULT_PREFERENCES, language: 'en' },
            locale: 'en',
            focused: true,
            notificationsSupported: true,
          }}
        >
          <TranscriptContext.Provider
            value={{
              services: {
                markdown,
                highlight: new HighlightClient(port),
                driver: new StreamingDriver(markdown, {
                  requestAnimationFrame: () => 0,
                  cancelAnimationFrame: () => undefined,
                }),
                heights: new RowHeights(),
                expansion: new Expansion(),
                renderCounter: null,
              },
              transcript,
              actions: { retry: () => undefined, resend: () => undefined },
            }}
          >
            <LiveRegion />
          </TranscriptContext.Provider>
        </AppProvider>,
      );
      await Promise.resolve();
    });
    const region = container.querySelector('[data-testid="live-region"]');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    if (region === null) throw new Error('no live region');
    // The region's text after each step; a change is an announcement.
    const updates: string[] = [];
    const record = () => {
      const text = region.textContent;
      if (text !== '' && text !== updates.at(-1)) updates.push(text);
    };

    act(() => {
      transcript.apply([
        note('turn/started', { turnId: 't1' }),
        note('item/started', {
          turnId: 't1',
          item: { type: 'agentMessage', itemId: 'a1', status: 'inProgress', text: '' },
        }),
      ]);
    });
    const seconds = 20;
    for (let token = 0; token < seconds * 100; token++) {
      act(() => {
        transcript.apply([note('item/agentMessage/delta', { itemId: 'a1', delta: 'word ' })]);
        vi.advanceTimersByTime(10);
      });
      record();
    }
    await act(async () => {
      transcript.apply([
        note('item/completed', {
          turnId: 't1',
          item: {
            type: 'agentMessage',
            itemId: 'a1',
            status: 'completed',
            text: 'The parser is fixed.',
          },
        }),
        note('turn/completed', { turnId: 't1', status: 'completed' }),
      ]);
      await Promise.resolve();
    });
    record();
    await act(async () => {
      vi.advanceTimersByTime(LIVE_ANNOUNCE.intervalMs * 2);
      await Promise.resolve();
    });
    record();
    const progress = updates.filter((text) => text.startsWith('Writing the reply'));
    // 2,000 tokens; at most one update per interval (plus the first).
    expect(progress.length).toBeGreaterThanOrEqual((seconds * 1000) / LIVE_ANNOUNCE.intervalMs - 1);
    expect(progress.length).toBeLessThanOrEqual((seconds * 1000) / LIVE_ANNOUNCE.intervalMs + 1);
    expect(updates.filter((text) => text === 'Reply: The parser is fixed.')).toHaveLength(1);
    expect(updates.at(-1)).toBe('Reply: The parser is fixed.');
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
