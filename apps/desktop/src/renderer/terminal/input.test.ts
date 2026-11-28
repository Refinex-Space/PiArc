// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import type { TerminalKeyMessage } from '../../shared/ipc.js';
import { IME_PROCESS_KEY_CODE } from '../composer/ime-guard.js';
import { attachInput, keyIntent, type InputHost } from './input.js';

/** A host that records what reached it. */
function recorder(overrides: Partial<InputHost> = {}) {
  const calls: string[] = [];
  const host: InputHost = {
    platform: 'mac',
    isGlobalKey: () => false,
    attached: () => true,
    hasSelection: () => false,
    copy: () => calls.push('copy'),
    key: (message: TerminalKeyMessage) => calls.push(`key ${message.action} ${message.code}`),
    text: (text) => calls.push(`text ${text}`),
    paste: (text) => calls.push(`paste ${text}`),
    preedit: (text) => calls.push(`preedit ${text}`),
    ...overrides,
  };
  return { host, calls };
}

let detach: (() => void) | undefined;
afterEach(() => {
  detach?.();
  document.body.replaceChildren();
});

function textarea(host: InputHost): HTMLTextAreaElement {
  const element = document.createElement('textarea');
  document.body.append(element);
  detach = attachInput(host, element);
  return element;
}

/** A composition event with `data` (happy-dom ignores `data` in the constructor's options). */
function composition(type: string, data: string): CompositionEvent {
  const event = new CompositionEvent(type, { data });
  Object.defineProperty(event, 'data', { value: data });
  return event;
}

/** A key the input method processes: Chromium reports keyCode 229 for it. */
function processKey(target: EventTarget): void {
  const event = new KeyboardEvent('keydown', { key: 'Process', code: 'KeyN', cancelable: true });
  Object.defineProperty(event, 'keyCode', { value: IME_PROCESS_KEY_CODE });
  target.dispatchEvent(event);
}

function key(
  target: EventTarget,
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit,
): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('terminal input', () => {
  it('draws the preedit, keeps composing keys from Core and commits the text once (A03)', () => {
    const { host, calls } = recorder();
    const element = textarea(host);
    element.dispatchEvent(composition('compositionstart', ''));
    element.dispatchEvent(composition('compositionupdate', 'ni'));
    // Keys while composing (keyCode 229 or isComposing) belong to the input method.
    processKey(element);
    key(element, 'keydown', { key: 'n', code: 'KeyN', isComposing: true });
    element.dispatchEvent(composition('compositionupdate', '你好'));
    element.value = '你好';
    element.dispatchEvent(new InputEvent('input', { data: '你好', isComposing: true }));
    element.dispatchEvent(composition('compositionend', '你好'));
    // The input event that follows the commit must not write the text a second time.
    element.dispatchEvent(new InputEvent('input', { data: '你好' }));
    expect(calls).toEqual(['preedit ni', 'preedit 你好', 'preedit ', 'text 你好']);
    expect(element.value).toBe('');
  });

  it('sends keys to Core and their releases, but not the releases of keys it did not send', () => {
    const { host, calls } = recorder();
    const element = textarea(host);
    const down = key(element, 'keydown', { key: 'a', code: 'KeyA' });
    expect(down.defaultPrevented).toBe(true);
    key(element, 'keyup', { key: 'a', code: 'KeyA' });
    // ⌘ shortcuts stay with the app; no release follows them either.
    const command = key(element, 'keydown', { key: 'n', code: 'KeyN', metaKey: true });
    expect(command.defaultPrevented).toBe(false);
    key(element, 'keyup', { key: 'n', code: 'KeyN', metaKey: true });
    expect(calls).toEqual(['key press KeyA', 'key release KeyA']);
  });

  it('leaves global shortcuts to the window', () => {
    const { host, calls } = recorder({ isGlobalKey: (event) => event.code === 'Backquote' });
    const element = textarea(host);
    const toggle = key(element, 'keydown', { key: '`', code: 'Backquote', ctrlKey: true });
    expect(toggle.defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });

  it('copies with Mod+C and lets the paste event carry the text', () => {
    const { host, calls } = recorder();
    const element = textarea(host);
    const copy = key(element, 'keydown', { key: 'c', code: 'KeyC', metaKey: true });
    expect(copy.defaultPrevented).toBe(true);
    const paste = key(element, 'keydown', { key: 'v', code: 'KeyV', metaKey: true });
    expect(paste.defaultPrevented).toBe(false);
    const data = new DataTransfer();
    data.setData('text/plain', 'echo hi\n');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, cancelable: true }));
    expect(calls).toEqual(['copy', 'paste echo hi\n']);
  });
});

describe('key intent', () => {
  const event = (init: Partial<KeyboardEvent>) => ({
    code: 'KeyC',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  });

  it('on Windows Ctrl+C copies only with a selection, else interrupts the program', () => {
    expect(keyIntent(event({ ctrlKey: true }), 'other', true, false)).toBe('copy');
    expect(keyIntent(event({ ctrlKey: true }), 'other', false, false)).toBe('terminal');
    expect(keyIntent(event({ ctrlKey: true, shiftKey: true }), 'other', false, false)).toBe('copy');
    expect(keyIntent(event({ ctrlKey: true, code: 'KeyV' }), 'other', false, false)).toBe('paste');
  });

  it('on macOS ⌘C copies, Ctrl+C interrupts, other ⌘ keys stay with the app', () => {
    expect(keyIntent(event({ metaKey: true }), 'mac', false, false)).toBe('copy');
    expect(keyIntent(event({ ctrlKey: true }), 'mac', true, false)).toBe('terminal');
    expect(keyIntent(event({ metaKey: true, code: 'KeyN' }), 'mac', false, false)).toBe('app');
    expect(keyIntent(event({ ctrlKey: true, code: 'Backquote' }), 'mac', false, true)).toBe(
      'global',
    );
  });
});
