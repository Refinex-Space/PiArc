import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type {
  BrowserHostApi,
  BrowserHostRequest,
  BrowserHostResult,
  BrowserHostRun,
} from '../shared/browser-host.js';
import {
  describeError,
  locateSyntaxErrorInPage,
  printProvisionalOutput,
  runScript,
  startHost,
} from './host.js';
import { invalidateSession } from './sdk/browser-runtime.js';
import type { EgoBindings } from './sdk/ego-bindings.js';
import { bufferOutput, observeOutput, resetSink } from './sdk/output-sink.js';

/** A `window.piarcBrowserHost` double: answers each op from a table and records requests. */
class FakeHostApi implements BrowserHostApi {
  readonly requests: BrowserHostRequest[] = [];
  readonly finished: BrowserHostResult[] = [];
  runListener: ((run: BrowserHostRun) => void) | undefined;
  readonly #answers: Partial<Record<BrowserHostRequest['op'], unknown>>;

  constructor(answers: Partial<Record<BrowserHostRequest['op'], unknown>> = {}) {
    this.#answers = answers;
  }

  call(request: BrowserHostRequest): Promise<unknown> {
    this.requests.push(request);
    return Promise.resolve(this.#answers[request.op] ?? null);
  }

  onCdp(): void {
    // No CDP traffic in these runs.
  }

  onRun(listener: (run: BrowserHostRun) => void): void {
    this.runListener = listener;
  }

  finish(result: BrowserHostResult): void {
    this.finished.push(result);
  }

  /** The text of every provisional `print` op, in order. */
  prints(): string[] {
    return this.requests.flatMap((request) => (request.op === 'print' ? [request.text] : []));
  }
}

function run(script: string, extra: Partial<BrowserHostRun> = {}): BrowserHostRun {
  return { runId: 'run-1', script, timeoutMs: 5_000, ...extra };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** An `error` event as Chromium reports an uncaught exception. */
function errorEvent(error: unknown, lineno: number, colno: number): Event {
  return Object.assign(new Event('error', { cancelable: true }), { error, lineno, colno });
}

let previousEgo: EgoBindings | undefined;

beforeEach(() => {
  previousEgo = globalThis.ego;
});

afterEach(() => {
  globalThis.ego = previousEgo;
  observeOutput(null);
  invalidateSession();
  resetSink();
  vi.useRealTimers();
});

test('runScript answers the output in order with the run id', async () => {
  const api = new FakeHostApi();

  const result = await runScript(
    api,
    run(`
      console.log("one", { value: 1 });
      console.warn("two");
      help("TaskSpace.newPage");
    `),
  );

  expect(result).toEqual({
    runId: 'run-1',
    output:
      'one { value: 1 }\n[warn] two\nTaskSpace.newPage\n\nCreate and durably label a blank Page.\n\nawait task.newPage()\n',
  });
});

test('prints arrive in order, the first at once and later ones per microtask, adding up to the output', async () => {
  const api = new FakeHostApi();

  const result = await runScript(
    api,
    run(`
      console.log("a");
      console.log("b");
      console.log("c");
      await new Promise((resolve) => setTimeout(resolve, 0));
      console.log("d");
    `),
  );

  expect(api.prints()).toEqual(['a\n', 'b\nc\n', 'd\n']);
  expect(api.prints().join('')).toBe(result.output);
});

test('a line after a quiet period is sent before the script goes on (it may never yield)', async () => {
  const api = new FakeHostApi();
  let clock = 1_000;
  const stop = printProvisionalOutput(api, () => clock);
  try {
    bufferOutput('before\n');
    // Sent synchronously: an endless loop after it would never reach a microtask.
    expect(api.prints()).toEqual(['before\n']);
    bufferOutput('burst\n');
    expect(api.prints()).toEqual(['before\n']);
    await Promise.resolve();
    expect(api.prints()).toEqual(['before\n', 'burst\n']);
    clock += 500;
    bufferOutput('later\n');
    expect(api.prints()).toEqual(['before\n', 'burst\n', 'later\n']);
  } finally {
    stop();
    resetSink();
  }
});

test('an uncaught error is answered with its name, message and code after the earlier output', async () => {
  const api = new FakeHostApi();

  const result = await runScript(
    api,
    run(`
      console.log("partial");
      throw Object.assign(new RangeError("boom"), { code: "X_FAILED" });
    `),
  );

  expect(result).toEqual({
    runId: 'run-1',
    output: 'partial\n',
    error: { name: 'RangeError', message: 'boom', code: 'X_FAILED' },
  });
});

test('a swallowed hard stop keeps the earlier prints but finishes with the guidance only', async () => {
  const api = new FakeHostApi({
    listTaskSpaces: {
      error: 'The user took over',
      error_code: 'EGO_TASK_SPACE_USER_IN_CONTROL',
      reason: 'manual_takeover',
    },
  });

  const result = await runScript(
    api,
    run(`
      console.log("before");
      for (const attempt of [1, 2, 3]) {
        try {
          await listTaskSpaces();
        } catch (error) {
          console.log("failed " + attempt + ": " + error.message);
        }
      }
      console.log("after");
    `),
  );

  expect(result.error).toBeUndefined();
  expect(result.output).toMatch(/Control of this task space is with the user/);
  expect(result.output.match(/takeOverTaskSpace\(spaceId\)/g)).toHaveLength(1);
  expect(result.output).not.toMatch(/before|failed|after/);
  // The provisional prints were already sent; finish's output replaces them.
  const printed = api.prints().join('');
  expect(printed).toMatch(/^before\n/);
  expect(printed).toMatch(/after\n$/);
  expect(api.requests.filter((request) => request.op === 'listTaskSpaces')).toHaveLength(3);
});

test('a script that runs past its timeout answers a TimeoutError with the output so far', async () => {
  const api = new FakeHostApi();

  const result = await runScript(
    api,
    run(
      `
        console.log("started");
        await new Promise(() => {});
      `,
      { timeoutMs: 30 },
    ),
  );

  expect(result).toEqual({
    runId: 'run-1',
    output: 'started\n',
    error: {
      name: 'TimeoutError',
      message: 'The browser script did not finish within 30 ms',
      code: 'PIARC_LIMIT',
    },
  });
});

test('a syntax error is answered with the location the injected locator found', async () => {
  const api = new FakeHostApi();
  const locate = vi.fn(() => Promise.resolve({ line: 4, column: 11 }));

  const result = await runScript(api, run('const x = ;'), { locateSyntaxError: locate });

  expect(locate).toHaveBeenCalledTimes(1);
  expect(result.output).toBe('');
  expect(result.error?.name).toBe('SyntaxError');
  expect(result.error?.message).toMatch(/syntax error at line 1, column 11/);
  expect(result.error?.message).toMatch(/1 \| const x = ;/);
});

test('the run selects its default Space in the bindings', async () => {
  const api = new FakeHostApi({ listTabs: { tabs: [] } });

  await runScript(api, run('', { defaultSpace: 5 }));
  await globalThis.ego?.listTabs();

  expect(api.requests).toContainEqual({ op: 'listTabs', space: 5 });
});

test('startHost runs the first script, refuses a second and prints nothing after finishing', async () => {
  const api = new FakeHostApi();
  startHost(api, new EventTarget());
  const runScriptListener = api.runListener;
  if (!runScriptListener) throw new Error('startHost registered no run listener');

  runScriptListener(run('console.log("first");'));
  runScriptListener(run('console.log("second");', { runId: 'run-2' }));
  await vi.waitFor(() => {
    expect(api.finished).toHaveLength(2);
  });

  expect(api.finished).toEqual([
    {
      runId: 'run-2',
      output: '',
      error: { name: 'Error', message: 'This script host has already run a script' },
    },
    { runId: 'run-1', output: 'first\n' },
  ]);
  expect(api.prints()).toEqual(['first\n']);

  // Output observation ends with the run.
  bufferOutput('late\n');
  await flushMicrotasks();
  expect(api.prints()).toEqual(['first\n']);
});

test('describeError answers the name, message and stable code of what was thrown', () => {
  expect(describeError('boom')).toEqual({ name: 'Error', message: 'boom' });
  expect(describeError({ status: 500 })).toEqual({ name: 'Error', message: '{ status: 500 }' });
  expect(describeError(undefined)).toEqual({ name: 'Error', message: 'undefined' });
  expect(describeError(new TypeError('bad'))).toEqual({ name: 'TypeError', message: 'bad' });
  expect(
    describeError(Object.assign(new Error('stop'), { error_code: 'EGO_A', code: 'B' })),
  ).toEqual({ name: 'Error', message: 'stop', code: 'EGO_A' });
  expect(describeError(Object.assign(new Error('limit'), { code: 7 }))).toEqual({
    name: 'Error',
    message: 'limit',
  });
});

test("locateSyntaxErrorInPage reads the line and column of the page's error event", async () => {
  const target = new EventTarget();
  // The body compiles: in Node nothing reports the re-compile, so the test dispatches the
  // event Chromium would dispatch for an uncaught SyntaxError.
  const location = locateSyntaxErrorInPage(target)(['alpha'], '"use strict";\nreturn alpha;');

  const unrelated = errorEvent(new Error('another failure'), 9, 9);
  target.dispatchEvent(unrelated);
  expect(unrelated.defaultPrevented).toBe(false);

  const syntax = errorEvent(new SyntaxError("Unexpected token ';'"), 6, 11);
  target.dispatchEvent(syntax);
  expect(await location).toEqual({ line: 6, column: 11 });
  expect(syntax.defaultPrevented, 'the located error must not reach the console').toBe(true);

  const late = errorEvent(new SyntaxError('later'), 1, 1);
  target.dispatchEvent(late);
  expect(late.defaultPrevented, 'the listener is removed once located').toBe(false);
});

test('locateSyntaxErrorInPage answers no location without a line or after its wait', async () => {
  const target = new EventTarget();
  const withoutLine = locateSyntaxErrorInPage(target)(['alpha'], 'return alpha;');
  target.dispatchEvent(errorEvent(new SyntaxError('no position'), 0, 0));
  expect(await withoutLine).toBeUndefined();

  vi.useFakeTimers();
  const unanswered = locateSyntaxErrorInPage(target)(['alpha'], 'return alpha;');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await unanswered).toBeUndefined();
  const afterWait = errorEvent(new SyntaxError('too late'), 4, 1);
  target.dispatchEvent(afterWait);
  expect(afterWait.defaultPrevented).toBe(false);
});
