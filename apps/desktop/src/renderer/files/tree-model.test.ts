import { absoluteFilePath } from './file-path.js';
import { describe, expect, it } from 'vitest';
import { searchRows, selectRow, treeRows, type FolderPage } from './tree-model.js';
import type { ProjectMatch } from './api.js';

describe('project file tree', () => {
  const folders = new Map<string, FolderPage>([
    [
      '',
      {
        entries: [
          { path: 'docs', name: 'docs', kind: 'directory' },
          {
            path: 'shortcut',
            name: 'shortcut',
            kind: 'directory',
            link: { state: 'external', target: '../other' },
          },
          { path: 'readme.md', name: 'readme.md', kind: 'file' },
        ],
        truncated: false,
      },
    ],
    [
      'docs',
      { entries: [{ path: 'docs/about.md', name: 'about.md', kind: 'file' }], truncated: true },
    ],
  ]);

  it('includes only expanded, reachable descendants and gives a limited directory its own notice', () => {
    expect(treeRows(folders, new Set()).map((row) => row.path)).toEqual([
      'docs',
      'shortcut',
      'readme.md',
    ]);
    const rows = treeRows(folders, new Set(['shortcut', 'docs']));
    expect(rows.map((row) => row.id)).toEqual([
      'docs',
      'docs/about.md',
      '\u0000docs',
      'shortcut',
      'readme.md',
    ]);
    expect(rows[2]?.note).toBe('truncated');
    expect(rows[3]?.blocked).toBe(true);
  });
  it('selects ranges in display order and can toggle a member without selecting the notice', () => {
    const rows = treeRows(folders, new Set(['docs']));
    const [start, end, toggle] = [rows[4], rows[1], rows[3]];
    if (!start || !end || !toggle) throw new Error('missing tree rows');
    const range = selectRow({ anchor: start.id, paths: new Set([start.path]) }, rows, end, 'range');
    expect([...range.paths]).toEqual(['docs/about.md', 'shortcut', 'readme.md']);
    expect([...selectRow(range, rows, toggle, 'toggle').paths]).toEqual([
      'docs/about.md',
      'readme.md',
    ]);
  });
  it('groups separate line results under one file and preserves every matching line', () => {
    const match: ProjectMatch = {
      name: 'x',
      path: 'a/x',
      kind: 'file',
      line: 5,
      column: 3,
      preview: ' x',
      ranges: [[1, 2]],
    };
    const rows = searchRows([match, { ...match, path: 'b/x' }, { ...match, line: 7 }], true);
    expect(rows.map((row) => [row.path, row.match?.line])).toEqual([
      ['a/x', undefined],
      ['a/x', 5],
      ['a/x', 7],
      ['b/x', undefined],
      ['b/x', 5],
    ]);
  });
  it('copies absolute workspace paths using the local path spelling', () => {
    expect(absoluteFilePath('/project/', 'dir/foo')).toBe('/project/dir/foo');
    expect(absoluteFilePath('D:\\', 'dir/foo')).toBe('D:\\dir\\foo');
    expect(absoluteFilePath('\\\\server\\project', 'dir/foo')).toBe(
      '\\\\server\\project\\dir\\foo',
    );
  });
});

it('keeps other files in view when one file has many hits and can expand its remaining results', () => {
  const hits: ProjectMatch[] = Array.from({ length: 40 }, (_, i) => ({
    name: 'a',
    path: 'a',
    kind: 'file',
    line: i + 1,
    column: 1,
  }));
  hits.push({ name: 'b', path: 'b', kind: 'file', line: 9, column: 1 });
  const initial = searchRows(hits, true);
  expect(initial.filter((row) => row.path === 'a' && row.match)).toHaveLength(5);
  expect(initial.find((row) => row.note === 'more')?.remaining).toBe(35);
  expect(initial.at(-1)?.path).toBe('b');
  expect(
    searchRows(hits, true, new Set(['a'])).filter((row) => row.path === 'a' && row.match),
  ).toHaveLength(40);
});
