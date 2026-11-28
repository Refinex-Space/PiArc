// Ported from ego-browser package/ego-browser/src/helpers.test.mjs (ego-lite commit 56589ea8, MIT,
// see LICENSE). PiArc: Vitest; FakeBindings instead of ad-hoc FakeEgo objects (their native
// answers keep upstream's partial shapes, and the CDP bridge is switched off as upstream's fakes
// had none); only the v2 helpers are ported, so the switchTaskSpace, newTaskSpace,
// useOrCreateTaskSpace, completeTaskSpace, handOffTaskSpace and waitForAgentControl tests are
// dropped; the surface test checks the v2 helpers; requestAccess and help() tests are added.

import { afterEach, expect, test } from 'vitest';

import type { TabInfo } from '../../shared/browser-host.js';
import { FakeBindings, installBindings, type FakeBindingsOptions } from '../testing.js';
import { clearPreferredTarget, invalidateSession } from './browser-runtime.js';
import * as helperExports from './helpers.js';
import {
  claimTaskSpace,
  helperContext,
  listTaskSpaces,
  profiles,
  requestAccess,
  takeOverTaskSpace,
  taskSpace,
} from './helpers.js';
import { resetSink } from './output-sink.js';

afterEach(() => {
  invalidateSession();
  clearPreferredTarget();
  resetSink();
});

/**
 * A FakeBindings without the CDP bridge: upstream's fakes have no sendCDPMessage, so
 * background Page discovery stays off and the native call sequence is what the tests assert.
 */
function fakeEgo(options: FakeBindingsOptions): FakeBindings {
  const fake = new FakeBindings(options);
  Reflect.set(fake, 'sendCDPMessage', undefined);
  return fake;
}

async function withEgo(ego: FakeBindings, fn: () => Promise<void>): Promise<void> {
  const restore = installBindings(ego);
  try {
    await fn();
  } finally {
    restore();
  }
}

/** The calls to the bindings an upstream fake implemented, in order. */
function callsTo(ego: FakeBindings, names: readonly string[]): unknown[][] {
  return ego.calls.filter(([name]) => names.includes(name));
}

/** A native answer in a shape PiArc's typed bindings would not produce (upstream's partial ones). */
function answer<T>(value: unknown): Promise<T> {
  return Promise.resolve(value as T);
}

function tab(targetId: string, extra: Partial<TabInfo> = {}): TabInfo {
  return {
    index: 0,
    targetId,
    url: 'about:blank',
    title: '',
    active: false,
    openedBy: 'unknown',
    ...extra,
  };
}

test('listTaskSpaces normalizes the current taskSpaces binding shape', async () => {
  const space = {
    taskId: 'checkout-flow',
    id: 7,
    name: 'Checkout flow',
    createdBy: 'agent',
    ownership: 'agent',
    recentTabTitles: ['Checkout', 'Cart'],
  } as const;
  await withEgo(
    fakeEgo({
      listTaskSpaces: () => Promise.resolve({ taskSpaces: [space] }),
    }),
    async () => {
      expect(await listTaskSpaces()).toEqual([space]);
    },
  );
});

test('listTaskSpaces preserves claimable user-created space metadata', async () => {
  const userSpace = {
    taskId: 'research',
    id: 3,
    name: 'research',
    createdBy: 'user',
    ownership: 'user',
    profileId: 'Default',
    profileName: 'Work',
    recentTabTitles: ['Project notes', 'Reference'],
  } as const;
  await withEgo(
    fakeEgo({
      listTaskSpaces: () => answer({ taskSpaces: [userSpace] }),
    }),
    async () => {
      expect(await listTaskSpaces()).toEqual([userSpace]);
    },
  );
});

test('listTaskSpaces keeps unnamed user spaces, including id 0', async () => {
  const unnamed = (id: number) =>
    ({
      createdBy: 'user',
      id,
      name: '',
      ownership: 'user',
      profileId: 'Profile 4',
      recentTabTitles: ['New Tab'],
      taskId: '',
    }) as const;
  const named = { ...unnamed(10), name: 'Space-2', taskId: 'Space-2' };
  await withEgo(
    fakeEgo({
      listTaskSpaces: () => answer({ taskSpaces: [unnamed(0), unnamed(8), named] }),
    }),
    async () => {
      expect(await listTaskSpaces()).toEqual([unnamed(0), unnamed(8), named]);
    },
  );
});

test('listTaskSpaces rejects legacy taskIds results', async () => {
  await withEgo(
    fakeEgo({
      listTaskSpaces: () => answer({ taskIds: ['checkout-flow', 'research-session'] }),
    }),
    async () => {
      await expect(listTaskSpaces()).rejects.toThrow(
        /listTaskSpaces expected \{ taskSpaces: \[\.\.\.\] \}/,
      );
    },
  );
});

test('listTaskSpaces throws on binding error objects', async () => {
  await withEgo(
    fakeEgo({
      listTaskSpaces: () => answer({ error: 'The task is under user control' }),
    }),
    async () => {
      await expect(listTaskSpaces()).rejects.toThrow(
        /listTaskSpaces: The task is under user control/,
      );
    },
  );
});

test('profiles returns the browser profiles exposed by Ego Lite', async () => {
  const expected = [
    { id: 'Default', name: 'Personal', isDefault: true },
    { id: 'Profile 2', name: 'Work', isDefault: false },
  ];
  await withEgo(
    fakeEgo({
      listProfiles: () => Promise.resolve({ profiles: expected }),
    }),
    async () => {
      expect(await profiles()).toEqual(expected);
    },
  );
});

test('profiles rejects malformed native results', async () => {
  await withEgo(
    fakeEgo({
      listProfiles: () => answer({ profiles: [{ id: 'Default', name: 'Personal' }] }),
    }),
    async () => {
      await expect(profiles()).rejects.toThrow(
        /profiles expected entries with id, name, and isDefault/,
      );
    },
  );
});

test('taskspace helper surface exposes public helpers including claimTaskSpace', () => {
  const context = helperContext();
  expect(context.showTaskState).toBeUndefined();
  expect(typeof context.taskSpace).toBe('function');
  expect(typeof context.profiles).toBe('function');
  expect(typeof context.listTaskSpaces).toBe('function');
  expect(typeof context.claimTaskSpace).toBe('function');
  expect(typeof context.takeOverTaskSpace).toBe('function');
  expect(typeof context.requestAccess).toBe('function');
  expect(typeof context.help).toBe('function');
  // The frozen v1 surface is not part of the port.
  for (const name of [
    'switchTaskSpace',
    'newTaskSpace',
    'useOrCreateTaskSpace',
    'completeTaskSpace',
    'handOffTaskSpace',
    'waitForAgentControl',
    'openOrReuseTab',
    'closeTab',
    'newTab',
    'elementEval',
    'cdp',
    'js',
    'cliLog',
    'egoBrowser',
  ]) {
    expect(name in context, name).toBe(false);
    expect(name in helperExports, name).toBe(false);
  }
});

test('taskSpace returns the new object model for a resolved space', async () => {
  await withEgo(
    fakeEgo({
      listTaskSpaces: () =>
        answer({
          taskSpaces: [{ taskId: 'research', id: 7, name: 'Research', ownership: 'agent' }],
        }),
    }),
    async () => {
      const task = await taskSpace('research');
      expect(task.id).toBe(7);
      expect(task.spaceId).toBe(7);
      expect(task.name).toBe('Research');
      expect(task.ownership).toBe('agent');
      expect(typeof task.newPage).toBe('function');
      expect(Reflect.get(task, 'openPage')).toBeUndefined();
      expect(typeof task.page).toBe('function');
      expect(typeof task.pages).toBe('function');
      expect(typeof task.tabs).toBe('function');
      expect(Reflect.get(task, 'listPages')).toBeUndefined();
      expect(typeof task.adopt).toBe('function');
      expect(typeof task.release).toBe('function');
      expect(typeof task.handOff).toBe('function');
      expect(typeof task.finish).toBe('function');
      expect(Reflect.get(task, 'close')).toBeUndefined();
    },
  );
});

test('taskSpace creates a new space with an explicit browser profile', async () => {
  const ego = fakeEgo({
    listTaskSpaces: () => Promise.resolve({ taskSpaces: [] }),
    createTaskSpace: (name) => answer({ taskId: name, id: 8, name }),
    listTabs: () => Promise.resolve({ tabs: [tab('target-profile-initial')] }),
  });
  await withEgo(ego, async () => {
    const task = await taskSpace('work research', { profileId: 'Profile 2' });
    expect(task.spaceId).toBe(8);
    expect(task.name).toBe('work research');
  });
  expect(callsTo(ego, ['listTaskSpaces', 'createTaskSpace', 'useTaskSpace', 'listTabs'])).toEqual([
    ['listTaskSpaces'],
    ['createTaskSpace', 'work research', 'Profile 2'],
    ['useTaskSpace', 8],
    ['listTabs'],
  ]);
});

test('task-space helpers reject invalid locators before any native call', async () => {
  const unexpected = (name: string) => () => Promise.reject(new Error(`unexpected ${name}`));
  const ego = fakeEgo({
    listTaskSpaces: unexpected('listTaskSpaces'),
    createTaskSpace: unexpected('createTaskSpace'),
    claimTaskSpace: unexpected('claimTaskSpace'),
    useTaskSpace: () => {
      throw new Error('unexpected useTaskSpace');
    },
  });
  const invalid: unknown[] = [undefined, null, '', '   ', {}, NaN, 1.5];
  await withEgo(ego, async () => {
    for (const value of invalid) {
      let thrown: unknown;
      try {
        await taskSpace(value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      expect(String(thrown)).toMatch(
        /taskSpace expects a task-space name \(non-empty string\) or numeric id/,
      );
      expect(String(thrown)).toMatch(/pass entry\.id/);
      await expect(claimTaskSpace(value)).rejects.toThrow(TypeError);
    }
    await expect(taskSpace(undefined, { profileId: 'Profile 2' })).rejects.toThrow(
      /taskSpace expects a task-space name/,
    );
  });
  expect(ego.calls).toEqual([]);
});

test("taskSpace manages a newly created space's default tab as p1", async () => {
  const ego = fakeEgo({
    listTaskSpaces: () => Promise.resolve({ taskSpaces: [] }),
    createTaskSpace: (name) => answer({ taskId: name, id: 9, name }),
    listTabs: () =>
      Promise.resolve({
        tabs: [
          tab('target-initial', {
            url: 'chrome://newtab/',
            title: 'New Tab',
            active: true,
          }),
        ],
      }),
  });
  await withEgo(ego, async () => {
    const task = await taskSpace('fresh research');
    const pages = await task.pages();
    expect(pages).toHaveLength(1);
    expect(pages[0]?.label).toBe('p1');
    expect(pages[0]?.targetId).toBe('target-initial');
    expect(pages[0]?.openedBy).toBe('agent');
  });
  expect(callsTo(ego, ['listTaskSpaces', 'createTaskSpace', 'useTaskSpace', 'listTabs'])).toEqual([
    ['listTaskSpaces'],
    ['createTaskSpace', 'fresh research'],
    ['useTaskSpace', 9],
    ['listTabs'],
    ['useTaskSpace', 9],
    ['listTabs'],
  ]);
});

test('resolving an existing v2 space cannot interrupt fresh p1 discovery', async () => {
  let releaseFirstInventory: () => void = () => undefined;
  let reportFirstInventory: () => void = () => undefined;
  const firstInventoryStarted = new Promise<void>((resolve) => {
    reportFirstInventory = resolve;
  });
  const firstInventoryRelease = new Promise<void>((resolve) => {
    releaseFirstInventory = resolve;
  });
  let inventoryCalls = 0;

  const ego: FakeBindings = fakeEgo({
    listTaskSpaces: () =>
      answer({
        taskSpaces: [{ taskId: 'existing', id: 12, name: 'existing', ownership: 'agent' }],
      }),
    createTaskSpace: (name) => answer({ taskId: name, id: 11, name }),
    listTabs: async () => {
      inventoryCalls += 1;
      if (inventoryCalls === 1) {
        reportFirstInventory();
        await firstInventoryRelease;
      }
      return {
        tabs: [tab(ego.selectedSpace === 11 ? 'target-fresh' : 'target-existing')],
      };
    },
  });
  await withEgo(ego, async () => {
    const freshPromise = taskSpace('fresh concurrent');
    await firstInventoryStarted;
    const existing = await taskSpace(12);
    expect(existing.spaceId).toBe(12);
    releaseFirstInventory();

    const fresh = await freshPromise;
    const pages = await fresh.pages();
    expect(pages.map((page) => [page.label, page.targetId])).toEqual([['p1', 'target-fresh']]);
  });
});

test('taskSpace closes a new space when its default tab is ambiguous', async () => {
  const ego = fakeEgo({
    listTaskSpaces: () => Promise.resolve({ taskSpaces: [] }),
    createTaskSpace: (name) => answer({ taskId: name, id: 10, name }),
    listTabs: () => Promise.resolve({ tabs: [tab('target-a'), tab('target-b')] }),
  });
  await withEgo(ego, async () => {
    await expect(taskSpace('ambiguous runtime')).rejects.toThrow(
      /new task space expected one default tab, found 2/,
    );
  });
  expect(
    callsTo(ego, [
      'listTaskSpaces',
      'createTaskSpace',
      'useTaskSpace',
      'listTabs',
      'closeTaskSpace',
    ]),
  ).toEqual([
    ['listTaskSpaces'],
    ['createTaskSpace', 'ambiguous runtime'],
    ['useTaskSpace', 10],
    ['listTabs'],
    ['useTaskSpace', 10],
    ['closeTaskSpace'],
  ]);
});

test('taskSpace does not reuse an existing name when a profile is explicit', async () => {
  const ego = fakeEgo({
    listTaskSpaces: () =>
      answer({
        taskSpaces: [{ taskId: 'work research', id: 7, name: 'work research', ownership: 'agent' }],
      }),
    createTaskSpace: (name) => answer({ taskId: name, id: 8, name }),
  });
  await withEgo(ego, async () => {
    await expect(taskSpace('work research', { profileId: 'Profile 2' })).rejects.toThrow(
      /profileId only applies when creating a new task space.*already exists/,
    );
  });
  expect(callsTo(ego, ['listTaskSpaces', 'createTaskSpace', 'useTaskSpace'])).toEqual([
    ['listTaskSpaces'],
  ]);
});

test('taskSpace rejects profile selection when resuming a numeric space id', async () => {
  await withEgo(
    fakeEgo({
      listTaskSpaces: () => Promise.reject(new Error('must not inspect spaces')),
    }),
    async () => {
      await expect(taskSpace(7, { profileId: 'Profile 2' })).rejects.toThrow(
        /profileId can only be used with a new task-space name/,
      );
    },
  );
});

test('taskSpace rejects empty profile ids before calling Ego Lite', async () => {
  await withEgo(
    fakeEgo({
      listTaskSpaces: () => Promise.reject(new Error('must not inspect spaces')),
    }),
    async () => {
      await expect(taskSpace('work research', { profileId: '' })).rejects.toThrow(
        /taskSpace profileId must be a non-empty string/,
      );
    },
  );
});

test('taskSpace reports a user-owned name as EGO_TASK_SPACE_NAME_IN_USE', async () => {
  const ego = fakeEgo({
    listTaskSpaces: () =>
      answer({
        taskSpaces: [{ taskId: 'checkout-flow', id: 7, name: 'checkout-flow', ownership: 'user' }],
      }),
  });
  await withEgo(ego, async () => {
    let thrown: unknown;
    try {
      await taskSpace('checkout-flow');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ error_code: 'EGO_TASK_SPACE_NAME_IN_USE' });
    expect(String(thrown)).toMatch(/^Error: taskSpace: A task space named/);
  });
  expect(callsTo(ego, ['listTaskSpaces', 'useTaskSpace', 'createTaskSpace'])).toEqual([
    ['listTaskSpaces'],
  ]);
});

test('claimTaskSpace returns a TaskSpace after claiming and selecting', async () => {
  const ego = fakeEgo({
    listTaskSpaces: () =>
      answer({
        taskSpaces: [{ taskId: 'checkout-flow', id: 7, name: 'checkout-flow', ownership: 'user' }],
      }),
    claimTaskSpace: (id, name) => answer({ taskId: name, id, name }),
    listTabs: () => Promise.resolve({ tabs: [] }),
  });
  await withEgo(ego, async () => {
    const task = await claimTaskSpace('checkout-flow');
    expect(JSON.parse(JSON.stringify(task))).toEqual({
      taskId: 'checkout-flow',
      id: 7,
      name: 'checkout-flow',
      ownership: 'agent',
    });
    expect(task.spaceId).toBe(7);
    expect(typeof task.newPage).toBe('function');
  });
  expect(callsTo(ego, ['listTaskSpaces', 'claimTaskSpace', 'useTaskSpace', 'listTabs'])).toEqual([
    ['listTaskSpaces'],
    ['claimTaskSpace', 7, 'checkout-flow'],
    ['useTaskSpace', 7],
    ['useTaskSpace', 7],
    ['listTabs'],
  ]);
});

test('claimTaskSpace claims an unnamed user space without renaming it', async () => {
  const ego = fakeEgo({
    listTaskSpaces: () =>
      answer({ taskSpaces: [{ taskId: '', id: 0, name: '', ownership: 'user' }] }),
    claimTaskSpace: (id) => answer({ taskId: '', id, name: '' }),
    listTabs: () => Promise.resolve({ tabs: [] }),
  });
  await withEgo(ego, async () => {
    const task = await claimTaskSpace(0);
    expect(task.spaceId).toBe(0);
    expect(task.name).toBe('');
  });
  expect(callsTo(ego, ['claimTaskSpace'])).toEqual([['claimTaskSpace', 0]]);
});

test('takeOverTaskSpace returns a TaskSpace when a space is specified', async () => {
  const ego = fakeEgo({
    listTaskSpaces: () =>
      answer({
        taskSpaces: [
          {
            taskId: 'checkout-flow',
            id: 7,
            name: 'checkout-flow',
            ownership: 'agentDelegatedToUser',
          },
        ],
      }),
    listTabs: () => Promise.resolve({ tabs: [] }),
  });
  await withEgo(ego, async () => {
    const task = await takeOverTaskSpace(7);
    expect(task?.spaceId).toBe(7);
    expect(task?.ownership).toBe('agent');
    expect(typeof task?.newPage).toBe('function');
  });
  expect(callsTo(ego, ['listTaskSpaces', 'useTaskSpace', 'takeOverTaskSpace', 'listTabs'])).toEqual(
    [
      ['listTaskSpaces'],
      ['useTaskSpace', 7],
      ['takeOverTaskSpace'],
      ['useTaskSpace', 7],
      ['listTabs'],
    ],
  );
});

test('takeOverTaskSpace does not invent a user boundary when Agent already controls the space', async () => {
  const ego = fakeEgo({
    listTaskSpaces: () =>
      answer({
        taskSpaces: [{ taskId: 'checkout-flow', id: 7, name: 'checkout-flow', ownership: 'agent' }],
      }),
    listTabs: () => Promise.resolve({ tabs: [] }),
  });
  await withEgo(ego, async () => {
    const task = await takeOverTaskSpace(7);
    expect(task).toBeDefined();
    expect(task?.userPage()).toBeUndefined();
  });
  expect(callsTo(ego, ['listTaskSpaces', 'useTaskSpace', 'takeOverTaskSpace', 'listTabs'])).toEqual(
    [['listTaskSpaces'], ['useTaskSpace', 7], ['takeOverTaskSpace']],
  );
});

test('takeOverTaskSpace without a space keeps the selected space and answers nothing', async () => {
  const ego = fakeEgo({});
  await withEgo(ego, async () => {
    expect(await takeOverTaskSpace()).toBeUndefined();
  });
  expect(callsTo(ego, ['listTaskSpaces', 'useTaskSpace', 'takeOverTaskSpace'])).toEqual([
    ['takeOverTaskSpace'],
  ]);
});

test('claimTaskSpace throws on an unknown task space', async () => {
  const ego = fakeEgo({
    listTaskSpaces: () => Promise.resolve({ taskSpaces: [] }),
    claimTaskSpace: (id, name) => answer({ taskId: name, id, name, ownership: 'agent' }),
  });
  await withEgo(ego, async () => {
    await expect(claimTaskSpace('checkout-flow')).rejects.toThrow(
      /task space not found: checkout-flow/,
    );
  });
  expect(callsTo(ego, ['listTaskSpaces', 'claimTaskSpace'])).toEqual([['listTaskSpaces']]);
});

test('requestAccess validates its arguments before asking the user', async () => {
  const ego = fakeEgo({});
  await withEgo(ego, async () => {
    for (const hosts of [[], [''], ['  '], [7], undefined, {}]) {
      await expect(requestAccess(hosts, 'load the product images')).rejects.toThrow(
        /requestAccess expects a host name or a non-empty array of host names/,
      );
    }
    for (const reason of [undefined, '', '   ', 3]) {
      await expect(requestAccess(['cdn.example.test'], reason)).rejects.toThrow(
        /requestAccess expects a non-empty reason the user will read/,
      );
    }
  });
  expect(ego.calls).toEqual([]);
});

test('requestAccess asks the bindings and answers the decision', async () => {
  const decisions = [true, false];
  const ego = fakeEgo({
    requestAccess: () => Promise.resolve(decisions.shift() ?? false),
  });
  await withEgo(ego, async () => {
    expect(await requestAccess('cdn.example.test', 'load the product images')).toBe(true);
    expect(
      await requestAccess(['api.example.test', 'img.example.test'], 'read the price list'),
    ).toBe(false);
  });
  expect(ego.calls).toEqual([
    ['requestAccess', ['cdn.example.test'], 'load the product images'],
    ['requestAccess', ['api.example.test', 'img.example.test'], 'read the price list'],
  ]);
});

test('requestAccess throws the binding error with its code', async () => {
  await withEgo(
    fakeEgo({
      requestAccess: () =>
        Promise.resolve({ error: 'the run has ended', error_code: 'PIARC_RUN_ENDED' }),
    }),
    async () => {
      await expect(requestAccess('cdn.example.test', 'images')).rejects.toMatchObject({
        message: 'requestAccess: the run has ended',
        error_code: 'PIARC_RUN_ENDED',
      });
    },
  );
});

test('the embedded SDK prints help() through the host printer and returns the text', () => {
  const lines: string[] = [];
  const context = helperContext({
    printHelp: (text) => {
      lines.push(text);
    },
  });
  const help = context.help;
  if (typeof help !== 'function') throw new Error('help is not a function');

  const text: unknown = Reflect.apply(help, undefined, ['TaskSpace.newPage']);

  expect(text).toBe(
    'TaskSpace.newPage\n\nCreate and durably label a blank Page.\n\nawait task.newPage()',
  );
  expect(lines).toEqual([text]);
});
