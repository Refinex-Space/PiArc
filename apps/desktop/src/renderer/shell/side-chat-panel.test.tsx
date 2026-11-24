// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEvent, EventListener } from '../../shared/ipc.js';
import { DEFAULT_PREFERENCES } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { registerPanel } from './registry.js';
import { Shell } from './Shell.js';

const parent = 'session-one';
const route = 'session/' + parent;
const events = new Map<string, EventListener>();
const appEvents = new Set<(event: AppEvent) => void>();
const ask = vi.fn<(session: string, panel: string, question: string) => Promise<string>>();
const control = vi.fn<(session: string, panel: string, close: boolean) => Promise<void>>();
const abort = vi.fn();
const prompt = vi.fn();
let root: Root;
let container: HTMLDivElement;
let unregister: () => void;

async function settle(action: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await action();
  });
}

function element(selector: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error('Missing ' + selector);
  return found;
}

function panel(): HTMLElement {
  return element('[data-testid="side-chat"]');
}

function button(label: string): HTMLButtonElement {
  const found = [...panel().querySelectorAll('button')].find((item) => item.textContent === label);
  if (found === undefined) throw new Error('Missing side chat action ' + label);
  return found;
}

function key(code: string): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { code, metaKey: true, bubbles: true, cancelable: true }),
  );
}

async function send(question: string): Promise<void> {
  const input = element('[data-testid="side-chat-question"]');
  await settle(() => {
    // React observes a native user edit separately from the value it last rendered.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      input,
      question,
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(() => {
    button('Send').click();
  });
}

function complete(text: string, stopped = false): string {
  return JSON.stringify({ text, stopped });
}

describe('side chat in a running session window', () => {
  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('Worker', EventTarget);
    ask.mockReset();
    control.mockReset().mockResolvedValue(undefined);
    abort.mockReset();
    prompt.mockReset();
    events.clear();
    appEvents.clear();
    vi.stubGlobal('piarc', {
      takeLaunchTargets: vi.fn().mockResolvedValue([{ kind: 'session', sessionId: parent }]),
      onAppEvent: (listener: (event: AppEvent) => void) => {
        appEvents.add(listener);
        return () => {
          appEvents.delete(listener);
        };
      },
      subscribeEvents: (name: string, listener: EventListener) => {
        events.set(name, listener);
        return Promise.resolve();
      },
      resendSnapshots: vi.fn().mockResolvedValue(undefined),
      contextUsage: vi.fn().mockResolvedValue('{}'),
      composerInfo: vi.fn().mockResolvedValue('{}'),
      setAttentionCount: vi.fn().mockResolvedValue(undefined),
      transcriptWindow: vi.fn().mockResolvedValue('{"start":0,"items":[]}'),
      askSideChat: ask,
      controlSideChat: control,
      abort,
      prompt,
    });
    container = document.createElement('div');
    document.body.append(container);
    unregister = registerPanel({
      id: 'other-side-chat-test',
      area: 'dock',
      title: 'panel.changes',
      order: 99,
      render: () => null,
    });
    root = createRoot(container);
    await settle(() => {
      root.render(
        <AppProvider
          initial={{
            platform: 'darwin',
            focused: true,
            notificationsSupported: false,
            locale: 'en',
            preferences: DEFAULT_PREFERENCES,
          }}
        >
          <Shell />
        </AppProvider>,
      );
    });
    const listener = events.get(route);
    if (!listener) throw new Error('The window did not subscribe to the main session');
    await settle(() => {
      listener({
        route,
        seq: 1,
        payload: new TextEncoder().encode(
          JSON.stringify([
            {
              method: 'turn/started',
              params: { sessionId: parent, seq: 1, ts: 1000, turnId: 'main-turn' },
            },
            {
              method: 'session/queueChanged',
              params: {
                sessionId: parent,
                seq: 2,
                ts: 1001,
                items: [{ itemId: 'later', kind: 'followUp', text: 'Main follow-up' }],
              },
            },
          ]),
        ),
      });
    });
    expect(element('[data-testid="composer-stop"]').getAttribute('aria-label')).toBe('Stop');
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    unregister();
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stops only the side request and preserves its answer and clipboard action across dock tabs', async () => {
    await settle(() => {
      key('Semicolon');
    });
    const reply = Promise.withResolvers<string>();
    ask.mockReturnValueOnce(reply.promise);
    await send('A side question');
    const id = ask.mock.calls[0]?.[1];
    expect(id).toEqual(expect.any(String));
    expect(ask).toHaveBeenCalledWith(parent, id, 'A side question');
    await settle(() => {
      button('Stop').click();
    });
    expect(control.mock.calls).toEqual([[parent, id, false]]);
    expect(abort).not.toHaveBeenCalled();
    const other = element('[data-testid="panel-tab-other-side-chat-test"]');
    await settle(() => {
      other.click();
    });
    expect(panel().closest('[hidden]')).not.toBeNull();
    const answer = 'Partial answer <as text>';
    await settle(() => {
      reply.resolve(complete(answer, true));
    });
    await settle(() => {
      element('[data-testid="panel-tab-side-chat"]').click();
    });
    expect(element('[data-testid="side-chat-answer"]').textContent).toBe(answer);
    expect(panel().textContent).toContain('Answer stopped');
    expect(panel().closest('[hidden]')).toBeNull();
    expect(control.mock.calls).toEqual([[parent, id, false]]);
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await settle(() => {
      button('Copy text').click();
    });
    expect(write).toHaveBeenCalledExactlyOnceWith(answer);
    expect(element('[data-testid="composer-stop"]').getAttribute('aria-label')).toBe('Stop');
    expect(element('[data-testid="queue-text"]').textContent).toBe('Main follow-up');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('opens with /btw and a remapped key, drops late replies after close and recovers from errors', async () => {
    const editor = element('[data-testid="composer-input"]');
    await settle(() => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', '/btw');
      editor.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
      );
    });
    expect(editor.textContent).toBe('/btw');
    await settle(() => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const late = Promise.withResolvers<string>();
    ask.mockReturnValueOnce(late.promise);
    await send('Old question');
    const first = ask.mock.calls[0]?.[1];
    await settle(() => {
      button('Close side chat').click();
    });
    expect(control.mock.calls).toEqual([[parent, first, true]]);
    expect(container.querySelector('[data-testid="side-chat"]')).toBeNull();
    await settle(() => {
      for (const listener of appEvents)
        listener({
          type: 'preferences',
          locale: 'en',
          preferences: { ...DEFAULT_PREFERENCES, keybindings: { 'session.sideChat': 'Mod+J' } },
        });
    });
    await settle(() => {
      key('Semicolon');
    });
    expect(container.querySelector('[data-testid="side-chat"]')).toBeNull();
    await settle(() => {
      key('KeyJ');
    });
    await settle(() => {
      late.resolve(complete('Old answer'));
    });
    expect(panel().textContent).not.toContain('Old question');
    expect(panel().textContent).not.toContain('Old answer');
    ask.mockRejectedValueOnce(new Error('Provider unavailable'));
    await send('After reopen');
    const second = ask.mock.calls[1]?.[1];
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
    expect(panel().textContent).toContain('Provider unavailable');
    ask.mockResolvedValueOnce(complete('Recovered'));
    await send('Try again');
    expect(ask).toHaveBeenLastCalledWith(parent, second, 'Try again');
    expect(element('[data-testid="side-chat-answer"]').textContent).toBe('Recovered');
    expect(abort).not.toHaveBeenCalled();
    expect(element('[data-testid="queue-text"]').textContent).toBe('Main follow-up');
    expect(prompt).not.toHaveBeenCalled();
  });
});
