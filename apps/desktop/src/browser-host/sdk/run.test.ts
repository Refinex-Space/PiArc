// Ported from ego-browser package/ego-browser/src/run-output-sink.test.mjs (ego-lite commit
// 56589ea8, MIT, see LICENSE). PiArc: Vitest; drives execute() instead of runMain, so the CLI
// tests (argv, stdin, the child-process uncaught-error test) are dropped; there is no cliLog
// helper, so console.log takes its place; the 1.3 skill-mismatch test is dropped with the guard;
// the snapshot hard stop goes through observe's snapshotRaw injected as a helper (snapshotText
// was v1); the page-global hint names PiArc's script host; syntax errors are located by an
// injected locator.

import { afterEach, expect, test } from 'vitest';

import { FakeBindings, installBindings } from '../testing.js';
import { invalidateSession } from './browser-runtime.js';
import { snapshotRaw } from './driver/observe.js';
import type { EgoBindings } from './ego-bindings.js';
import { resetSink } from './output-sink.js';
import { AsyncFunction, execute, type ExecuteOptions, type SourceLocation } from './run.js';

afterEach(() => {
  invalidateSession();
  resetSink();
});

// Bindings whose only use reports a hard stop, the same shape the real bindings return when
// the user holds (or has not handed over) the task space. The `listTaskSpaces` helper lifts it
// through invokeEgo -> buildEgoError, which is where the sink is told a hard stop occurred.
function hardStopEgo(
  error_code: string,
  error = 'native wording that should never reach the agent',
): FakeBindings {
  return new FakeBindings({
    listTaskSpaces: () => Promise.resolve({ error, error_code }),
  });
}

// Bindings whose `snapshot` REJECTS with a hard-stop code — the shape the real bindings use
// under user control. driver/observe.ts calls browserEgo().snapshot() directly, so the
// rejection only reaches the sink if snapshot() routes it through buildEgoError.
function snapshotHardStopEgo(error_code: string): FakeBindings {
  return new FakeBindings({
    snapshot: () =>
      Promise.reject(
        Object.assign(new Error('native wording that should never reach the agent'), {
          error_code,
        }),
      ),
  });
}

function callCount(ego: FakeBindings, name: string): number {
  return ego.calls.filter(([called]) => called === name).length;
}

function captureStream(): { write(chunk: string): void; text(): string } {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(chunk);
    },
    text() {
      return chunks.join('');
    },
  };
}

async function runScript(
  code: string,
  ego?: EgoBindings,
  options: ExecuteOptions = {},
): Promise<{ error: unknown; stdout: string }> {
  const restore = installBindings(ego);
  const stdout = captureStream();
  let error: unknown = null;
  try {
    await execute(code, stdout, options);
  } catch (thrown) {
    error = thrown;
  } finally {
    restore();
  }
  return { error, stdout: stdout.text() };
}

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) throw new Error(`expected an Error, got ${String(error)}`);
  return error.message;
}

test('a clean run flushes buffered console output in order', async () => {
  const result = await runScript(`console.log("one"); console.log("two");`);
  expect(result.error).toBeNull();
  expect(result.stdout).toBe('one\ntwo\n');
});

test('help() prints its text without an explicit log', async () => {
  const result = await runScript(`help("TaskSpace.newPage");`);

  expect(result.error).toBeNull();
  expect(result.stdout).toBe(
    'TaskSpace.newPage\n\nCreate and durably label a blank Page.\n\nawait task.newPage()\n',
  );
});

test('round console methods share the buffered output channel', async () => {
  const result = await runScript(`
    console.log("plain", { value: 1 });
    console.info("info");
    console.warn("careful");
    console.error("broken");
  `);

  expect(result.error).toBeNull();
  expect(result.stdout).toBe('plain { value: 1 }\ninfo\n[warn] careful\n[error] broken\n');
});

test('helpers reach the script as parameters, not as globals', async () => {
  const result = await runScript(
    `console.log(typeof taskSpace, typeof console.log, typeof globalThis.taskSpace);`,
  );

  expect(result.error).toBeNull();
  expect(result.stdout).toBe('function function undefined\n');
});

test('a hard stop discards console output together with other output', async () => {
  const ego = hardStopEgo('EGO_TASK_SPACE_USER_IN_CONTROL');
  const result = await runScript(
    `
      console.log("before");
      try { await listTaskSpaces(); } catch {}
      console.warn("after");
    `,
    ego,
  );

  expect(result.stdout).toMatch(/Control of this task space is with the user/);
  expect(result.stdout).not.toMatch(/before|after/);
});

test('a swallowed user-control hard stop discards all output and prints the guidance once', async () => {
  const ego = hardStopEgo('EGO_TASK_SPACE_USER_IN_CONTROL');
  const result = await runScript(
    `
      for (const site of ["a", "b", "c"]) {
        console.log("visiting " + site);
        try {
          await listTaskSpaces();
          console.log("ok " + site);
        } catch (e) {
          console.log("failed " + site + ": " + e.message);
        }
      }
      console.log("summary: done");
    `,
    ego,
  );

  expect(result.error).toBeNull();
  // Only the owned guidance survives — none of the script's own logging.
  expect(result.stdout).toMatch(/Control of this task space is with the user/);
  expect(result.stdout).toMatch(/takeOverTaskSpace\(spaceId\)/);
  expect(result.stdout).not.toMatch(/visiting|failed|ok |summary/);
  // Printed exactly once, even though every loop iteration re-reported the hard stop.
  expect(result.stdout.match(/takeOverTaskSpace\(spaceId\)/g)).toHaveLength(1);
  expect(
    callCount(ego, 'listTaskSpaces'),
    'every iteration should have hit the hard stop',
  ).toBeGreaterThanOrEqual(3);
});

test('a permission hard stop discards business output and keeps its specific guidance', async () => {
  const ego = hardStopEgo('EGO_TASK_SPACE_USER_IN_CONTROL', 'camera');
  const result = await runScript(
    `
      console.log("before permission");
      try { await listTaskSpaces(); } catch {}
      console.log("after permission");
    `,
    ego,
  );

  expect(result.error).toBeNull();
  expect(result.stdout).toMatch(/camera access/);
  expect(result.stdout).toMatch(/takeOverTaskSpace\(spaceId\)/);
  expect(result.stdout).not.toMatch(/before permission|after permission/);
  expect(result.stdout.match(/camera access/g)).toHaveLength(1);
});

test('an inactive / unassigned task space is also a hard stop', async () => {
  const ego = hardStopEgo('EGO_TASK_SPACE_INACTIVE');
  const result = await runScript(
    `
      try {
        await listTaskSpaces();
      } catch (e) {
        console.log("swallowed: " + e.message);
      }
      console.log("more business output");
    `,
    ego,
  );

  expect(result.error).toBeNull();
  expect(result.stdout).toMatch(/no longer assigned to the agent/);
  expect(result.stdout).toMatch(/claimTaskSpace\(spaceId\)/);
  expect(result.stdout).not.toMatch(/swallowed|business/);
});

test('a swallowed snapshot hard stop (rejected, not resolved) also collapses to one message', async () => {
  // snapshot rejects directly instead of resolving with { error }, so the collapse only
  // works if snapshot() rebuilds it via buildEgoError.
  const ego = snapshotHardStopEgo('EGO_TASK_SPACE_USER_IN_CONTROL');
  const result = await runScript(
    `
      for (const site of ["a", "b", "c"]) {
        console.log("visiting " + site);
        try {
          await snapshot();
          console.log("ok " + site);
        } catch (e) {
          console.log("failed " + site + ": " + e.message);
        }
      }
      console.log("summary: done");
    `,
    ego,
    { context: { snapshot: () => snapshotRaw() } },
  );

  expect(result.error).toBeNull();
  // The owned guidance survives once; the native wording and business logs are dropped.
  expect(result.stdout).toMatch(/Control of this task space is with the user/);
  expect(result.stdout).toMatch(/takeOverTaskSpace\(spaceId\)/);
  expect(result.stdout).not.toMatch(/native wording/);
  expect(result.stdout).not.toMatch(/visiting|failed|ok |summary/);
  expect(result.stdout.match(/takeOverTaskSpace\(spaceId\)/g)).toHaveLength(1);
  expect(
    callCount(ego, 'snapshot'),
    'every iteration should have hit the snapshot hard stop',
  ).toBeGreaterThanOrEqual(3);
});

test('an uncaught hard stop discards output without double-printing the message', async () => {
  const ego = hardStopEgo('EGO_TASK_SPACE_USER_IN_CONTROL');
  const result = await runScript(
    `
      console.log("before");
      await listTaskSpaces();
      console.log("after");
    `,
    ego,
  );

  // The thrown Error already surfaces the message (the host reports it), so the sink
  // discards the buffer and stays silent rather than printing the guidance a second time.
  expect(messageOf(result.error)).toMatch(/Control of this task space is with the user/);
  expect(result.stdout).toBe('');
});

test('an ordinary uncaught error still flushes the output logged before it', async () => {
  const result = await runScript(`
    console.log("partial result");
    throw new Error("boom");
  `);

  expect(messageOf(result.error)).toBe('boom');
  expect(result.stdout).toBe('partial result\n');
});

for (const [globalName, expression] of [
  ['document', 'document.body'],
  ['window', 'window.scrollY'],
  ['location', 'location.href'],
  ['scrollY', 'scrollY'],
] as const) {
  test(`a top-level ${globalName} use explains the script host and Page execution boundary`, async () => {
    const result = await runScript(`console.log(${expression});`);

    expect(result.error).toBeInstanceOf(ReferenceError);
    const message = messageOf(result.error);
    expect(message).toMatch(new RegExp(`${globalName} is not defined`, 'i'));
    expect(message).toMatch(/runs in PiArc's script host, not in the Page/i);
    expect(message).toMatch(/page\.evaluate\(\)/i);
    expect(message.match(/page\.evaluate\(\)/g)).toHaveLength(1);
  });
}

test('typeof and truthiness checks on Page globals do not throw', async () => {
  const result = await runScript(`
    console.log(typeof document, typeof window, typeof location, Boolean(document));
  `);

  expect(result.error).toBeNull();
  expect(result.stdout).toBe('object object object true\n');
});

const SYNTAX_ERROR_SCRIPT = `
const task = await taskSpace(556);
const rows = (await task.pages()).map(page => ({ title: await page.title() }));
console.log(rows);
`;

test('a syntax error points to the invalid user-script line', async () => {
  const invalidLine =
    'const rows = (await task.pages()).map(page => ({ title: await page.title() }));';
  // Chromium's 1-based column of the token V8 rejects: the second `await`.
  const column = invalidLine.indexOf('await page') + 1;
  const located: { names: readonly string[]; body: string }[] = [];
  const locateSyntaxError = (
    names: readonly string[],
    body: string,
  ): Promise<SourceLocation | undefined> => {
    located.push({ names, body });
    // The script's line 3 is line 6 of the compiled source (see the layout test below).
    return Promise.resolve({ line: 6, column });
  };

  const result = await runScript(SYNTAX_ERROR_SCRIPT, undefined, { locateSyntaxError });

  expect(result.error).toBeInstanceOf(SyntaxError);
  const message = messageOf(result.error);
  expect(message).toMatch(new RegExp(`syntax error at line 3, column ${String(column)}`, 'i'));
  expect(message).toMatch(/3 \| const rows =/);
  const [, sourceLine, caretLine] = message.split('\n');
  expect(sourceLine).toBe(`3 | ${invalidLine}`);
  expect(caretLine).toBe(`${' '.repeat('3 | '.length + column - 1)}^`);
  // The caret sits under the rejected token.
  expect(sourceLine?.slice('3 | '.length + column - 1)).toMatch(/^await page/);
  expect(result.stdout).toBe('');
  expect(located).toHaveLength(1);
  expect(located[0]?.body).toBe(`"use strict";\n${SYNTAX_ERROR_SCRIPT}`);
  expect(located[0]?.names).toContain('taskSpace');
  expect(located[0]?.names).toContain('console');
});

test("the compiled source puts the script's first line on line 4", () => {
  // The locator reports lines of the source the Function constructor compiled; the port
  // maps line 4 to the script's line 1. V8 lays the source out the same way in Node.
  const fn = new AsyncFunction('alpha', 'beta', '"use strict";\nreturn alpha;');
  const lines = Function.prototype.toString.call(fn).split('\n');
  expect(lines.indexOf('"use strict";') + 1).toBe(3);
  expect(lines.indexOf('return alpha;') + 1).toBe(4);
});

test('a syntax error without a location keeps the original message', async () => {
  const withoutLocator = await runScript(SYNTAX_ERROR_SCRIPT);
  const unlocated = await runScript(SYNTAX_ERROR_SCRIPT, undefined, {
    locateSyntaxError: () => Promise.resolve(undefined),
  });

  for (const result of [withoutLocator, unlocated]) {
    expect(result.error).toBeInstanceOf(SyntaxError);
    expect(messageOf(result.error)).not.toMatch(/syntax error at line/i);
    expect(result.stdout).toBe('');
  }
});

test('a location before the script falls back to the original message', async () => {
  const result = await runScript('const = 1;', undefined, {
    locateSyntaxError: () => Promise.resolve({ line: 3, column: 1 }),
  });

  expect(result.error).toBeInstanceOf(SyntaxError);
  expect(messageOf(result.error)).not.toMatch(/syntax error at line/i);
});
