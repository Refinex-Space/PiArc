import { describe, expect, it } from 'vitest';

import { hasMarkers, linesOf, merge3, resultText, type Resolution } from './merge3.js';

const labels = { yours: 'main', theirs: 'topic' };
const text = (...lines: string[]) => lines.map((l) => `${l}\n`).join('');

describe('three-way merge', () => {
  it('keeps line ends, carriage returns and a last line without one', () => {
    expect(linesOf('a\r\nb\nc')).toEqual(['a\r\n', 'b\n', 'c']);
    expect(linesOf('')).toEqual([]);
  });

  it('takes changes made on one side only, in different places', () => {
    const base = text('one', 'two', 'three', 'four', 'five');
    const yours = text('ONE', 'two', 'three', 'four', 'five');
    const theirs = text('one', 'two', 'three', 'four', 'FIVE', 'six');
    const chunks = merge3(base, yours, theirs);
    expect(chunks.map((c) => c.kind)).toEqual(['yours', 'same', 'theirs']);
    expect(resultText(chunks, new Map(), labels)).toBe(
      text('ONE', 'two', 'three', 'four', 'FIVE', 'six'),
    );
  });

  it('takes the same change on both sides once', () => {
    const chunks = merge3(text('a', 'b'), text('a', 'B'), text('a', 'B'));
    expect(chunks.map((c) => c.kind)).toEqual(['same', 'both']);
    expect(resultText(chunks, new Map(), labels)).toBe(text('a', 'B'));
  });

  it('marks different changes to the same lines as a conflict and resolves it as asked', () => {
    const chunks = merge3(text('a', 'b', 'c'), text('a', 'mine', 'c'), text('a', 'yours', 'c'));
    expect(chunks.map((c) => c.kind)).toEqual(['same', 'conflict', 'same']);
    expect(resultText(chunks, new Map(), labels)).toBe(
      text('a', '<<<<<<< main', 'mine', '=======', 'yours', '>>>>>>> topic', 'c'),
    );
    const pick = (resolution: Resolution) => resultText(chunks, new Map([[1, resolution]]), labels);
    expect(pick('yours')).toBe(text('a', 'mine', 'c'));
    expect(pick('theirs')).toBe(text('a', 'yours', 'c'));
    expect(pick('yoursFirst')).toBe(text('a', 'mine', 'yours', 'c'));
    expect(pick('theirsFirst')).toBe(text('a', 'yours', 'mine', 'c'));
    expect(pick('neither')).toBe(text('a', 'b', 'c'));
    expect(hasMarkers(resultText(chunks, new Map(), labels))).toBe(true);
    expect(hasMarkers(pick('yours'))).toBe(false);
  });

  it('treats insertions at the same place as a conflict and deletions on one side as changes', () => {
    const inserted = merge3(text('a', 'z'), text('a', 'x', 'z'), text('a', 'y', 'z'));
    expect(inserted.map((c) => c.kind)).toEqual(['same', 'conflict', 'same']);
    const deleted = merge3(text('a', 'b', 'c'), text('a', 'c'), text('a', 'b', 'c', 'd'));
    expect(resultText(deleted, new Map(), labels)).toBe(text('a', 'c', 'd'));
  });

  it('merges files with Windows line ends and an added file without a base', () => {
    const crlf = merge3('a\r\nb\r\nc\r\n', 'A\r\nb\r\nc\r\n', 'a\r\nb\r\nC\r\n');
    expect(resultText(crlf, new Map(), labels)).toBe('A\r\nb\r\nC\r\n');
    // Changes to neighbouring lines with nothing shared between them conflict, as in Git.
    expect(merge3('a\nb\n', 'A\nb\n', 'a\nB\n').map((c) => c.kind)).toEqual(['conflict']);
    const added = merge3('', 'mine', 'theirs');
    expect(added.map((c) => c.kind)).toEqual(['conflict']);
    // A side without a final line end still gets the markers on their own lines.
    expect(resultText(added, new Map(), labels)).toBe(
      text('<<<<<<< main', 'mine', '=======', 'theirs', '>>>>>>> topic'),
    );
  });

  it('stays linear on long files with scattered edits', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${String(i)}`);
    const base = text(...lines);
    const yours = text(...lines.map((l, i) => (i % 100 === 0 ? `${l} mine` : l)));
    const theirs = text(...lines.map((l, i) => (i % 100 === 50 ? `${l} theirs` : l)));
    const chunks = merge3(base, yours, theirs);
    expect(chunks.filter((c) => c.kind === 'conflict')).toHaveLength(0);
    expect(resultText(chunks, new Map(), labels)).toContain('line 50 theirs\n');
    expect(resultText(chunks, new Map(), labels)).toContain('line 100 mine\n');
  });
});
