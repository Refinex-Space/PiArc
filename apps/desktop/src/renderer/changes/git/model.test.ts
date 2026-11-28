// @vitest-environment happy-dom
import type { DiffHunk } from '@piarc/protocol';
import { describe, expect, it } from 'vitest';

import {
  buildTree,
  changedWords,
  comparePaths,
  gapsOf,
  groupByKind,
  kindOf,
  readDisplay,
  rememberScope,
  rememberedScope,
  saveDisplay,
  scopeKey,
  settleScope,
  splitRows,
  treeRows,
  DEFAULT_DISPLAY,
} from './model.js';
import type { FileChange } from './protocol.js';

const file = (path: string): FileChange => ({
  path,
  status: 'modified',
  binary: false,
  submodule: false,
});

const hunk = (
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
  kinds: string,
): DiffHunk => ({
  oldStart,
  oldLines,
  newStart,
  newLines,
  lines: kinds.split('').map((k, i) => ({
    kind: k === '+' ? 'added' : k === '-' ? 'removed' : 'context',
    text: `${k}${String(i)}`,
  })),
});

describe('file kinds and order', () => {
  it('classifies generated before build before test', () => {
    expect(kindOf('src/a.ts')).toBe('source');
    expect(kindOf('src/a.test.ts')).toBe('test');
    expect(kindOf('tests/integration/x.rs')).toBe('test');
    expect(kindOf('pkg/x_test.go')).toBe('test');
    expect(kindOf('package.json')).toBe('build');
    expect(kindOf('apps/web/vite.config.ts')).toBe('build');
    expect(kindOf('.github/workflows/ci.yml')).toBe('build');
    expect(kindOf('package-lock.json')).toBe('generated');
    expect(kindOf('dist/tests/a.js')).toBe('generated');
    const groups = groupByKind([file('package.json'), file('a.ts'), file('a.test.ts')]);
    expect(groups.map(([k]) => k)).toEqual(['source', 'test', 'build']);
  });

  it('sorts numbers by value', () => {
    const paths = ['f10.ts', 'f2.ts', 'a/z.ts'].sort(comparePaths);
    expect(paths).toEqual(['a/z.ts', 'f2.ts', 'f10.ts']);
  });
});

describe('file tree', () => {
  it('merges single-child folders and lists folders first', () => {
    const tree = buildTree([
      file('src/lib/deep/a.ts'),
      file('src/lib/deep/b.ts'),
      file('README.md'),
    ]);
    expect(tree.map((n) => n.name)).toEqual(['src/lib/deep', 'README.md']);
    const rows = treeRows(tree, new Set());
    expect(rows.map((r) => (r.type === 'dir' ? `${r.name}/` : r.file.path))).toEqual([
      'src/lib/deep/',
      'src/lib/deep/a.ts',
      'src/lib/deep/b.ts',
      'README.md',
    ]);
    expect(treeRows(tree, new Set(['src/lib/deep']))).toHaveLength(2);
  });
});

describe('side by side and gaps', () => {
  it('pairs removed runs with the added lines after them', () => {
    const rows = splitRows(hunk(10, 4, 10, 3, ' --+ '));
    expect(rows.map((r) => [r.old?.number, r.new?.number])).toEqual([
      [10, 10],
      [11, 11],
      [12, undefined],
      [13, 12],
    ]);
  });

  it('finds the unchanged runs around hunks', () => {
    const hunks = [hunk(5, 3, 5, 4, ' + '), hunk(20, 2, 21, 2, '  ')];
    expect(gapsOf(hunks, undefined)).toEqual([
      { before: 0, start: 1, end: 4, delta: 0 },
      { before: 1, start: 9, end: 20, delta: -1 },
    ]);
    expect(gapsOf(hunks, 30).at(-1)).toEqual({ before: 2, start: 23, end: 30, delta: -1 });
    expect(gapsOf([hunk(0, 0, 1, 2, '++')], 2)).toEqual([]);
  });
});

describe('changed words', () => {
  it('marks the words that differ', () => {
    const words = changedWords('const total = a + b;', 'const sum = a + c;');
    expect(words?.before).toEqual([
      [6, 11],
      [18, 19],
    ]);
    expect(words?.after).toEqual([
      [6, 9],
      [16, 17],
    ]);
  });

  it('skips long lines', () => {
    expect(changedWords('x'.repeat(1001), 'y')).toBeUndefined();
  });
});

describe('remembered choices', () => {
  it('keeps the scope per session and falls back from a commit that left the branch', () => {
    rememberScope('s1', { kind: 'uncommitted' });
    rememberScope('s2', { kind: 'commit', sha: 'abc', short: 'abc', subject: 'x' });
    expect(rememberedScope('s1')).toEqual({ kind: 'uncommitted' });
    expect(scopeKey(rememberedScope('s2'))).toBe('commit:abc');
    expect(settleScope(rememberedScope('s2'), [])).toEqual({ kind: 'branch' });
    expect(rememberedScope('unknown')).toEqual({ kind: 'branch' });
  });

  it('reads display choices back and bounds the width', () => {
    saveDisplay({ ...DEFAULT_DISPLAY, layout: 'split', filesWidth: 9999 });
    expect(readDisplay()).toMatchObject({ layout: 'split', filesWidth: 640 });
  });
});
