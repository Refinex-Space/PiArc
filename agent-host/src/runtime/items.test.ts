import { describe, expect, it } from 'vitest';

import { MAX_ARGUMENT_DEPTH, MAX_ITEM_ARGUMENTS, boundArguments } from './items.js';

/** Arguments whose leaf sits `levels` objects (or arrays) deep. */
function nested(levels: number, array = false): Record<string, unknown> {
  let value: unknown = 'leaf';
  for (let i = 1; i < levels; i += 1) {
    value = array ? [value] : { k: value };
  }
  return { k: value };
}

describe('boundArguments', () => {
  it('keeps arguments nested up to the limit', () => {
    const args = nested(MAX_ARGUMENT_DEPTH);
    expect(boundArguments(args)).toEqual(args);
  });

  // I09: frames stop at 127 levels, so deeper arguments would make Core drop the whole frame.
  it('replaces arguments nested deeper than the limit by a note', () => {
    for (const args of [nested(MAX_ARGUMENT_DEPTH + 1), nested(200, true)]) {
      expect(boundArguments(args)).toEqual({
        piarcOmitted: `arguments nested deeper than ${String(MAX_ARGUMENT_DEPTH)} levels`,
      });
    }
  });

  it('replaces arguments larger than the limit by a note', () => {
    const args = { content: 'x'.repeat(MAX_ITEM_ARGUMENTS) };
    const size = JSON.stringify(args).length;
    expect(boundArguments(args)).toEqual({
      piarcOmitted: `arguments of ${String(size)} characters`,
    });
  });

  it('makes lone surrogates well-formed', () => {
    expect(boundArguments({ text: 'a\uD800b' })).toEqual({ text: 'a�b' });
  });
});
