import { describe, expect, it } from 'vitest';

import type { FrameCell } from './frame/decoder.js';
import { isOpenableLink, urlAt, urlsInRow } from './links.js';

/** One narrow cell per character; `中` style characters take two columns. */
function row(text: string): FrameCell[] {
  const cells: FrameCell[] = [];
  for (const char of text) {
    if (/\p{Script=Han}/u.test(char)) {
      cells.push({ wide: 1, style: 0, text: char }, { wide: 2, style: 0, text: '' });
    } else {
      cells.push({ wide: 0, style: 0, text: char === ' ' ? '' : char });
    }
  }
  return cells;
}

describe('URLs in a terminal row', () => {
  it('finds http, https and mailto addresses with their columns', () => {
    const links = urlsInRow(row('see https://example.com/a?b=1 or mailto:me@example.com.'));
    expect(links).toEqual([
      { uri: 'https://example.com/a?b=1', start: 4, end: 28 },
      { uri: 'mailto:me@example.com', start: 33, end: 53 },
    ]);
  });

  it('maps columns past wide characters and trims closing punctuation', () => {
    const cells = row('文档 (https://example.com/x), 完');
    const [link] = urlsInRow(cells);
    expect(link).toEqual({ uri: 'https://example.com/x', start: 6, end: 26 });
    expect(urlAt(cells, 10)?.uri).toBe('https://example.com/x');
    expect(urlAt(cells, 2)).toBeUndefined();
    // A closing bracket that belongs to the URL stays.
    expect(urlsInRow(row('https://en.wikipedia.org/wiki/Rust_(language) x'))[0]?.uri).toBe(
      'https://en.wikipedia.org/wiki/Rust_(language)',
    );
  });

  it('only accepts the schemes the main process opens, without user information', () => {
    expect(urlsInRow(row('file:///etc/passwd javascript:alert(1) ftp://x'))).toEqual([]);
    expect(isOpenableLink('https://user@example.com/')).toBe(false);
    expect(isOpenableLink('HTTPS://EXAMPLE.COM')).toBe(true);
    expect(isOpenableLink('not a url')).toBe(false);
  });
});
