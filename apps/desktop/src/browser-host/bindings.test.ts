import { describe, expect, test } from 'vitest';

import type {
  BrowserHostApi,
  BrowserHostRequest,
  BrowserHostResult,
  BrowserHostRun,
} from '../shared/browser-host.js';
import { createEgoBindings } from './bindings.js';

/** A `window.piarcBrowserHost` double: answers each op from a table and records requests. */
class FakeHostApi implements BrowserHostApi {
  readonly requests: BrowserHostRequest[] = [];
  readonly finished: BrowserHostResult[] = [];
  cdpListener: ((message: string) => void) | undefined;
  runListener: ((run: BrowserHostRun) => void) | undefined;
  readonly #answers: Partial<Record<BrowserHostRequest['op'], unknown>>;

  /** An `Error` answer rejects the call with it; anything else resolves. */
  constructor(answers: Partial<Record<BrowserHostRequest['op'], unknown>> = {}) {
    this.#answers = answers;
  }

  call(request: BrowserHostRequest): Promise<unknown> {
    this.requests.push(request);
    const answer = this.#answers[request.op];
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer ?? null);
  }

  onCdp(listener: (message: string) => void): void {
    this.cdpListener = listener;
  }

  onRun(listener: (run: BrowserHostRun) => void): void {
    this.runListener = listener;
  }

  finish(result: BrowserHostResult): void {
    this.finished.push(result);
  }
}

const TAB = {
  index: 0,
  targetId: 'target-1',
  url: 'https://example.test/',
  title: 'Example',
  active: true,
  openedBy: 'agent',
} as const;

const SPACE = {
  id: 3,
  name: 'research',
  taskId: 'research',
  ownership: 'agent',
  createdBy: 'agent',
  recentTabTitles: ['Example'],
} as const;

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('createEgoBindings', () => {
  test('task-scoped calls name the selected Space and need a selection first', async () => {
    const api = new FakeHostApi({ listTabs: { tabs: [TAB] }, closeTaskSpace: '3 closed.' });
    const ego = createEgoBindings(api);

    expect(await ego.listTabs()).toEqual({
      error: 'Task space not selected',
      error_code: 'EGO_TASK_SPACE_NOT_SELECTED',
    });
    expect(api.requests).toEqual([]);

    expect(ego.useTaskSpace(3)).toBe(3);
    expect(await ego.listTabs()).toEqual({ tabs: [TAB] });
    expect(await ego.closeTaskSpace()).toBe('3 closed.');
    expect(api.requests).toEqual([
      { op: 'listTabs', space: 3 },
      { op: 'closeTaskSpace', space: 3 },
    ]);
  });

  test('the default Space is selected until the script selects another', async () => {
    const api = new FakeHostApi({ listTabs: [TAB] });
    const ego = createEgoBindings(api, { defaultSpace: 5 });

    expect(await ego.listTabs()).toEqual({ tabs: [TAB] });
    ego.useTaskSpace(6);
    await ego.listTabs();
    expect(api.requests).toEqual([
      { op: 'listTabs', space: 5 },
      { op: 'listTabs', space: 6 },
    ]);
  });

  test('useTaskSpace rejects a non-numeric id with ego invalid-argument errors', () => {
    const ego = createEgoBindings(new FakeHostApi());
    let thrown: unknown;
    try {
      ego.useTaskSpace('3' as unknown as number);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toMatchObject({ error_code: 'EGO_INVALID_ARGUMENT' });
  });

  test('host failures resolve as ego error objects and keep the user-control reason key', async () => {
    const api = new FakeHostApi({
      createTab: {
        error: 'The user is handling a location prompt',
        error_code: 'EGO_TASK_SPACE_USER_IN_CONTROL',
        reason: 'location',
      },
      listTaskSpaces: { error: 'run ended', error_code: 'PIARC_RUN_ENDED' },
    });
    const ego = createEgoBindings(api, { defaultSpace: 1 });

    expect(await ego.createTab('https://example.test/')).toEqual({
      error: 'location',
      error_code: 'EGO_TASK_SPACE_USER_IN_CONTROL',
    });
    expect(await ego.listTaskSpaces()).toEqual({
      error: 'run ended',
      error_code: 'PIARC_RUN_ENDED',
    });
  });

  test('an IPC rejection becomes an operation failure, not a thrown error', async () => {
    const ego = createEgoBindings(new FakeHostApi({ listProfiles: new Error('channel closed') }));
    expect(await ego.listProfiles()).toEqual({
      error: 'channel closed',
      error_code: 'EGO_OPERATION_FAILED',
    });
  });

  test('answers that do not match the contract are reported as invalid payloads', async () => {
    const ego = createEgoBindings(
      new FakeHostApi({ listTabs: [{ targetId: 7 }], attachImage: 'one' }),
      { defaultSpace: 1 },
    );
    expect(await ego.listTabs()).toEqual({
      error: 'listTabs returned an invalid result',
      error_code: 'EGO_INVALID_RESULT_PAYLOAD',
    });
    expect(
      await ego.attachImage({ base64: 'AA==', mediaType: 'image/png', width: 1, height: 1 }),
    ).toEqual({
      error: 'attachImage returned an invalid result',
      error_code: 'EGO_INVALID_RESULT_PAYLOAD',
    });
  });

  test('task spaces, profiles and created tabs are normalized to ego shapes', async () => {
    const api = new FakeHostApi({
      listTaskSpaces: [SPACE],
      listProfiles: { profiles: [{ id: 'Default', name: 'Default', isDefault: true }] },
      createTaskSpace: SPACE,
      createTab: { targetId: 'target-2' },
    });
    const ego = createEgoBindings(api, { defaultSpace: 3 });

    expect(await ego.listTaskSpaces()).toEqual({ taskSpaces: [SPACE] });
    expect(await ego.listProfiles()).toEqual({
      profiles: [{ id: 'Default', name: 'Default', isDefault: true }],
    });
    expect(await ego.createTaskSpace('research')).toEqual(SPACE);
    expect(await ego.createTab('about:blank')).toMatchObject({ targetId: 'target-2' });
  });

  test('createTaskSpace accepts only the default profile locators', async () => {
    const api = new FakeHostApi({ createTaskSpace: SPACE });
    const ego = createEgoBindings(api);

    expect(await ego.createTaskSpace('research', 'default')).toEqual(SPACE);
    expect(await ego.createTaskSpace('research', 'Profile 2')).toEqual({
      error: 'Profile not found',
      error_code: 'EGO_PROFILE_NOT_FOUND',
    });
    expect(api.requests).toEqual([{ op: 'createTaskSpace', name: 'research' }]);
  });

  test('snapshot names the tab, falls back to the active one and rejects failures', async () => {
    const snapshot = {
      content: 'button "Go" [ref=1]',
      refs: [{ refId: 1, backendNodeId: 9, role: 'button', name: 'Go' }],
      truncated: false,
    };
    const api = new FakeHostApi({ listTabs: { tabs: [TAB] }, snapshot });
    const ego = createEgoBindings(api, { defaultSpace: 2 });

    expect(await ego.snapshot({ targetId: 'target-9', scope: 'full_page' })).toEqual(snapshot);
    expect(await ego.snapshot()).toEqual(snapshot);
    expect(api.requests).toEqual([
      { op: 'snapshot', space: 2, targetId: 'target-9', options: { scope: 'full_page' } },
      { op: 'listTabs', space: 2 },
      { op: 'snapshot', space: 2, targetId: 'target-1', options: {} },
    ]);

    const failing = createEgoBindings(
      new FakeHostApi({
        snapshot: { error: 'Snapshot failed', error_code: 'EGO_SNAPSHOT_FAILED' },
      }),
      { defaultSpace: 2 },
    );
    await expect(failing.snapshot({ targetId: 'target-1' })).rejects.toMatchObject({
      message: 'Snapshot failed',
      error_code: 'EGO_SNAPSHOT_FAILED',
    });
    await expect(createEgoBindings(new FakeHostApi()).snapshot()).rejects.toMatchObject({
      error_code: 'EGO_TASK_SPACE_NOT_SELECTED',
    });
  });

  test('the highlight op carries the target, or the active tab when none is given', async () => {
    const api = new FakeHostApi({ listTabs: { tabs: [TAB] }, highlight: null });
    const ego = createEgoBindings(api, { defaultSpace: 4 });

    await ego.animationHighlightMouseToPosition(10, 20, 'target-7');
    await ego.animationHighlightMouseToPosition(30, 40);
    expect(api.requests).toEqual([
      { op: 'highlight', space: 4, targetId: 'target-7', x: 10, y: 20 },
      { op: 'listTabs', space: 4 },
      { op: 'highlight', space: 4, targetId: 'target-1', x: 30, y: 40 },
    ]);
  });

  test('CDP messages go out with the Space and come back through onCDPMessage', () => {
    const api = new FakeHostApi({ cdp: null });
    const ego = createEgoBindings(api, { defaultSpace: 8 });
    const received: string[] = [];
    ego.onCDPMessage = (message) => {
      received.push(message);
    };

    ego.sendCDPMessage('{"id":1,"method":"Page.enable"}');
    expect(api.requests).toEqual([
      { op: 'cdp', space: 8, message: '{"id":1,"method":"Page.enable"}' },
    ]);
    api.cdpListener?.('{"id":1,"result":{}}');
    expect(received).toEqual(['{"id":1,"result":{}}']);

    // Clearing the property stops delivery, as with ego.
    ego.onCDPMessage = undefined;
    api.cdpListener?.('{"id":2,"result":{}}');
    expect(received).toEqual(['{"id":1,"result":{}}']);
  });

  test('a refused CDP send reaches onSendCDPMessageError asynchronously', async () => {
    const api = new FakeHostApi({
      cdp: {
        error: 'Storage.clearDataForOrigin is not allowed',
        error_code: 'PIARC_CDP_METHOD_REFUSED',
      },
    });
    const ego = createEgoBindings(api, { defaultSpace: 1 });
    const errors: [string, string][] = [];
    ego.onSendCDPMessageError = (message, code) => {
      errors.push([message, code]);
    };

    ego.sendCDPMessage('{"id":3,"method":"Storage.clearDataForOrigin"}');
    expect(errors).toEqual([]);
    await flush();
    await flush();
    expect(errors).toEqual([
      ['Storage.clearDataForOrigin is not allowed', 'PIARC_CDP_METHOD_REFUSED'],
    ]);
  });

  test('a rejected call keeps the failure code it carries', async () => {
    const failure = Object.assign(new Error('Snapshot failed'), {
      error: 'The page has no document',
      error_code: 'EGO_SNAPSHOT_FAILED',
    });
    const snapshotting = createEgoBindings(new FakeHostApi({ snapshot: failure }), {
      defaultSpace: 1,
    });
    await expect(snapshotting.snapshot({ targetId: 'target-1' })).rejects.toMatchObject({
      message: 'The page has no document',
      error_code: 'EGO_SNAPSHOT_FAILED',
    });

    const coded = Object.assign(new Error('gone'), { error_code: 'EGO_WEB_CONTENTS_UNAVAILABLE' });
    const listing = createEgoBindings(new FakeHostApi({ listTabs: coded }), { defaultSpace: 1 });
    expect(await listing.listTabs()).toEqual({
      error: 'gone',
      error_code: 'EGO_WEB_CONTENTS_UNAVAILABLE',
    });
  });

  test('a CDP send without a selected Space fails like ego', async () => {
    const ego = createEgoBindings(new FakeHostApi());
    const errors: string[] = [];
    ego.onSendCDPMessageError = (_message, code) => {
      errors.push(code);
    };
    ego.sendCDPMessage('{"id":1,"method":"Browser.getVersion"}');
    await flush();
    expect(errors).toEqual(['EGO_TASK_SPACE_NOT_SELECTED']);
  });

  test('PiArc bindings map to their ops and check their answers', async () => {
    const api = new FakeHostApi({
      ledgerLoad: '{"spaceId":1}',
      ledgerSave: null,
      stageUpload: ['/session/tmp/browser/uploads/a.txt'],
      saveFile: null,
      attachImage: 2,
      requestAccess: 'allow',
    });
    const ego = createEgoBindings(api);

    expect(await ego.ledgerLoad(1)).toBe('{"spaceId":1}');
    expect(await ego.ledgerSave(1, '')).toBeNull();
    expect(await ego.stageUpload(['/home/me/a.txt'])).toEqual([
      '/session/tmp/browser/uploads/a.txt',
    ]);
    expect(await ego.saveFile('guid-1', '/home/me/report.pdf')).toBeNull();
    expect(
      await ego.attachImage({ base64: 'AA==', mediaType: 'image/png', width: 4, height: 3 }),
    ).toBe(2);
    expect(await ego.requestAccess(['cdn.example.test'], 'images')).toBe(true);
    expect(api.requests).toEqual([
      { op: 'ledgerLoad', space: 1 },
      { op: 'ledgerSave', space: 1, data: '' },
      { op: 'stageUpload', paths: ['/home/me/a.txt'] },
      { op: 'saveFile', source: 'guid-1', path: '/home/me/report.pdf' },
      { op: 'attachImage', base64: 'AA==', mediaType: 'image/png', width: 4, height: 3 },
      { op: 'requestAccess', hosts: ['cdn.example.test'], reason: 'images' },
    ]);
  });

  test('a missing ledger reads as null', async () => {
    const ego = createEgoBindings(new FakeHostApi({ ledgerLoad: null }));
    expect(await ego.ledgerLoad(4)).toBeNull();
  });
});
