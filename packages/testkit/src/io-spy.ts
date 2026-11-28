// Records what a Node process does with `fs` and `child_process` (T07-A02): loaded before the
// Agent Host with `NODE_OPTIONS=--import=<file URL of this file>` (Node strips the types).
//
// Every function of `fs`, `fs/promises` and `child_process` is wrapped; `syncBuiltinESMExports`
// makes ES module imports of them (the bundle's `import { readFile } from "node:fs/promises"`)
// see the wrappers too. An `fs` call is recorded when one of its first two arguments is a path
// inside a directory of `PIARC_IO_SPY_ROOTS` (separated by the platform's path delimiter);
// every `child_process` call is recorded. At exit the records go to `PIARC_IO_SPY_REPORT` as
// JSON: `[{ module, fn, path?, at, stack }]`.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface IoRecord {
  module: string;
  fn: string;
  path?: string;
  /** Milliseconds since the Unix epoch, so a test can tell setup from the scenario. */
  at: number;
  stack: string;
}

const roots = (process.env.PIARC_IO_SPY_ROOTS ?? '')
  .split(path.delimiter)
  .filter((root) => root.length > 0)
  .map((root) => path.resolve(root));
const report = process.env.PIARC_IO_SPY_REPORT;
const writeReport = fs.writeFileSync.bind(fs);
const records: IoRecord[] = [];

function asPath(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  if (value instanceof URL && value.protocol === 'file:') {
    return fileURLToPath(value);
  }
  return undefined;
}

function insideRoots(args: readonly unknown[]): string | undefined {
  for (const arg of args.slice(0, 2)) {
    const candidate = asPath(arg);
    if (candidate === undefined) {
      continue;
    }
    const absolute = path.resolve(candidate);
    for (const root of roots) {
      const relative = path.relative(root, absolute);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        return absolute;
      }
    }
  }
  return undefined;
}

function stack(): string {
  return (new Error().stack ?? '').split('\n').slice(3, 9).join('\n');
}

/** Wraps every function property of `target` (and functions hanging off them, like
 * `realpath.native`). */
function wrapAll(target: object, module: string, recordAll: boolean): void {
  for (const name of Object.keys(target)) {
    const original: unknown = Reflect.get(target, name);
    // Classes (`Stats`, `ReadStream`, ...) are left alone.
    if (typeof original !== 'function' || /^[A-Z]/.test(name)) {
      continue;
    }
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      const hit = recordAll ? asPath(args[0]) : insideRoots(args);
      if (recordAll || hit !== undefined) {
        records.push({
          module,
          fn: name,
          ...(hit === undefined ? {} : { path: hit }),
          at: Date.now(),
          stack: stack(),
        });
      }
      const result: unknown = Reflect.apply(original, this, args);
      return result;
    };
    for (const key of Reflect.ownKeys(original)) {
      if (key === 'length' || key === 'name' || key === 'prototype') {
        continue;
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(original, key);
      if (descriptor !== undefined) {
        Reflect.defineProperty(wrapped, key, descriptor);
      }
    }
    Reflect.set(target, name, wrapped);
  }
}

wrapAll(fs, 'fs', false);
wrapAll(fs.promises, 'fs/promises', false);
wrapAll(childProcess, 'child_process', true);
syncBuiltinESMExports();

process.on('exit', () => {
  if (report !== undefined) {
    writeReport(report, JSON.stringify(records, null, 2));
  }
});
