// PiArc tests for driver/page-keyboard.ts (ported from ego-browser, ego-lite commit 56589ea8, MIT,
// see LICENSE). Upstream covers the keyboard through page-model.test.mjs with an OS-clipboard fake;
// PiArc has no clipboard, so these cases check the replacement paste (a synthetic paste event, then
// Input.insertText) and the refused `{ html }` content against the controller directly.

import { describe, expect, test } from 'vitest';

import { fakeCdp } from '../../testing.js';
import type { CdpObject } from '../cdp-types.js';
import { PageKeyboardController, splitChord } from './page-keyboard.js';

interface Call {
  readonly method: string;
  readonly params: CdpObject;
  readonly sessionId: string | undefined;
}

function controller(
  options: {
    platform?: string;
    evaluate?: (expression: string) => unknown;
    fail?: (method: string) => Error | undefined;
  } = {},
) {
  const calls: Call[] = [];
  const keyboard = new PageKeyboardController(
    {
      cdp: fakeCdp((method, params, sessionId) => {
        calls.push({ method, params, sessionId });
        const failure = options.fail?.(method);
        if (failure) throw failure;
        if (method === 'Runtime.evaluate') {
          const expression = params.expression;
          return (
            options.evaluate?.(typeof expression === 'string' ? expression : '') ?? {
              result: { type: 'boolean', value: true },
            }
          );
        }
        return {};
      }),
      sleep: () => Promise.resolve(),
      platform: options.platform ?? 'darwin',
    },
    async (operation) => {
      await operation('session-1');
      return {};
    },
  );
  return { calls, keyboard };
}

describe('PageKeyboardController.paste', () => {
  test('dispatches a paste event with the text before inserting it', async () => {
    const { calls, keyboard } = controller();

    expect(await keyboard.paste('a\tb\nc\td')).toEqual({});

    expect(calls.map((call) => call.method)).toEqual(['Runtime.evaluate', 'Input.insertText']);
    const expression = calls[0]?.params.expression;
    expect(typeof expression).toBe('string');
    expect(String(expression)).toContain('new ClipboardEvent("paste"');
    expect(String(expression)).toContain(JSON.stringify('a\tb\nc\td'));
    expect(calls[0]?.params.returnByValue).toBe(true);
    expect(calls[1]).toEqual({
      method: 'Input.insertText',
      params: { text: 'a\tb\nc\td' },
      sessionId: 'session-1',
    });
    expect(
      calls.some((call) => call.method === 'Input.dispatchKeyEvent'),
      'no native shortcut is pressed',
    ).toBe(false);
  });

  test('accepts { text } content', async () => {
    const { calls, keyboard } = controller();

    await keyboard.paste({ text: 'A\tB' });

    expect(calls.at(-1)?.params).toEqual({ text: 'A\tB' });
  });

  test('leaves the paste to a page handler that cancelled the event', async () => {
    const { calls, keyboard } = controller({
      evaluate: () => ({ result: { type: 'boolean', value: false } }),
    });

    await keyboard.paste('handled by the page');

    expect(calls.map((call) => call.method)).toEqual(['Runtime.evaluate']);
  });

  test('still inserts the text when the paste event could not be dispatched', async () => {
    const { calls, keyboard } = controller({
      evaluate: () => ({
        result: { type: 'object', subtype: 'error' },
        exceptionDetails: { text: 'Uncaught' },
      }),
    });

    await keyboard.paste('fallback');

    expect(calls.map((call) => call.method)).toEqual(['Runtime.evaluate', 'Input.insertText']);
  });

  test('refuses HTML content without touching the page', async () => {
    const { calls, keyboard } = controller();

    await expect(
      keyboard.paste({ text: 'A\tB', html: '<table><tr><td>A</td><td>B</td></tr></table>' }),
    ).rejects.toThrow(/does not support \{ html \} in PiArc[\s\S]*plain text/);
    expect(calls).toEqual([]);
  });

  test('names the invalid argument type', async () => {
    const { calls, keyboard } = controller({ platform: 'win32' });

    for (const [value, received] of [
      [undefined, 'undefined'],
      [null, 'null'],
      [['A', 'B'], 'an array'],
      [42, 'number'],
    ] as const) {
      await expect(keyboard.paste(value as unknown as string)).rejects.toThrow(
        new RegExp(`requires a string or \\{ text, html\\? \\}, received ${received}$`),
      );
    }
    await expect(keyboard.paste({ text: 'x', extra: 1 } as unknown as string)).rejects.toThrow(
      'page.keyboard.paste received unknown content field: extra',
    );
    expect(calls).toEqual([]);
  });

  test('reports a failed insertion', async () => {
    const { keyboard } = controller({
      fail: (method) =>
        method === 'Input.insertText' ? new Error('keyboard transport failed') : undefined,
    });

    await expect(keyboard.paste('one\ttwo')).rejects.toThrow(/keyboard transport failed/);
  });
});

describe('PageKeyboardController keys', () => {
  test('ControlOrMeta follows the platform and keeps the macOS editing commands', async () => {
    const mac = controller({ platform: 'darwin' });
    await mac.keyboard.press('ControlOrMeta+V');
    const macDown = mac.calls.find(
      (call) =>
        call.method === 'Input.dispatchKeyEvent' &&
        call.params.type === 'rawKeyDown' &&
        call.params.code === 'KeyV',
    );
    expect(macDown?.params.code).toBe('KeyV');
    expect(macDown?.params.modifiers).toBe(4);
    expect(macDown?.params.commands).toEqual(['paste']);

    const windows = controller({ platform: 'win32' });
    await windows.keyboard.press('ControlOrMeta+V');
    const windowsDown = windows.calls.find(
      (call) =>
        call.method === 'Input.dispatchKeyEvent' &&
        call.params.type === 'rawKeyDown' &&
        call.params.code === 'KeyV',
    );
    expect(windowsDown?.params.modifiers).toBe(2);
    expect(windowsDown?.params.commands).toEqual([]);
  });

  test('releases pressed keys in reverse order when a key fails', async () => {
    let failed = false;
    const { calls, keyboard } = controller({
      fail: (method) => {
        if (method !== 'Input.dispatchKeyEvent' || failed) return undefined;
        const keyDowns = calls.filter((call) => call.method === 'Input.dispatchKeyEvent');
        if (keyDowns.length < 2) return undefined;
        failed = true;
        return new Error('key failed');
      },
    });

    await expect(keyboard.press('Shift+A')).rejects.toThrow('key failed');
    expect(
      calls.filter((call) => call.params.type === 'keyUp').map((call) => call.params.key),
    ).toEqual(['A', 'Shift']);
    expect(keyboard.modifierMask()).toBe(0);
  });

  test('splitChord keeps a literal plus key', () => {
    expect(splitChord('Control++')).toEqual(['Control', '+']);
    expect(() => splitChord('')).toThrow(TypeError);
  });
});
