import { describe, expect, it } from 'vitest';

import {
  COMMANDS,
  chordOfEvent,
  commandForEvent,
  conflictFor,
  displayKey,
  effectiveBindings,
  isAssignable,
  parseKey,
  toAccelerator,
} from './keybindings.js';

const event = (
  code: string,
  mods: Partial<Record<'meta' | 'ctrl' | 'alt' | 'shift', boolean>> = {},
) => ({
  code,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
});

describe('keybindings', () => {
  it('parses and normalizes keys', () => {
    expect(parseKey('shift+mod+n')).toEqual({ modifiers: ['Mod', 'Shift'], key: 'N' });
    expect(parseKey('Mod+/')).toEqual({ modifiers: ['Mod'], key: '/' });
    for (const bad of ['', 'Mod+', 'Mod+Mod+N', 'Hyper+N', 'Mod+NN', 'Mod++']) {
      expect(parseKey(bad), bad).toBeUndefined();
    }
  });

  it('maps Mod to ⌘ on macOS and Ctrl elsewhere', () => {
    const bindings = effectiveBindings({});
    expect(commandForEvent(event('KeyN', { meta: true }), bindings, 'mac')).toBe('session.new');
    expect(commandForEvent(event('KeyN', { ctrl: true }), bindings, 'mac')).toBeUndefined();
    expect(commandForEvent(event('KeyN', { ctrl: true }), bindings, 'other')).toBe('session.new');
    expect(commandForEvent(event('Tab', { ctrl: true }), bindings, 'mac')).toBe('session.next');
    expect(commandForEvent(event('Tab', { ctrl: true }), bindings, 'other')).toBe('session.next');
    // Shift does not change the key: Mod+Shift+/ is not Mod+/.
    expect(
      commandForEvent(event('Slash', { meta: true, shift: true }), bindings, 'mac'),
    ).toBeUndefined();
    expect(chordOfEvent(event('ShiftLeft', { shift: true }), 'mac')).toBeUndefined();
  });

  it('applies overrides, unbinding and finds conflicts per platform', () => {
    const bindings = effectiveBindings({ 'session.new': 'Mod+Shift+N', 'help.shortcuts': '' });
    expect(commandForEvent(event('KeyN', { meta: true }), bindings, 'mac')).toBeUndefined();
    expect(commandForEvent(event('KeyN', { meta: true, shift: true }), bindings, 'mac')).toBe(
      'session.new',
    );
    expect(commandForEvent(event('Slash', { meta: true }), bindings, 'mac')).toBeUndefined();
    expect(conflictFor('Mod+W', 'session.new', bindings, 'mac')).toBe('session.close');
    // Ctrl+W is Mod+W on Windows, a different key on macOS.
    expect(conflictFor('Ctrl+W', 'session.new', bindings, 'mac')).toBeUndefined();
    expect(conflictFor('Ctrl+W', 'session.new', bindings, 'other')).toBe('session.close');
    expect(effectiveBindings({ 'session.new': 'garbage' })['session.new']).toBe('Mod+N');
  });

  it('formats accelerators and labels', () => {
    expect(toAccelerator('Mod+Shift+N')).toBe('CommandOrControl+Shift+N');
    expect(toAccelerator('Ctrl+Tab')).toBe('Control+Tab');
    expect(displayKey('Mod+Shift+N', 'mac')).toBe('⇧⌘N');
    expect(displayKey('Ctrl+Tab', 'mac')).toBe('⌃⇥');
    expect(displayKey('Mod+/', 'other')).toBe('Ctrl+/');
    expect(isAssignable({ modifiers: ['Shift'], key: 'N' })).toBe(false);
    expect(isAssignable({ modifiers: [], key: 'F5' })).toBe(true);
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length);
  });
});
