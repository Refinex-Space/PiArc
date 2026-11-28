import type { ChangesFile } from '@piarc/protocol';
import { describe, expect, it } from 'vitest';

import { formatComments, isSendKey, reanchor, sideLines, type DiffComment } from './comments.js';

function file(
  label: string,
  lines: { kind: 'context' | 'added' | 'removed'; text: string }[],
  newStart = 10,
): ChangesFile {
  return {
    path: `/w/${label}`,
    label,
    kind: 'modified',
    added: 0,
    removed: 0,
    version: 'v',
    diff: {
      path: label,
      added: 0,
      removed: 0,
      unified: '',
      hunks: [
        {
          oldStart: 10,
          oldLines: lines.filter((l) => l.kind !== 'added').length,
          newStart,
          newLines: lines.filter((l) => l.kind !== 'removed').length,
          lines,
        },
      ],
    },
  } as unknown as ChangesFile;
}

const comment = (over: Partial<DiffComment>): DiffComment => ({
  id: 'c',
  path: 'a.ts',
  side: 'new',
  start: 11,
  end: 11,
  excerpt: ['const b = 2;'],
  body: 'Name it better.',
  ...over,
});

describe('diff comments', () => {
  it('numbers each side of a hunk', () => {
    const f = file('a.ts', [
      { kind: 'context', text: 'a' },
      { kind: 'removed', text: 'old' },
      { kind: 'added', text: 'new' },
    ]);
    expect([...sideLines(f, 'old')]).toEqual([
      [10, 'a'],
      [11, 'old'],
    ]);
    expect([...sideLines(f, 'new')]).toEqual([
      [10, 'a'],
      [11, 'new'],
    ]);
  });

  it('keeps, moves or marks stale a comment when the diff changes', () => {
    const before = [comment({})];
    const same = file('a.ts', [
      { kind: 'context', text: 'const a = 1;' },
      { kind: 'added', text: 'const b = 2;' },
    ]);
    expect(reanchor(before, [same])[0]).toEqual(comment({}));
    // Two lines were added above: the comment follows its line.
    const moved = file('a.ts', [
      { kind: 'added', text: 'x' },
      { kind: 'added', text: 'y' },
      { kind: 'context', text: 'const a = 1;' },
      { kind: 'added', text: 'const b = 2;' },
    ]);
    expect(reanchor(before, [moved])[0]).toMatchObject({ start: 13, end: 13 });
    expect(reanchor(before, [moved])[0]?.stale).toBeUndefined();
    const gone = file('a.ts', [{ kind: 'context', text: 'const a = 1;' }]);
    expect(reanchor(before, [gone])[0]).toMatchObject({ stale: true, body: 'Name it better.' });
    expect(reanchor(before, [])[0]?.stale).toBe(true);
  });

  it('writes one message grouped by file, without stale comments', () => {
    const text = formatComments([
      comment({
        id: '1',
        path: 'b.ts',
        start: 3,
        end: 4,
        excerpt: ['x', 'y'],
        body: 'Merge these.',
      }),
      comment({ id: '2', side: 'old', start: 7, end: 7, excerpt: ['old()'], body: 'Keep this.' }),
      comment({ id: '3', stale: true, body: 'Lost.' }),
    ]);
    expect(text).toBe(
      [
        'Review comments on the changes:',
        '',
        '## b.ts',
        '',
        'Lines 3-4 (new version):',
        '```',
        'x',
        'y',
        '```',
        'Merge these.',
        '',
        '## a.ts',
        '',
        'Line 7 (old version):',
        '```',
        'old()',
        '```',
        'Keep this.',
      ].join('\n'),
    );
  });
});

describe('isSendKey', () => {
  const key = (fields: Partial<Parameters<typeof isSendKey>[0]>) => ({
    key: 'Enter',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 13,
    ...fields,
  });
  it('is Cmd+Enter on macOS and Ctrl+Enter elsewhere, never while composing', () => {
    expect(isSendKey(key({ metaKey: true }), 'mac')).toBe(true);
    expect(isSendKey(key({ ctrlKey: true }), 'mac')).toBe(false);
    expect(isSendKey(key({ ctrlKey: true }), 'other')).toBe(true);
    expect(isSendKey(key({ metaKey: true }), 'other')).toBe(false);
    expect(isSendKey(key({ metaKey: true, keyCode: 229 }), 'mac')).toBe(false);
    expect(isSendKey(key({ metaKey: true, shiftKey: true }), 'mac')).toBe(false);
    expect(isSendKey(key({}), 'mac')).toBe(false);
  });
});
