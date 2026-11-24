import { describe, expect, it } from 'vitest';
import {
  parseTable,
  indentSelection,
  findMatches,
  parseLocation,
  replaceMatches,
  selectionFromMatches,
  sourceLines,
  textSelection,
} from './viewer-model.js';

describe('project file viewer', () => {
  it('keeps empty lines, CRLF and source selections tied to actual file lines', () => {
    expect(sourceLines('a\r\nb\n')).toEqual(['a', 'b', '']);
    expect(textSelection('a\nbc\nd\n', 2, 5)).toEqual({ startLine: 2, endLine: 2, text: 'bc\n' });
    expect(parseLocation('3:5', 4)).toEqual({ line: 3, column: 5 });
    expect(parseLocation('0', 4)).toBeUndefined();
    expect(parseLocation('30', 4)).toBeUndefined();
  });

  it('indents and outdents the selected lines without replacing their text or including the following line', () => {
    expect(indentSelection('one\n  two\nend', 0, 10, 2, false)).toEqual({
      from: 0,
      to: 9,
      insert: '  one\n    two',
      start: 2,
      end: 14,
    });
    expect(indentSelection('  one\n    two\nend', 2, 14, 2, true)).toEqual({
      from: 0,
      to: 13,
      insert: 'one\n  two',
      start: 0,
      end: 10,
    });
    expect(indentSelection('abc', 1, 1, 4, false)).toEqual({
      from: 1,
      to: 1,
      insert: '   ',
      start: 4,
      end: 4,
    });
    expect(indentSelection('abc', 0, 0, 4, true)).toBeUndefined();
  });

  it('previews quoted delimiters, escaped quotes and multiline records with bounded rows', () => {
    expect(parseTable('a,b\r\n"x,y","p""q"\r\n"a\nb",c\r\n', ',').rows).toEqual([
      ['a', 'b'],
      ['x,y', 'p"q'],
      ['a\nb', 'c'],
    ]);
    expect(parseTable('a,b\n1,2\n3,4', ',', 2).truncated).toBe(true);
    expect(parseTable('x,"unterminated', ',').invalid).toBe(true);
  });

  it('finds each occurrence, handles unicode word boundaries and invalid or zero-length patterns', () => {
    const options = { matchCase: false, wholeWord: true, regexp: false };
    expect(findMatches(['a cat catapult CAT', 'the.cat'], 'cat', options).matches).toEqual([
      { line: 1, start: 2, end: 5 },
      { line: 1, start: 15, end: 18 },
      { line: 2, start: 4, end: 7 },
    ]);
    expect(findMatches(['猫 猫咪'], '猫', options).matches).toHaveLength(1);
    expect(findMatches(['hello'], '(', { ...options, regexp: true }).invalid).toBe(true);
    expect(findMatches(['hello'], '^', { ...options, regexp: true }).matches).toEqual([]);
  });

  it('replaces one match or every match and keeps the original newlines', () => {
    const options = { matchCase: false, wholeWord: true, regexp: false };
    expect(replaceMatches('a cat\r\ncatapult CAT', 'cat', 'dog', options, 'all')).toBe(
      'a dog\r\ncatapult dog',
    );
    expect(replaceMatches('a cat cat', 'cat', 'dog', options, { line: 1, start: 2, end: 5 })).toBe(
      'a dog cat',
    );
    expect(
      replaceMatches(
        'id-9',
        '(\\d+)',
        'n$1',
        { matchCase: false, wholeWord: false, regexp: true },
        'all',
      ),
    ).toBe('id-n9');
    expect(
      replaceMatches(
        'hello',
        '(',
        'x',
        { matchCase: false, wholeWord: false, regexp: true },
        'all',
      ),
    ).toBeUndefined();
    expect(
      selectionFromMatches('a cat\nand dog', [
        { line: 1, start: 2, end: 5 },
        { line: 2, start: 4, end: 7 },
      ]),
    ).toEqual({ startLine: 1, endLine: 2, text: 'cat\nand dog' });
  });
});
