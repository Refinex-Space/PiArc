// Ported from ego-browser package/ego-browser/src/ref-map.test.mjs (ego-lite commit 56589ea8, MIT,
// see LICENSE). PiArc: Vitest.

import { expect, test } from 'vitest';

import { parseRef } from './ref-map.js';

test('parseRef accepts action forms but not the full snapshot annotation', () => {
  expect(parseRef('@21')).toBe('21');
  expect(parseRef('ref=21')).toBe('21');
  expect(parseRef('21')).toBe('21');
  expect(parseRef('[ref=21]')).toBeNull();
});
