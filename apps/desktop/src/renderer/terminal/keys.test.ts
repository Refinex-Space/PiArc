import { describe, expect, it } from 'vitest';

import { keyMessage, keyText, type KeyFields } from './keys.js';

const base: KeyFields = {
  type: 'keydown',
  key: 'a',
  code: 'KeyA',
  repeat: false,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  isComposing: false,
};

describe('keyMessage', () => {
  it('sends printable keys with their text', () => {
    expect(keyMessage(base)).toEqual({
      action: 'press',
      code: 'KeyA',
      text: 'a',
      mods: 0,
      composing: false,
    });
    expect(keyMessage({ ...base, key: 'A', shiftKey: true })?.mods).toBe(1);
  });

  it('sends named keys without text and keeps Ctrl and Alt', () => {
    expect(keyMessage({ ...base, key: 'Enter', code: 'Enter' })?.text).toBe('');
    expect(keyMessage({ ...base, key: 'c', code: 'KeyC', ctrlKey: true })).toMatchObject({
      text: 'c',
      mods: 2,
    });
    expect(keyMessage({ ...base, key: 'å', altKey: true })).toMatchObject({ text: 'å', mods: 4 });
  });

  it('marks repeats and releases', () => {
    expect(keyMessage({ ...base, repeat: true })?.action).toBe('repeat');
    expect(keyMessage({ ...base, type: 'keyup' })).toMatchObject({ action: 'release', text: '' });
  });

  it('leaves Command shortcuts to the app', () => {
    expect(keyMessage({ ...base, key: 'v', code: 'KeyV', metaKey: true })).toBeUndefined();
  });
});

describe('keyText', () => {
  it('keeps one grapheme and drops key names', () => {
    expect(keyText('中')).toBe('中');
    expect(keyText('😀')).toBe('😀');
    expect(keyText('ArrowUp')).toBe('');
    expect(keyText('Dead')).toBe('');
  });
});
