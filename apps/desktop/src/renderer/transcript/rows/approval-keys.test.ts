import { describe, expect, it } from 'vitest';
import {
  approvalKey,
  canAlwaysAllow,
  canAnswerByKey,
  draftKeeps,
  typedElsewhere,
} from './approval-keys.js';
const key = {
  key: 'Enter',
  altKey: false,
  ctrlKey: false,
  metaKey: true,
  shiftKey: false,
  isComposing: false,
  keyCode: 13,
  repeat: false,
};
const state = {
  firstVisible: true,
  ageMs: 400,
  composerEmpty: true,
  cardFocused: false,
  repeat: false,
};
describe('approval shortcuts', () => {
  it('requires the exact platform modifier, and leaves composition alone', () => {
    expect(approvalKey(key, 'mac')).toBe('allowOnce');
    expect(approvalKey({ ...key, shiftKey: true }, 'mac')).toBe('allowSession');
    expect(approvalKey({ ...key, metaKey: false, ctrlKey: true }, 'other')).toBe('allowOnce');
    for (const change of [
      { isComposing: true },
      { keyCode: 229 },
      { ctrlKey: true },
      { altKey: true },
    ]) {
      expect(approvalKey({ ...key, ...change }, 'mac')).toBeUndefined();
    }
    expect(approvalKey({ ...key, key: 'Escape', metaKey: false }, 'mac')).toBe('deny');
  });
  it('arms the first visible card at 400 ms and ignores repeats', () => {
    for (const change of [{ ageMs: 399 }, { firstVisible: false }, { repeat: true }]) {
      expect(canAnswerByKey('allowSession', { ...state, ...change })).toBe(false);
    }
    expect(canAnswerByKey('allowOnce', state)).toBe(true);
    expect(canAnswerByKey('deny', { ...state, composerEmpty: false })).toBe(false);
    expect(canAnswerByKey('deny', { ...state, composerEmpty: false, cardFocused: true })).toBe(
      true,
    );
  });
  it('leaves send and queue keys to a draft in the composer (ADR-0103)', () => {
    // Mod+Enter in a composer with a draft queues the draft; it does not approve a card.
    expect(draftKeeps('allowOnce', { inComposer: true, composerEmpty: false })).toBe(true);
    expect(draftKeeps('allowSession', { inComposer: true, composerEmpty: false })).toBe(true);
    // An empty composer, or a key typed elsewhere, still answers the card; Esc stays the card's.
    expect(draftKeeps('allowOnce', { inComposer: true, composerEmpty: true })).toBe(false);
    expect(draftKeeps('allowOnce', { inComposer: false, composerEmpty: false })).toBe(false);
    expect(draftKeeps('deny', { inComposer: true, composerEmpty: false })).toBe(false);
  });
  it('leaves keys typed into another text field to that field', () => {
    expect(typedElsewhere({ editable: true, inCard: false, inComposer: false })).toBe(true);
    expect(typedElsewhere({ editable: true, inCard: true, inComposer: false })).toBe(false);
    expect(typedElsewhere({ editable: true, inCard: false, inComposer: true })).toBe(false);
    expect(typedElsewhere({ editable: false, inCard: false, inComposer: false })).toBe(false);
  });
  it('gates persistent rules on protected paths and collapsed parameters', () => {
    expect(canAlwaysAllow(true, false, true)).toBe(false);
    expect(canAlwaysAllow(false, true, false)).toBe(false);
    expect(canAlwaysAllow(false, true, true)).toBe(true);
    expect(canAlwaysAllow(false, false, false)).toBe(true);
  });
});
