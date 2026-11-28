import { describe, expect, it } from 'vitest';

import { previewKey, type KeyInput } from './keymap.js';

function key(code: string, key: string, mods: Partial<KeyInput> = {}): KeyInput {
  return {
    type: 'keyDown',
    key,
    code,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...mods,
  };
}

describe('previewKey', () => {
  it('maps Command shortcuts on macOS', () => {
    const mac = (code: string, k: string, mods: Partial<KeyInput> = {}) =>
      previewKey(key(code, k, { meta: true, ...mods }), 'darwin');
    expect(mac('KeyL', 'l')).toBe('address');
    expect(mac('KeyW', 'w')).toBe('closeTab');
    expect(mac('KeyT', 't', { shift: true })).toBe('reopenTab');
    expect(mac('KeyS', 's', { shift: true })).toBe('pick');
    expect(mac('KeyX', 'x', { shift: true })).toBe('annotate');
    expect(mac('KeyI', 'i', { alt: true })).toBe('devtools');
    expect(mac('Digit3', '3')).toBe('tab3');
    expect(mac('Digit9', '9')).toBe('lastTab');
    expect(mac('BracketLeft', '[')).toBe('back');
    expect(mac('Equal', '=')).toBe('zoomIn');
    expect(mac('Minus', '-')).toBe('zoomOut');
    // Control is not Mod on macOS.
    expect(previewKey(key('KeyL', 'l', { control: true }), 'darwin')).toBeUndefined();
  });

  it('maps Control shortcuts and Alt arrows on Windows', () => {
    expect(previewKey(key('KeyW', 'w', { control: true }), 'win32')).toBe('closeTab');
    expect(previewKey(key('ArrowLeft', 'ArrowLeft', { alt: true }), 'win32')).toBe('back');
    expect(previewKey(key('KeyL', 'l', { meta: true }), 'win32')).toBeUndefined();
  });

  it('maps function keys and Control+Tab everywhere', () => {
    expect(previewKey(key('F5', 'F5'), 'darwin')).toBe('reload');
    expect(previewKey(key('F5', 'F5', { shift: true }), 'win32')).toBe('hardReload');
    expect(previewKey(key('F12', 'F12'), 'win32')).toBe('devtools');
    expect(previewKey(key('F6', 'F6'), 'darwin')).toBe('leave');
    expect(previewKey(key('Tab', 'Tab', { control: true }), 'darwin')).toBe('nextTab');
    expect(previewKey(key('Tab', 'Tab', { control: true, shift: true }), 'win32')).toBe(
      'previousTab',
    );
  });

  it('leaves typing, key-up and unknown chords to the page', () => {
    expect(previewKey(key('KeyA', 'a'), 'darwin')).toBeUndefined();
    expect(previewKey({ ...key('KeyL', 'l', { meta: true }), type: 'keyUp' }, 'darwin')).toBe(
      undefined,
    );
    expect(previewKey(key('KeyC', 'c', { meta: true }), 'darwin')).toBeUndefined();
    expect(previewKey(key('KeyV', 'v', { control: true }), 'win32')).toBeUndefined();
  });
});
