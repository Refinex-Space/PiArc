import { describe, expect, it } from 'vitest';

import { planOf, SessionHarness, todosOf } from './harness.js';

const PLAN = { plan: '1. Fix', toolCallId: 'exit', entryId: 'e1', mode: 'acceptEdits' };
const TODOS = [
  { content: 'Read', status: 'completed' },
  { content: 'Fix', status: 'inProgress', activeForm: 'Fixing' },
];

describe('session harness state', () => {
  it('loads the history window state and follows harness notifications', () => {
    const harness = new SessionHarness();
    let changes = 0;
    harness.subscribe(() => changes++);
    harness.load({ plan: PLAN, todos: TODOS });
    expect(harness.state()).toEqual({ plan: PLAN, todos: TODOS });
    expect(harness.apply('harness/todo', { itemId: 't', todos: [] })).toBe(true);
    expect(harness.state().todos).toEqual([]);
    expect(harness.apply('harness/plan', { ...PLAN, plan: '2. Test' })).toBe(true);
    expect(harness.state().plan?.plan).toBe('2. Test');
    expect(harness.apply('item/completed', {})).toBe(false);
    harness.load(undefined);
    expect(harness.state()).toEqual({ plan: undefined, todos: [] });
    expect(changes).toBe(4);
  });

  it('ignores malformed lists and plans', () => {
    expect(todosOf([{ content: 'A', status: 'in_progress' }])).toBeUndefined();
    expect(todosOf('x')).toBeUndefined();
    expect(planOf({ ...PLAN, mode: 'auto' })).toBeUndefined();
    const harness = new SessionHarness();
    harness.apply('harness/todo', { todos: [{ content: 1, status: 'pending' }] });
    expect(harness.state().todos).toEqual([]);
  });
});
