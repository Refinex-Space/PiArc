import type { DiffHunk } from '@piarc/protocol';
import { describe, expect, it } from 'vitest';

import type { FileChange, Finding, Review } from './protocol.js';
import { reviewOf } from './protocol.js';
import {
  changesKeyOf,
  findingId,
  formatFindings,
  shownFindings,
  shownLines,
  type ReviewRecord,
} from './review.js';

const finding = (path: string, line: number, title = 't', body = ''): Finding => ({
  path,
  line,
  severity: 'high',
  title,
  body,
});

const review = (findings: Finding[]): Review => ({
  scope: { kind: 'uncommitted' },
  summary: '',
  findings,
  dropped: 0,
  model: 'p/m',
  fallback: false,
  withheld: [],
});

describe('Git review', () => {
  it('reads Core’s answer and keeps only well-formed findings', () => {
    const parsed = reviewOf({
      scope: { kind: 'branch', base: 'main' },
      summary: 's',
      findings: [
        { path: 'a.ts', line: 2, severity: 'medium', title: 'x', body: 'y' },
        { path: 'a.ts', line: 0, severity: 'high', title: 'zero' },
        { path: 'a.ts', line: 3, severity: 'urgent', title: 'unknown severity' },
      ],
      dropped: 2,
      model: 'p/m',
      withheld: ['.env'],
    });
    expect(parsed?.scope).toEqual({ kind: 'branch', base: 'main' });
    expect(parsed?.findings).toEqual([
      { path: 'a.ts', line: 2, severity: 'medium', title: 'x', body: 'y' },
    ]);
    expect(parsed?.dropped).toBe(2);
    expect(reviewOf({ summary: 'no scope' })).toBeUndefined();
  });

  it('leaves dismissed findings out and orders the rest by file and line', () => {
    const b = finding('b.ts', 1);
    const a9 = finding('a.ts', 9);
    const a2 = finding('a.ts', 2);
    const record: ReviewRecord = {
      review: review([b, a9, a2]),
      dismissed: new Set([findingId(a9)]),
      changesKey: '',
    };
    expect(shownFindings(record)).toEqual([a2, b]);
    expect(shownFindings(undefined)).toEqual([]);
  });

  it('knows which new lines a file’s hunks show', () => {
    const hunk: DiffHunk = {
      oldStart: 4,
      oldLines: 3,
      newStart: 4,
      newLines: 3,
      lines: [
        { kind: 'context', text: 'a' },
        { kind: 'removed', text: 'b' },
        { kind: 'added', text: 'c' },
        { kind: 'context', text: 'd' },
      ],
    };
    expect([...shownLines([hunk])]).toEqual([4, 5, 6]);
  });

  it('changes its key when the scope’s changes change', () => {
    const file = (added: number): FileChange =>
      ({ path: 'a.ts', status: 'modified', added, removed: 0 }) as FileChange;
    expect(changesKeyOf([file(1)])).toBe(changesKeyOf([file(1)]));
    expect(changesKeyOf([file(1)])).not.toBe(changesKeyOf([file(2)]));
    // The same counts and ranges with other text: still a change.
    const edited = (text: string): FileChange =>
      ({
        path: 'README.md',
        status: 'modified',
        added: 1,
        removed: 1,
        diff: {
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [
                { kind: 'removed', text: 'old' },
                { kind: 'added', text },
              ],
            },
          ],
        },
      }) as unknown as FileChange;
    expect(changesKeyOf([edited('one')])).toBe(changesKeyOf([edited('one')]));
    expect(changesKeyOf([edited('one')])).not.toBe(changesKeyOf([edited('two')]));
  });

  it('writes the message for the agent by file, in line order, bodies indented', () => {
    const text = formatFindings(
      [
        finding('src/b.ts', 7, 'Unchecked input', 'Validate it.\nThen test it.'),
        finding('src/a.ts', 3, 'Leak'),
        finding('src/b.ts', 2, 'Typo'),
      ],
      'Code review findings on the uncommitted changes:',
    );
    expect(text).toBe(
      [
        'Code review findings on the uncommitted changes:',
        'Fix the findings that hold up. For any you leave as they are, say which and why.',
        '',
        '## src/b.ts',
        '- Line 2 (high): Typo',
        '- Line 7 (high): Unchecked input',
        '  Validate it.',
        '  Then test it.',
        '',
        '## src/a.ts',
        '- Line 3 (high): Leak',
      ].join('\n'),
    );
  });
});
