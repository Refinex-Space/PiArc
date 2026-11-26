// Ported from ego-browser package/ego-browser/src/format.test.mjs (ego-lite commit 56589ea8, MIT,
// see LICENSE). PiArc: Vitest; the local formatter replaces node:util `inspect`, so the shapes it
// prints are asserted directly.

import { expect, test } from 'vitest';

import { formatCliLogValue } from './format.js';

test('formatCliLogValue preserves useful Error details', () => {
  const output = formatCliLogValue(new Error('page action failed'));

  expect(output).toMatch(/Error: page action failed/);
  expect(output).toMatch(/format\.test\.ts/);
});

test('formatCliLogValue handles circular objects without throwing', () => {
  const value: Record<string, unknown> = { name: 'root' };
  value.self = value;

  expect(formatCliLogValue(value)).toMatch(/Circular/);
});

test('formatCliLogValue shows Map, Set, and function values', () => {
  expect(formatCliLogValue(new Map([['status', 200]]))).toMatch(/Map\(1\).*status.*200/);
  expect(formatCliLogValue(new Set(['ready']))).toMatch(/Set\(1\).*ready/);
  expect(
    formatCliLogValue(function runTask() {
      return 'done';
    }),
  ).toMatch(/runTask/);
});

test('formatCliLogValue prints values on one line the way util.inspect does', () => {
  expect(formatCliLogValue('plain')).toBe('plain');
  expect(formatCliLogValue({ a: 1, 'b-c': 'x', d: [1, 'two'], e: undefined, f: null })).toBe(
    "{ a: 1, 'b-c': 'x', d: [ 1, 'two' ], e: undefined, f: null }",
  );
  expect(formatCliLogValue([])).toBe('[]');
  expect(formatCliLogValue({})).toBe('{}');
  expect(formatCliLogValue(-0)).toBe('-0');
  expect(formatCliLogValue(10n)).toBe('10n');
  expect(formatCliLogValue(Symbol('s'))).toBe('Symbol(s)');
  expect(formatCliLogValue(() => 1)).toBe('[Function (anonymous)]');
  expect(
    formatCliLogValue(
      class Box {
        size = 1;
      },
    ),
  ).toBe('[class Box]');
  expect(formatCliLogValue(/a+/g)).toBe('/a+/g');
  expect(formatCliLogValue(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
  expect(formatCliLogValue(Object.create(null) as object)).toBe('[Object: null prototype] {}');
  class Point {
    x = 1;
  }
  expect(formatCliLogValue(new Point())).toBe('Point { x: 1 }');
  expect(formatCliLogValue("it's")).toBe("it's");
  expect(formatCliLogValue(["it's"])).toBe('[ "it\'s" ]');
});

test('formatCliLogValue stops at depth six', () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } };
  expect(formatCliLogValue(deep)).toBe('{ a: { b: { c: { d: { e: { f: { g: [Object] } } } } } } }');
});
