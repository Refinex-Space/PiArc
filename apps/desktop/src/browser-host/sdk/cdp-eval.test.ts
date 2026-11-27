// Ported from ego-browser package/ego-browser/src/cdp-eval.test.mjs (ego-lite commit 56589ea8, MIT,
// see LICENSE). PiArc: Vitest. The v1 `cdp()` helper is dropped, so the sessionId cases call the
// guard it used (`assertNoSessionIdInParams`, also used by page.cdp and task.cdp) directly; the
// `hasReturnStatement` and `js()` cases are dropped with those helpers. `runtimeValue` cases are new.

import { describe, expect, test } from 'vitest';

import {
  assertNoSessionIdInParams,
  decodeUnserializableJsValue,
  runtimeValue,
} from './cdp-eval.js';

const REMEDY = 'Pass it as the third argument: cdp(method, params, sessionId).';

function guard(method: string, params: unknown) {
  assertNoSessionIdInParams('cdp', method, params, REMEDY);
}

describe('assertNoSessionIdInParams', () => {
  test('rejects a sessionId inside params instead of running in the page session', () => {
    let caught: unknown;
    try {
      guard('Runtime.evaluate', { expression: '1', sessionId: 's1' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as TypeError).message).toMatch(/Runtime\.evaluate/);
    expect((caught as TypeError).message).toMatch(/cdp\(method, params, sessionId\)/);
  });

  test('accepts params without a sessionId', () => {
    expect(() => {
      guard('Runtime.evaluate', { expression: '1' });
    }).not.toThrow();
    expect(() => {
      guard('Runtime.enable', undefined);
    }).not.toThrow();
  });

  test('keeps Target commands whose protocol params define sessionId', () => {
    expect(() => {
      guard('Target.detachFromTarget', { sessionId: 's1' });
    }).not.toThrow();
    expect(() => {
      guard('Target.sendMessageToTarget', { sessionId: 's1', message: '{}' });
    }).not.toThrow();
  });

  test('rejects a sessionId on Target commands that do not define it', () => {
    for (const [method, params] of [
      ['Target.getTargets', {}],
      ['Target.attachToTarget', { targetId: 't1', flatten: true }],
      ['Target.getTargetInfo', { targetId: 't1' }],
    ] as const) {
      expect(() => {
        guard(method, { ...params, sessionId: 's1' });
      }).toThrow(TypeError);
      expect(() => {
        guard(method, { ...params, sessionId: 's1' });
      }).toThrow(method);
    }
  });
});

describe('runtimeValue', () => {
  test('returns the by-value result', () => {
    expect(runtimeValue({ result: { type: 'object', value: [2, 4] } }, '[2, 4]')).toEqual([2, 4]);
    expect(runtimeValue({ result: { type: 'undefined' } }, 'undefined')).toBeNull();
  });

  test('decodes unserializable values', () => {
    expect(runtimeValue({ result: { type: 'number', unserializableValue: 'NaN' } }, 'NaN')).toBe(
      Number.NaN,
    );
    expect(Object.is(decodeUnserializableJsValue('-0'), -0)).toBe(true);
    expect(decodeUnserializableJsValue('Infinity')).toBe(Number.POSITIVE_INFINITY);
    expect(decodeUnserializableJsValue('-Infinity')).toBe(Number.NEGATIVE_INFINITY);
    expect(decodeUnserializableJsValue('12n')).toBe(12n);
  });

  test('reports exceptions with their location and the expression', () => {
    expect(() =>
      runtimeValue(
        {
          result: { type: 'object', subtype: 'error' },
          exceptionDetails: {
            text: 'Uncaught',
            lineNumber: 0,
            columnNumber: 6,
            exception: { type: 'object', description: 'ReferenceError: nope is not defined' },
          },
        },
        'nope()',
      ),
    ).toThrow(
      'JavaScript evaluation failed at line 0, column 6: ReferenceError: nope is not defined; expression: nope()',
    );
    expect(() =>
      runtimeValue(
        { exceptionDetails: { text: 'Uncaught', exception: { type: 'number', value: 7 } } },
        'throw 7',
      ),
    ).toThrow('JavaScript evaluation failed: 7; expression: throw 7');
    expect(() => runtimeValue({ exceptionDetails: { text: 'Uncaught' } }, 'x')).toThrow(
      'JavaScript evaluation failed: Uncaught; expression: x',
    );
  });
});
