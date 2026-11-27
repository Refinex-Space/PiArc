import { describe, expect, it } from 'vitest';

import { Translator } from '../../shared/i18n/index.js';
import { projectName, removeWorkspace, type WorkspaceRemovalCore } from './workspace-removal.js';

function fakeCore(work: { sessions: number; tasks: number } | string) {
  const removed: string[] = [];
  const asked: string[] = [];
  const core: WorkspaceRemovalCore = {
    workspaceWork: (path: string) => {
      asked.push(path);
      return Promise.resolve(typeof work === 'string' ? work : JSON.stringify(work));
    },
    removeWorkspace: (path: string) => {
      removed.push(path);
      return Promise.resolve('null');
    },
  };
  return { core, removed, asked };
}

describe('removing a project', () => {
  const t = new Translator('en');
  const path = '/Users/me/work space 工作区';

  it('removes a project without running work and asks nothing', async () => {
    const { core, removed } = fakeCore({ sessions: 0, tasks: 0 });
    const dialogs: Electron.MessageBoxOptions[] = [];
    const done = await removeWorkspace(
      core,
      t,
      (options) => {
        dialogs.push(options);
        return Promise.resolve(0);
      },
      path,
    );
    expect(done).toBe(true);
    expect(dialogs).toEqual([]);
    expect(removed).toEqual([path]);
  });

  it('lists the running work in a native confirmation; cancelling keeps the project', async () => {
    const { core, removed } = fakeCore({ sessions: 2, tasks: 1 });
    const dialogs: Electron.MessageBoxOptions[] = [];
    const done = await removeWorkspace(
      core,
      t,
      (options) => {
        dialogs.push(options);
        return Promise.resolve(1);
      },
      path,
    );
    expect(done).toBe(false);
    expect(removed).toEqual([]);
    const [dialog] = dialogs;
    expect(dialog?.message).toBe('Remove “work space 工作区” from the sidebar?');
    expect(dialog?.detail).toContain(path);
    expect(dialog?.detail).toContain('2 sessions and 1 background tasks');
    expect(dialog?.buttons).toEqual(['Stop and remove', 'Cancel']);
    expect(dialog?.defaultId).toBe(1);
    expect(dialog?.cancelId).toBe(1);
  });

  it('removes the project once the user confirms', async () => {
    const { core, removed } = fakeCore({ sessions: 0, tasks: 3 });
    const done = await removeWorkspace(core, t, () => Promise.resolve(0), path);
    expect(done).toBe(true);
    expect(removed).toEqual([path]);
  });

  it('asks in the interface language', async () => {
    const { core } = fakeCore({ sessions: 1, tasks: 0 });
    let message: string | undefined;
    await removeWorkspace(
      core,
      new Translator('zh-CN'),
      (options) => {
        message = options.message;
        return Promise.resolve(1);
      },
      path,
    );
    expect(message).toBe('从侧栏移除“work space 工作区”？');
  });

  it('names a Windows path by its last segment', () => {
    expect(projectName('C:\\Users\\me\\项目')).toBe('项目');
    expect(projectName('/srv/app/')).toBe('app');
  });
});
