import { describe, expect, it } from 'vitest';

import { moved, rowsProblem, type RebaseRow } from './RebaseDialog.js';

const row = (sha: string, action: RebaseRow['action'], merge = false): RebaseRow => ({
  commit: { sha, subject: sha, message: sha, merge, pushed: false },
  action,
  message: sha,
});

describe('interactive rebase rows', () => {
  it('needs a kept commit before folding, messages for rewords, and no merges', () => {
    expect(rowsProblem([row('a', 'pick'), row('b', 'squash')])).toBeUndefined();
    expect(rowsProblem([row('a', 'drop'), row('b', 'fixup')])).toBe('fold');
    expect(rowsProblem([row('a', 'drop')])).toBe('empty');
    expect(rowsProblem([{ ...row('a', 'reword'), message: '  ' }])).toBe('message');
    expect(rowsProblem([row('a', 'pick', true)])).toBe('merge');
  });

  it('moves rows within bounds', () => {
    const rows = [row('a', 'pick'), row('b', 'pick'), row('c', 'pick')];
    expect(moved(rows, 2, -1).map((r) => r.commit.sha)).toEqual(['a', 'c', 'b']);
    expect(moved(rows, 0, -1).map((r) => r.commit.sha)).toEqual(['a', 'b', 'c']);
    expect(moved(rows, 0, 5).map((r) => r.commit.sha)).toEqual(['b', 'c', 'a']);
  });
});
