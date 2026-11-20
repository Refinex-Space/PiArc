import { describe, expect, it } from 'vitest';

import { formatDuration, TaskList, taskDuration, taskOf, tasksOfSession } from './tasks.js';

const row = {
  taskId: 'bg-0a1b2c3d4e5f',
  sessionId: 'child',
  ownerSessionId: 'main',
  workspace: '/w 工作区',
  kind: 'monitor',
  title: '应用日志',
  command: 'tail -f app.log',
  cwd: '/w 工作区',
  status: 'running',
  startedAt: 1_000,
  outputBytes: 42,
  tail: ['error: one', 7, 'error: two'],
};

describe('background task snapshots (T32)', () => {
  it('reads tasks and drops malformed ones', () => {
    const task = taskOf(row);
    expect(task?.title).toBe('应用日志');
    expect(task?.tail).toEqual(['error: one', 'error: two']);
    expect(task?.command).toBe('tail -f app.log');
    expect(taskOf({ ...row, kind: 'cron' })).toBeUndefined();
    expect(taskOf({ ...row, startedAt: -1 })).toBeUndefined();
  });

  it('keeps the newest revision and lists a main session’s tasks', () => {
    const list = new TaskList();
    let heard = 0;
    list.subscribe(() => {
      heard += 1;
    });
    expect(list.apply({ revision: 2, tasks: [row, { bad: true }] })).toBe(true);
    expect(list.apply({ revision: 1, tasks: [] })).toBe(false);
    expect(list.apply({ revision: 2, tasks: [] })).toBe(false);
    expect(list.apply({ tasks: [] })).toBe(false);
    expect(heard).toBe(1);
    expect(list.all.map((t) => t.taskId)).toEqual(['bg-0a1b2c3d4e5f']);
    expect(tasksOfSession(list.all, 'main')).toHaveLength(1);
    expect(tasksOfSession(list.all, 'child')).toHaveLength(0);
    expect(tasksOfSession(list.all, undefined)).toHaveLength(0);
  });

  it('measures and formats how long a task ran', () => {
    const running = taskOf(row);
    const ended = taskOf({ ...row, status: 'completed', endedAt: 66_000 });
    if (running === undefined || ended === undefined) throw new Error('tasks');
    expect(taskDuration(running, 13_500)).toBe(12_500);
    expect(taskDuration(ended, 999_999)).toBe(65_000);
    expect(formatDuration(12_500)).toBe('12s');
    expect(formatDuration(65_000)).toBe('1m 05s');
    expect(formatDuration(3_725_000)).toBe('1h 02m');
  });
});
