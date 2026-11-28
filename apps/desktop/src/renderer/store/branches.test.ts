import { describe, expect, it, vi } from 'vitest';

import { branchesOf, SessionBranches } from './branches.js';

describe('SessionBranches', () => {
  it('loads the history window, follows session/branches and finds points', () => {
    const branches = new SessionBranches();
    const listener = vi.fn();
    branches.subscribe(listener);
    branches.load([
      { turnId: 't2', index: 0, options: [{ entryId: 'a', turnId: 't2', preview: 'x' }] },
      { options: [{ entryId: 'b', preview: 'y' }] },
    ]);
    expect(branches.forTurn('t2')?.options).toHaveLength(1);
    expect(branches.forTurn(undefined)).toBeUndefined();
    expect(branches.tail()?.options[0]?.entryId).toBe('b');
    expect(branches.apply('harness/todo', {})).toBe(false);
    expect(branches.apply('session/branches', { branches: [] })).toBe(true);
    expect(branches.state()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('skips malformed points', () => {
    expect(branchesOf('nope')).toEqual([]);
    expect(branchesOf([{ options: [{ entryId: 1 }] }, { turnId: 't', options: 'x' }])).toEqual([]);
  });
});
