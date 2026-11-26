import { describe, expect, it } from 'vitest';

import { checkOf, groupCheck, groupOf, letterOf } from './CommitView.js';
import { branchNameProblem } from './GitPrompts.js';
import type { StatusFile } from './protocol.js';

const file = (fields: Partial<StatusFile>): StatusFile => ({
  path: 'a.txt',
  submodule: false,
  ...fields,
});

describe('the commit view (SPEC B1)', () => {
  it('groups conflicts, tracked changes and untracked files', () => {
    expect(groupOf(file({ unstaged: 'modified' }))).toBe('changes');
    expect(groupOf(file({ staged: 'added' }))).toBe('changes');
    expect(groupOf(file({ unstaged: 'untracked' }))).toBe('untracked');
    expect(groupOf(file({ staged: 'conflicted', unstaged: 'conflicted', conflict: 'UU' }))).toBe(
      'conflicts',
    );
    expect(groupOf(file({ conflict: 'AA' }))).toBe('conflicts');
  });

  it('shows staged, partly staged and unstaged as a tri-state checkbox', () => {
    expect(checkOf(file({ staged: 'modified' }))).toBe(true);
    expect(checkOf(file({ staged: 'modified', unstaged: 'modified' }))).toBe('mixed');
    expect(checkOf(file({ unstaged: 'modified' }))).toBe(false);
    expect(checkOf(file({ unstaged: 'untracked' }))).toBe(false);
    expect(groupCheck([file({ staged: 'added' }), file({ staged: 'deleted' })])).toBe(true);
    expect(groupCheck([file({ staged: 'added' }), file({ unstaged: 'modified' })])).toBe('mixed');
    expect(groupCheck([file({ unstaged: 'modified' })])).toBe(false);
    expect(groupCheck([])).toBe(false);
  });

  it('has a letter for every status', () => {
    expect(
      [
        'added',
        'modified',
        'deleted',
        'renamed',
        'copied',
        'typeChanged',
        'untracked',
        'conflicted',
      ].map((s) => letterOf(s as StatusFile['staged'])),
    ).toEqual(['A', 'M', 'D', 'R', 'C', 'T', '?', 'U']);
    expect(letterOf(undefined)).toBe('');
  });

  it('refuses branch names Git refuses', () => {
    for (const ok of ['main', 'feature/login', 'fix-1.2', '修复/登录'])
      expect(branchNameProblem(ok)).toBeUndefined();
    expect(branchNameProblem('  ')).toBe('empty');
    for (const bad of [
      'a b',
      'a..b',
      '-a',
      '/a',
      'a/',
      'a.',
      'a.lock',
      'a@{1}',
      'a~1',
      'a^',
      'a:b',
      'a?',
      'a*',
      'a[',
      'a\\b',
      'a//b',
      'a\u0001',
    ]) {
      expect(branchNameProblem(bad), bad).toBe('invalid');
    }
  });
});
