import { describe, expect, it } from 'vitest';

import { replaceAll } from './replace-all.js';

describe('replaceAll', () => {
  it('replaces every exact occurrence and counts them', () => {
    const { text, count } = replaceAll(
      'a = 1; b = 1; c = 2;',
      [{ oldText: '= 1', newText: '= 9' }],
      'f.ts',
    );
    expect(text).toBe('a = 9; b = 9; c = 2;');
    expect(count).toBe(2);
  });

  it('keeps CRLF line endings, a byte order mark and untouched lines', () => {
    const raw = '﻿keep\r\nold line\r\nmixed\nold line\r\n';
    const { text } = replaceAll(raw, [{ oldText: 'old line\n', newText: 'new\nline\n' }], 'f.txt');
    expect(text).toBe('﻿keep\r\nnew\r\nline\r\nmixed\nnew\r\nline\r\n');
  });

  it('fails without a match, on overlaps and when nothing changes', () => {
    expect(() => replaceAll('abc', [{ oldText: 'x', newText: 'y' }], 'f')).toThrow(
      /Could not find oldText in f/,
    );
    expect(() =>
      replaceAll(
        'abcabc',
        [
          { oldText: 'abc', newText: '1' },
          { oldText: 'bc', newText: '2' },
        ],
        'f',
      ),
    ).toThrow(/overlap/);
    expect(() => replaceAll('aa', [{ oldText: 'a', newText: 'a' }], 'f')).toThrow(/No changes/);
    expect(() => replaceAll('aa', [{ oldText: '', newText: 'b' }], 'f')).toThrow(
      /must not be empty/,
    );
  });
});
