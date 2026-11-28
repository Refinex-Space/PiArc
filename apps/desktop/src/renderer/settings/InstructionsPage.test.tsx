// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeIpcError } from '../../shared/ipc-error.js';
import { DEFAULT_PREFERENCES } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { InstructionsPage, parseInstructions } from './InstructionsPage.js';

const view = (content: string, hash: string | null = 'a'.repeat(64)) =>
  JSON.stringify({ path: '/home/u/.pi/agent/AGENTS.md', exists: hash !== null, content, hash });

describe('parseInstructions', () => {
  it('reads Core’s view and refuses anything else', () => {
    expect(parseInstructions(view('x', null))).toEqual({
      path: '/home/u/.pi/agent/AGENTS.md',
      exists: false,
      content: 'x',
      hash: null,
    });
    expect(() => parseInstructions('{"path":1}')).toThrow();
  });
});

const piInstructions = vi.fn<() => Promise<string>>();
const savePiInstructions = vi.fn<(content: string, base: string | null) => Promise<string>>();
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('piarc', { piInstructions, savePiInstructions, onAppEvent: () => () => undefined });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  piInstructions.mockReset();
  savePiInstructions.mockReset();
});

async function render() {
  await act(async () => {
    root.render(
      <AppProvider
        initial={{
          platform: 'darwin',
          preferences: DEFAULT_PREFERENCES,
          locale: 'en',
          focused: true,
          notificationsSupported: true,
        }}
      >
        <InstructionsPage />
      </AppProvider>,
    );
    await Promise.resolve();
  });
}

const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function type(text: string) {
  const area = byTestId('instructions-editor') as HTMLTextAreaElement;
  // React tracks the value it set; the prototype's setter makes the change visible to it.
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  act(() => {
    descriptor?.set?.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('InstructionsPage', () => {
  it('saves an edit over the version it showed, CRLF shown as LF', async () => {
    piInstructions.mockResolvedValue(view('one\r\ntwo\r\n'));
    savePiInstructions.mockResolvedValue(view('one\ntwo\nthree\n', 'b'.repeat(64)));
    await render();
    const area = byTestId('instructions-editor') as HTMLTextAreaElement;
    expect(area.value).toBe('one\ntwo\n');
    expect((byTestId('instructions-save') as HTMLButtonElement).disabled).toBe(true);
    type('one\ntwo\nthree\n');
    await act(async () => {
      byTestId('instructions-save')?.click();
      await Promise.resolve();
    });
    expect(savePiInstructions).toHaveBeenCalledWith('one\ntwo\nthree\n', 'a'.repeat(64));
    expect(host.textContent).toContain('Saved. New turns use it.');
  });

  it('offers to load the file again when it changed on disk', async () => {
    piInstructions.mockResolvedValue(view('first'));
    savePiInstructions.mockRejectedValue(
      new Error(
        `Error invoking remote method 'piarc:instructions.save': Error: ${encodeIpcError('fileModified', 'x')}`,
      ),
    );
    await render();
    type('mine');
    await act(async () => {
      byTestId('instructions-save')?.click();
      await Promise.resolve();
    });
    expect(byTestId('instructions-error')?.textContent).toContain('changed on disk');
    piInstructions.mockResolvedValue(view('edited in Pi', 'c'.repeat(64)));
    await act(async () => {
      byTestId('instructions-reload')?.click();
      await Promise.resolve();
    });
    expect((byTestId('instructions-editor') as HTMLTextAreaElement).value).toBe('edited in Pi');
    expect(byTestId('instructions-error')).toBeNull();
  });
});
