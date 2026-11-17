import type { FileDiff } from '@piarc/protocol';
import { describe, expect, it } from 'vitest';

import {
  MAX_ARGUMENT_DEPTH,
  MAX_ITEM_ARGUMENTS,
  boundArguments,
  resultDiff,
  toolItem,
} from './items.js';

/** Arguments whose leaf sits `levels` objects (or arrays) deep. */
function nested(levels: number, array = false): Record<string, unknown> {
  let value: unknown = 'leaf';
  for (let i = 1; i < levels; i += 1) {
    value = array ? [value] : { k: value };
  }
  return { k: value };
}

describe('boundArguments', () => {
  it('keeps arguments nested up to the limit', () => {
    const args = nested(MAX_ARGUMENT_DEPTH);
    expect(boundArguments(args)).toEqual(args);
  });

  // I09: frames stop at 127 levels, so deeper arguments would make Core drop the whole frame.
  it('replaces arguments nested deeper than the limit by a note', () => {
    for (const args of [nested(MAX_ARGUMENT_DEPTH + 1), nested(200, true)]) {
      expect(boundArguments(args)).toEqual({
        piarcOmitted: `arguments nested deeper than ${String(MAX_ARGUMENT_DEPTH)} levels`,
      });
    }
  });

  it('replaces arguments larger than the limit by a note', () => {
    const args = { content: 'x'.repeat(MAX_ITEM_ARGUMENTS) };
    const size = JSON.stringify(args).length;
    expect(boundArguments(args)).toEqual({
      piarcOmitted: `arguments of ${String(size)} characters`,
    });
  });

  it('makes lone surrogates well-formed', () => {
    expect(boundArguments({ text: 'a\uD800b' })).toEqual({ text: 'a�b' });
  });
});

describe('file change diffs', () => {
  const diff: FileDiff = {
    path: 'src/a.ts',
    added: 1,
    removed: 1,
    unified: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n',
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { kind: 'removed', text: 'a' },
          { kind: 'added', text: 'b' },
        ],
      },
    ],
  };

  it('take the diff Core returned from the result details onto fileChange items only', () => {
    expect(resultDiff({ diff: 'pi display diff', fileDiff: diff })).toEqual(diff);
    const details = { fileDiff: diff };
    const item = toolItem('t1', 'completed', 'Edit', { path: 'src/a.ts' }, 'ok', details);
    expect(item).toMatchObject({ type: 'fileChange', path: 'src/a.ts', diff });
    const other = toolItem('t2', 'completed', 'Grep', {}, 'ok', details);
    expect(other).not.toHaveProperty('diff');
  });

  it('take how a command ran from the result details onto commandExecution items (T17)', () => {
    const execution = {
      cwd: '/w s/项目',
      exitCode: 1,
      outcome: 'success',
      meaning: 'no matches',
      durationMs: 12,
      timedOut: false,
      timeoutMs: 120000,
      truncated: false,
    } as const;
    const item = toolItem('t3', 'completed', 'Bash', { command: 'grep x f' }, 'ok', {
      commandExecution: execution,
    });
    expect(item).toEqual({
      type: 'commandExecution',
      itemId: 't3',
      status: 'completed',
      tool: 'Bash',
      arguments: { command: 'grep x f' },
      command: 'grep x f',
      output: 'ok',
      execution,
    });
    // Details that do not validate (a session file is input) are left out.
    const broken = toolItem('t4', 'completed', 'Bash', { command: 'x' }, 'ok', {
      commandExecution: { ...execution, outcome: 'maybe' },
    });
    expect(broken).not.toHaveProperty('execution');
  });

  it('ignore details that are not a diff', () => {
    expect(resultDiff(undefined)).toBeUndefined();
    expect(resultDiff({ fileDiff: { path: 'a' } })).toBeUndefined();
    expect(
      resultDiff({
        fileDiff: { ...diff, hunks: [{ ...diff.hunks[0], lines: [{ kind: 'x', text: '' }] }] },
      }),
    ).toBeUndefined();
  });
});
