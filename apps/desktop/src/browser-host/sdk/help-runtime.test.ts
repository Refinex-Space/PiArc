// Ported from ego-browser package/ego-browser/src/help-runtime.test.mjs (ego-lite commit 56589ea8,
// MIT, see LICENSE). PiArc: Vitest; there is no legacy surface, so a v1 helper name is unknown.

import { expect, test } from 'vitest';

import { formatHelp, help, type HelperDoc } from './help-runtime.js';

function single(result: ReturnType<typeof help>): HelperDoc {
  if (typeof result === 'string' || Array.isArray(result)) {
    throw new Error(`expected one help entry, got ${JSON.stringify(result)}`);
  }
  return result;
}

test('help resolves public aliases from the API schema', () => {
  const pageClick = single(help('page.click'));

  expect(pageClick.name).toBe('Page.click');
  expect(pageClick.signature).toMatch(/await page\.click/);
  expect(pageClick.description).toMatch(/timeout/);
  expect(formatHelp(pageClick)).toMatch(/Page\.click[\s\S]*await page\.click/);
});

test('help keeps legacy and unknown names out of the public surface', () => {
  expect(help('oldHelper')).toBe('Unknown helper: oldHelper');
  expect(help('missingHelper')).toBe('Unknown helper: missingHelper');
});

test('help without names lists every public entry', () => {
  const docs = help();
  expect(Array.isArray(docs)).toBe(true);
  expect(Array.isArray(docs) && docs.some((doc) => doc.name === 'requestAccess')).toBe(true);
});
