// Entry of the script host page (ADR-0089 rule 3): waits for the run the main process sends,
// installs the ego-compatible bindings and the SDK (ADR-0091), runs the model's script with the
// helpers as parameters, and answers the console output and the error, if any, with `finish`.
// One host runs one script; the main process destroys it afterwards.

import type { BrowserHostApi, BrowserHostResult, BrowserHostRun } from '../shared/browser-host.js';
import { createEgoBindings } from './bindings.js';
import { formatCliLogValue } from './sdk/format.js';
import { disposeEgoSdk, installEgoSdk } from './sdk/index.js';
import { flushSink, observeOutput, type WritableLike } from './sdk/output-sink.js';
import { AsyncFunction, execute, type SyntaxErrorLocator } from './sdk/run.js';

declare global {
  interface Window {
    /** Exposed by the script host's preload; absent in every other page. */
    readonly piarcBrowserHost?: BrowserHostApi;
  }
}

/** How long the page waits for its own error event when locating a syntax error. */
const LOCATE_TIMEOUT_MS = 1_000;

type HostError = NonNullable<BrowserHostResult['error']>;

/** The page's error-event target (`window`). */
type ErrorEventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/**
 * Compiles the failing script again in a task of its own, where the SyntaxError goes uncaught:
 * Chromium reports it to the page's `error` event with its line and column in the compiled
 * source, which the Function constructor's own error does not carry.
 */
export function locateSyntaxErrorInPage(target: ErrorEventTarget): SyntaxErrorLocator {
  return (parameterNames, body) =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (location: { line: number; column: number } | undefined) => {
        if (settled) return;
        settled = true;
        target.removeEventListener('error', onError);
        clearTimeout(timer);
        resolve(location);
      };
      const onError = (event: ErrorEvent) => {
        if (!(event.error instanceof SyntaxError)) return;
        event.preventDefault();
        finish(event.lineno > 0 ? { line: event.lineno, column: event.colno } : undefined);
      };
      target.addEventListener('error', onError);
      const timer = setTimeout(() => {
        finish(undefined);
      }, LOCATE_TIMEOUT_MS);
      setTimeout(() => {
        Reflect.construct(AsyncFunction, [...parameterNames, body]);
      }, 0);
    });
}

/** The error the run answers: the thrown value's name, message and stable code, if any. */
export function describeError(error: unknown): HostError {
  if (!(error instanceof Error)) {
    return { name: 'Error', message: formatCliLogValue(error) };
  }
  const code: unknown = Reflect.get(error, 'error_code') ?? Reflect.get(error, 'code');
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === 'string' && code ? { code } : {}),
  };
}

/** A line printed after this much quiet goes out at once, not with the next microtask. */
const PRINT_QUIET_MS = 100;

/**
 * Sends what the script prints as `print` ops, so a run that never finishes (timeout, crash)
 * still has its output. A line after a quiet period goes out at once: a script that prints and
 * then blocks (an endless loop) never reaches the next microtask. Bursts are batched once per
 * microtask. It is provisional: `finish` carries the authoritative output, which replaces it (a
 * hard stop drops business output there). Answers the function that stops observing.
 */
export function printProvisionalOutput(
  api: BrowserHostApi,
  now: () => number = Date.now,
): () => void {
  let pending: string[] = [];
  let lastSent = Number.NEGATIVE_INFINITY;
  const send = (text: string) => {
    lastSent = now();
    if (text) void api.call({ op: 'print', text }).catch(() => undefined);
  };
  observeOutput((chunk) => {
    if (pending.length === 0 && now() - lastSent >= PRINT_QUIET_MS) {
      send(chunk);
      return;
    }
    if (pending.length === 0) {
      queueMicrotask(() => {
        const text = pending.join('');
        pending = [];
        send(text);
      });
    }
    pending.push(chunk);
  });
  return () => {
    observeOutput(null);
  };
}

export interface RunOptions {
  readonly locateSyntaxError?: SyntaxErrorLocator;
}

/** Runs one script against the bindings built from `api` and answers its result. */
export async function runScript(
  api: BrowserHostApi,
  run: BrowserHostRun,
  options: RunOptions = {},
): Promise<BrowserHostResult> {
  globalThis.ego = createEgoBindings(
    api,
    run.defaultSpace === undefined ? {} : { defaultSpace: run.defaultSpace },
  );
  installEgoSdk(globalThis);
  const chunks: string[] = [];
  const stream: WritableLike = {
    write(chunk: string) {
      chunks.push(chunk);
    },
  };
  const stopPrinting = printProvisionalOutput(api);
  let error: HostError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          Object.assign(
            new Error(`The browser script did not finish within ${String(run.timeoutMs)} ms`),
            { name: 'TimeoutError', code: 'PIARC_LIMIT' },
          ),
        );
      }, run.timeoutMs);
    });
    await Promise.race([
      execute(run.script, stream, {
        ...(options.locateSyntaxError ? { locateSyntaxError: options.locateSyntaxError } : {}),
      }),
      timedOut,
    ]);
  } catch (thrown) {
    // A timed-out script is still running: keep what it printed so far.
    flushSink(stream, true);
    error = describeError(thrown);
  } finally {
    clearTimeout(timer);
    stopPrinting();
    disposeEgoSdk(globalThis);
  }
  return {
    runId: run.runId,
    output: chunks.join(''),
    ...(error ? { error } : {}),
  };
}

/** Wires the host page: the first run is executed; a host never runs a second script. */
export function startHost(api: BrowserHostApi, target: ErrorEventTarget): void {
  let started = false;
  api.onRun((run) => {
    if (started) {
      api.finish({
        runId: run.runId,
        output: '',
        error: { name: 'Error', message: 'This script host has already run a script' },
      });
      return;
    }
    started = true;
    void runScript(api, run, { locateSyntaxError: locateSyntaxErrorInPage(target) }).then(
      (result) => {
        api.finish(result);
      },
    );
  });
}

if (typeof window !== 'undefined' && window.piarcBrowserHost) {
  startHost(window.piarcBrowserHost, window);
}
