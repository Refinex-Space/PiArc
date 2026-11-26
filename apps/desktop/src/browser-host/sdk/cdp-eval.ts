// Ported from ego-browser package/ego-browser/src/cdp-eval.ts (ego-lite commit 56589ea8, MIT, see
// LICENSE). PiArc: only the parts the v2 Page API uses (assertNoSessionIdInParams, runtimeValue,
// decodeUnserializableJsValue); the v1 cdp() and js() helpers and the acorn-based
// hasReturnStatement are dropped.

import type { Protocol } from 'devtools-protocol';

import type { Wire } from './cdp-types.js';

// The only CDP commands whose protocol parameters include sessionId.
const COMMANDS_WITH_SESSION_ID_PARAM = new Set([
  'Target.detachFromTarget',
  'Target.sendMessageToTarget',
]);

/**
 * A session is selected by the CDP message envelope, not by params. Chromium
 * ignores an unknown params.sessionId, so the command would run in the default
 * session and return a plausible result from the wrong target.
 */
export function assertNoSessionIdInParams(
  apiName: string,
  method: string,
  params: unknown,
  remedy: string,
): void {
  if (
    typeof params !== 'object' ||
    params === null ||
    (params as { sessionId?: unknown }).sessionId === undefined ||
    COMMANDS_WITH_SESSION_ID_PARAM.has(method)
  ) {
    return;
  }
  throw new TypeError(
    `${apiName}: ${method} does not take sessionId in params; it would be ignored and the command would run in the wrong session. ${remedy}`,
  );
}

/** The result of `Runtime.evaluate` or `Runtime.callFunctionOn` as received. */
export interface RuntimeEvaluation {
  readonly result?: Wire<Protocol.Runtime.RemoteObject>;
  readonly exceptionDetails?: Wire<Protocol.Runtime.ExceptionDetails>;
}

export function runtimeValue(response: RuntimeEvaluation, expression: string): unknown {
  const result = response.result ?? {};
  const details = response.exceptionDetails;
  if (details || result.subtype === 'error') {
    const desc = jsExceptionDescription(result, details);
    const loc =
      details?.lineNumber !== undefined && details.columnNumber !== undefined
        ? ` at line ${String(details.lineNumber)}, column ${String(details.columnNumber)}`
        : '';
    throw new Error(
      `JavaScript evaluation failed${loc}: ${desc}; expression: ${jsSnippet(expression)}`,
    );
  }
  if (Object.hasOwn(result, 'value')) {
    return result.value;
  }
  if (Object.hasOwn(result, 'unserializableValue') && result.unserializableValue !== undefined) {
    return decodeUnserializableJsValue(result.unserializableValue);
  }
  return null;
}

function jsExceptionDescription(
  result: Wire<Protocol.Runtime.RemoteObject>,
  details: Wire<Protocol.Runtime.ExceptionDetails> | undefined,
): string {
  let desc = result.description;
  const exception = details?.exception;
  if (!desc && exception && typeof exception === 'object') {
    desc = exception.description;
    if (desc === undefined && Object.hasOwn(exception, 'value')) {
      desc = valueText(exception.value);
    }
    desc ??= exception.className;
  }
  if (desc) return desc;
  const text = details?.text;
  return text !== undefined && text !== '' ? text : 'JavaScript evaluation failed';
}

/** `String(value)` for a value from the wire, without object default stringification. */
function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }
  if (typeof value === 'symbol') return value.toString();
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export function decodeUnserializableJsValue(value: string): number | bigint | string {
  if (value === 'NaN') {
    return Number.NaN;
  }
  if (value === 'Infinity') {
    return Number.POSITIVE_INFINITY;
  }
  if (value === '-Infinity') {
    return Number.NEGATIVE_INFINITY;
  }
  if (value === '-0') {
    return -0;
  }
  if (value.endsWith('n')) {
    return BigInt(value.slice(0, -1));
  }
  return value;
}

function jsSnippet(expression: string, limit = 160): string {
  const snippet = expression.trim().replace(/\n/g, '\\n');
  return snippet.length > limit ? `${snippet.slice(0, limit - 3)}...` : snippet;
}
