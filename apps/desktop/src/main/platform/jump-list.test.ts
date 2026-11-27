import { describe, expect, it, vi } from 'vitest';
import { Translator } from '../../shared/i18n/index.js';
import { launchTargets } from '../launch.js';
import { jumpList, recentWorkspaces } from './jump-list.js';

vi.mock('electron', () => ({}));

const program = 'C:\\Program Files\\PiArc\\PiArc.exe';
const locale = new Translator('zh-CN');
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('Windows jump list', () => {
  it('uses the last Core snapshot, in recency order, and accepts an empty snapshot', () => {
    const rows = [
      { path: 'D:\\a b&仓库', displayName: 'project' },
      { path: 'C:\\', displayName: 'root' },
      { path: 'D:\\hidden', displayName: 'removed' },
    ] as const;
    const recent = recentWorkspaces(encode([{ workspaces: [] }, { workspaces: rows }]));
    expect(recent).toEqual(rows);
    expect(recentWorkspaces(encode([{ workspaces: [] }]))).toEqual([]);
    expect(recentWorkspaces(encode([{ workspaces: 'bad' }]))).toBeUndefined();
    const list = jumpList(program, recent ?? [], [{ args: '"D:\\hidden"' }], locale);
    expect(list[0]).toMatchObject({
      name: '最近的工作区',
      type: 'custom',
      items: [
        { type: 'task', title: 'project', args: '"D:\\a b&仓库"', program },
        { type: 'task', title: 'root', args: '"C:\\\\"', program },
      ],
    });
    expect(launchTargets([program, rows[0].path], false, 'C:\\')).toEqual([
      { kind: 'workspace', path: 'D:\\a b&仓库' },
    ]);
  });

  it('builds two localized fixed tasks that cold and second starts can route', () => {
    const categories = jumpList(program, [], [], locale);
    expect(categories).toHaveLength(1);
    expect(categories[0]?.type).toBe('tasks');
    const tasks = categories[0]?.items ?? [];
    expect(tasks.map((item) => item.title)).toEqual(['新建会话', '打开项目']);
    for (const [index, kind] of ['newSession', 'chooseFolder'].entries()) {
      const args = tasks[index]?.args ?? '';
      expect(tasks[index]?.program).toBe(program);
      expect(launchTargets([program, args], false, 'C:\\')).toEqual([{ kind }]);
      expect(launchTargets([program, args + '=run'], false, 'C:\\')).toEqual([]);
    }
  });
});
