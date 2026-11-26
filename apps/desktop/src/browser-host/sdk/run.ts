// Ported from ego-browser package/ego-browser/src/run.ts (ego-lite commit 56589ea8, MIT, see
// LICENSE). PiArc: only the executor: execute() compiles the script with an AsyncFunction taking
// the helpers as parameters and writes the round output to a stream; the CLI (runMain, argv,
// stdin, HELP, USAGE) and agent_helpers.js are not ported; without acorn, the syntax-error
// location comes from an injected locator (the host page's error event, see ../host.ts).

import * as helpers from './helpers.js';
import {
  bufferOutput,
  createRoundConsole,
  flushSink,
  resetSink,
  type WritableLike,
} from './output-sink.js';
import { addPageContextHint, pageContextShadows } from './page-context-guard.js';

/** A 1-based position in the source the Function constructor compiled. */
export interface SourceLocation {
  readonly line: number;
  readonly column: number;
}

/**
 * Finds where a script failed to compile. V8 omits the position from the SyntaxError a
 * Function constructor throws; Chromium reports it when the same compile error goes uncaught.
 */
export type SyntaxErrorLocator = (
  parameterNames: readonly string[],
  body: string,
) => Promise<SourceLocation | undefined>;

export interface ExecuteOptions {
  readonly locateSyntaxError?: SyntaxErrorLocator;
  /** Helpers added to (or replacing) the standard context, for tests. */
  readonly context?: Record<string, unknown>;
}

type ScriptFunction = (...args: unknown[]) => Promise<unknown>;
type ScriptFunctionConstructor = new (...source: string[]) => ScriptFunction;

/** The constructor of async functions; compiling with it keeps top-level await valid. */
export const AsyncFunction = (async () => {
  await Promise.resolve();
}).constructor as ScriptFunctionConstructor;

/**
 * The Function constructor compiles `(async function anonymous(<params>\n) {\n<body>\n})`, and
 * the body starts with the "use strict" line, so the script's first line is line 4.
 */
const SCRIPT_FIRST_LINE = 4;

export async function execute(
  code: string,
  stdout: WritableLike,
  options: ExecuteOptions = {},
): Promise<void> {
  resetSink();
  const context = executionContext(options.context);
  const names = Object.keys(context);
  const values = Object.values(context);
  const body = `"use strict";\n${code}`;
  let fn: ScriptFunction;
  try {
    fn = new AsyncFunction(...names, body);
  } catch (error) {
    flushSink(stdout, true);
    const location =
      error instanceof SyntaxError ? await options.locateSyntaxError?.(names, body) : undefined;
    throw userScriptSyntaxError(code, error, location);
  }
  try {
    await fn(...values);
  } catch (error) {
    // The thrown Error surfaces the hard-stop message on its own, so flush as a thrown
    // completion (drop the buffer, stay silent) and let it propagate.
    flushSink(stdout, true);
    throw addPageContextHint(error);
  }
  flushSink(stdout, false);
}

export function userScriptSyntaxError(
  code: string,
  original: unknown,
  location: SourceLocation | undefined,
): SyntaxError {
  const originalMessage = original instanceof Error ? original.message : String(original);
  if (location && location.line >= SCRIPT_FIRST_LINE && location.column >= 1) {
    const userLineNumber = location.line - SCRIPT_FIRST_LINE + 1;
    const sourceLine = code.split(/\r?\n/)[userLineNumber - 1] ?? '';
    const columnNumber = location.column;
    const error = new SyntaxError(
      `Browser script syntax error at line ${String(userLineNumber)}, column ${String(columnNumber)}: ${originalMessage}\n` +
        `${String(userLineNumber)} | ${sourceLine}\n` +
        `${' '.repeat(String(userLineNumber).length + 3 + columnNumber - 1)}^`,
      { cause: original },
    );
    return error;
  }
  return original instanceof SyntaxError ? original : new SyntaxError(originalMessage);
}

export function executionContext(extra: Record<string, unknown> = {}): Record<string, unknown> {
  // Single source of truth for the agent-facing surface. help() prints into the
  // round output like console.log does.
  return {
    ...pageContextShadows(),
    ...helpers.helperContext({
      printHelp: (text) => {
        bufferOutput(`${text}\n`);
      },
    }),
    // A lexical parameter shadows the host page's console without mutating it.
    console: createRoundConsole(),
    ...extra,
  };
}
