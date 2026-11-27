// Ported from ego-browser package/ego-browser/src/page-model.test.mjs (ego-lite commit 56589ea8,
// MIT, see LICENSE). PiArc: Vitest on page-model.fixture.ts; upstream tests 120-166 (from "Page
// keyboard accepts case-insensitive modifier names" to "Page click retries when an iframe
// disappears during session discovery"). Uploads also assert the staged paths; the download test
// uses a recording artifact instead of temp files (PiArc saves downloads through Core); snapshot
// overrides are passed per round instead of reassigning the shared fixture service.

import { expect, test } from 'vitest';

import { fakeCdp } from '../testing.js';
import { isRecord, type CdpCall, type CdpEvent, type CdpObject } from './cdp-types.js';
import type { DownloadArtifact, DownloadInterception } from './driver/downloads.js';
import { consumeUnhandledPageNotices, resetPageNotices } from './page-discovery.js';
import {
  cdpCalls,
  openTestPage,
  rejection,
  taskForRound,
  untyped,
  withFixture,
  type Fixture,
  type FixtureCall,
  type PageHandle,
  type PageModelOverrides,
} from './page-model.fixture.js';
import { PageRefRegistry } from './page-ref-registry.js';

type PageOrDownload = Awaited<ReturnType<PageHandle['waitForEvent']>>;

function asPopup(value: PageOrDownload): PageHandle {
  if (!('label' in value)) throw new TypeError('expected a popup Page');
  return value;
}

function asDownload(value: PageOrDownload): Exclude<PageOrDownload, PageHandle> {
  if ('label' in value) throw new TypeError('expected a download');
  return value;
}

function targetOf(page: PageHandle): string {
  const targetId = page.targetId;
  expect(targetId).toBeDefined();
  return targetId ?? '';
}

/** The first popup of an action receipt. */
function firstPopup(receipt: { popups?: { label: string; targetId: string }[] }): {
  label: string;
  targetId: string;
} {
  const popup = receipt.popups?.[0];
  expect(popup).toBeDefined();
  return popup ?? { label: '', targetId: '' };
}

/** Whether a recorded call is one `services.cdp` call of `method` that `matches`. */
function isCdp(
  call: FixtureCall | undefined,
  method: string,
  matches: (params: CdpObject, sessionId: string | undefined) => boolean = () => true,
): boolean {
  if (!call) return false;
  const [kind, name, params, sessionId] = call;
  return (
    kind === 'cdp' &&
    name === method &&
    isRecord(params) &&
    matches(params, typeof sessionId === 'string' ? sessionId : undefined)
  );
}

/** The params of every recorded `method` call that `matches`, in order. */
function cdpParams(
  fixture: Fixture,
  method: string,
  matches: (params: CdpObject, sessionId: string | undefined) => boolean = () => true,
): CdpObject[] {
  return cdpCalls(fixture)
    .filter((call) => call.method === method && matches(call.params, call.sessionId))
    .map((call) => call.params);
}

function declarationOf(params: CdpObject | undefined): string {
  const declaration = params?.functionDeclaration;
  return typeof declaration === 'string' ? declaration : '';
}

function numberOf(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

function eventValue(event: CdpEvent): unknown {
  const params: unknown = event.params;
  return isRecord(params) ? params.value : undefined;
}

function isWheel(call: FixtureCall | undefined): boolean {
  return isCdp(call, 'Input.dispatchMouseEvent', (params) => params.type === 'mouseWheel');
}

test('Page keyboard accepts case-insensitive modifier names', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', { platform: 'darwin' });
    const page = await openTestPage(task, 'https://example.test/first');

    await page.keyboard.press('ALT+CONTROL+META+SHIFT+A');
    await page.keyboard.press('CONTROLORMETA+A');

    const aDowns = cdpParams(
      fixture,
      'Input.dispatchKeyEvent',
      (params) => params.type === 'rawKeyDown' && params.code === 'KeyA',
    );
    expect(aDowns[0]?.modifiers).toBe(15);
    expect(aDowns[1]?.modifiers).toBe(4);
    expect(aDowns[1]?.commands).toEqual(['selectAll']);
  });
});

test('Page keyboard accepts case-insensitive named key names', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');

    await page.keyboard.press('ENTER');
    await page.keyboard.press('escape');
    await page.press('[contenteditable]', 'ARROWDOWN');

    const keyDowns = cdpParams(
      fixture,
      'Input.dispatchKeyEvent',
      (params) => params.type === 'keyDown' || params.type === 'rawKeyDown',
    );
    expect(keyDowns.map(({ code }) => code)).toEqual(['Enter', 'Escape', 'ArrowDown']);
  });
});

test('Page keyboard keeps single-character key case significant', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');

    await page.keyboard.press('a');
    await page.keyboard.press('A');

    const keyDowns = cdpParams(
      fixture,
      'Input.dispatchKeyEvent',
      (params) => params.type === 'keyDown' && params.code === 'KeyA',
    );
    expect(keyDowns.map(({ key, text }) => ({ key, text }))).toEqual([
      { key: 'a', text: 'a' },
      { key: 'A', text: 'A' },
    ]);
  });
});

test('Page keyboard maps portable editing shortcuts on Windows', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', { platform: 'win32' });
    const page = await openTestPage(task, 'https://example.test/first');

    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('ControlOrMeta+C');
    await page.keyboard.press('ControlOrMeta+V');
    await page.keyboard.press('ControlOrMeta+Z');
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Control+End');

    const keyDowns = cdpParams(
      fixture,
      'Input.dispatchKeyEvent',
      (params) => params.type === 'rawKeyDown',
    );
    for (const code of ['KeyA', 'KeyC', 'KeyV', 'KeyZ', 'Home', 'End']) {
      const keyDown = keyDowns.find((params) => params.code === code);
      expect(keyDown, `${code} must be dispatched on Windows`).toBeDefined();
      expect(keyDown?.modifiers, `${code} must carry Control`).toBe(2);
      expect(keyDown?.commands, "Windows relies on Chromium's native shortcut handling").toEqual(
        [],
      );
    }
  });
});

test('Page keyboard type emits physical keys when possible and inserts unsupported text', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', { platform: 'darwin' });
    const page = await openTestPage(task, 'https://example.test/first');

    await page.keyboard.type('Aé', { delay: 12 });

    expect(
      cdpParams(fixture, 'Input.dispatchKeyEvent').some(
        (params) => params.type === 'keyDown' && params.code === 'KeyA' && params.text === 'A',
      ),
    ).toBe(true);
    expect(cdpParams(fixture, 'Input.insertText').some((params) => params.text === 'é')).toBe(true);
  });
});

test('Page keyboard releases pressed modifiers when a chord fails', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', { platform: 'darwin' });
    const page = await openTestPage(task, 'https://example.test/first');

    await expect(page.keyboard.press('Shift+DefinitelyUnknown')).rejects.toThrow(/Unknown key/);
    await page.keyboard.type('a');

    const aDown = cdpParams(
      fixture,
      'Input.dispatchKeyEvent',
      (params) => params.type === 'keyDown' && params.code === 'KeyA',
    )[0];
    expect(aDown?.key).toBe('a');
    expect(aDown?.text).toBe('a');
    expect(aDown?.modifiers).toBe(0);
  });
});

test('Page keyboard suggests Playwright arrow-key names', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');

    for (const [legacy, supported] of [
      ['Left', 'ArrowLeft'],
      ['Right', 'ArrowRight'],
      ['Up', 'ArrowUp'],
      ['Down', 'ArrowDown'],
    ] as const) {
      await expect(page.keyboard.press(legacy)).rejects.toThrow(
        new RegExp(`Unknown key: "${legacy}"\\. Use "${supported}"`),
      );
    }
  });
});

test('low-level Page input skips action observers and returns no receipt', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', { platform: 'darwin' });
    const page = await openTestPage(task, 'https://example.test/first');
    fixture.calls.length = 0;

    // The static types already say void; the runtime values are what is checked.
    const answer = (action: Promise<unknown>): Promise<unknown> => action;
    expect(await answer(page.mouse.move(10, 20))).toBeUndefined();
    expect(await answer(page.mouse.down())).toBeUndefined();
    expect(await answer(page.mouse.up())).toBeUndefined();
    expect(await answer(page.mouse.wheel(0, 30))).toBeUndefined();
    expect(await answer(page.keyboard.down('Shift'))).toBeUndefined();
    expect(await answer(page.keyboard.up('Shift'))).toBeUndefined();
    expect(await answer(page.keyboard.type('a'))).toBeUndefined();
    expect(await answer(page.keyboard.insertText('é'))).toBeUndefined();
    expect(
      cdpParams(fixture, 'Runtime.evaluate').some((params) =>
        String(params.expression).includes('__egoBrowserActionProbes'),
      ),
      'low-level input must not inject action-observation state into the page',
    ).toBe(false);
  });
});

test('Page keyboard omits synthetic dispatch while file input stays target-scoped', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const first = await openTestPage(task, 'https://example.test/first');
    await openTestPage(task, 'https://example.test/second');

    expect(Reflect.get(first.keyboard, 'dispatch')).toBeUndefined();
    await first.setInputFiles('#upload', ['/tmp/one.txt', '/tmp/two.txt']);

    const uploadCall = cdpCalls(fixture).find(({ method }) => method === 'DOM.setFileInputFiles');
    expect(uploadCall?.params.files).toEqual(['/tmp/one.txt', '/tmp/two.txt']);
    expect(uploadCall?.sessionId).toBe(`session:${targetOf(first)}`);
    expect(fixture.activeTarget()).toBe(first.targetId);
    // PiArc: the paths reach CDP only after Core staged them.
    expect(fixture.stagedUploads).toEqual([['/tmp/one.txt', '/tmp/two.txt']]);
  });
});

test('Page.setInputFiles resolves labels without opening a system chooser', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/upload');

    await page.setInputFiles('label[for=upload]', ['/tmp/one.txt', '/tmp/two.txt']);

    const resolveCall = cdpParams(fixture, 'Runtime.callFunctionOn').find((params) =>
      declarationOf(params).includes('resolveFileInputForUpload'),
    );
    expect(resolveCall, 'the resolved element is normalized to its file input').toBeDefined();
    const uploadCall = cdpParams(fixture, 'DOM.setFileInputFiles')[0];
    expect(uploadCall).toEqual({
      files: ['/tmp/one.txt', '/tmp/two.txt'],
      objectId: `file-input:${targetOf(page)}`,
    });
    expect(fixture.systemFileChooserOpened()).toBe(false);

    await page.setInputFiles('#upload', []);
    const uploadCalls = cdpParams(fixture, 'DOM.setFileInputFiles');
    expect(uploadCalls.at(-1)?.files).toEqual([]);
  });
});

test('Page.waitForFileChooser handles a dynamically created file input', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/dynamic-upload');
    fixture.openFileChooserOnNextClick({
      backendNodeId: 91,
      mode: 'selectMultiple',
    });

    const chooserPromise = page.waitForFileChooser({ timeout: 1_234 });
    await page.click('#open-upload');
    const chooser = await chooserPromise;
    expect(chooser.isMultiple()).toBe(true);
    await chooser.setFiles(['/tmp/one.txt', '/tmp/two.txt']);

    const prepared = fixture.calls.find(([kind]) => kind === 'prepareFileChooser');
    expect(prepared).toEqual([
      'prepareFileChooser',
      `session:${targetOf(page)}`,
      { timeoutMs: 1_234, cancel: false },
    ]);
    const uploadCall = cdpParams(
      fixture,
      'DOM.setFileInputFiles',
      (params) => params.backendNodeId === 91,
    )[0];
    expect(uploadCall?.files).toEqual(['/tmp/one.txt', '/tmp/two.txt']);
    expect(fixture.systemFileChooserOpened()).toBe(false);
  });
});

test('FileChooser.setFiles returns a dialog opened by the upload', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/dynamic-upload');
    fixture.openFileChooserOnNextClick({ backendNodeId: 93 });
    fixture.openDialogOnNextFileSet();

    const chooserPromise = page.waitForFileChooser();
    await page.click('#open-upload');
    const chooser = await chooserPromise;

    expect(await chooser.setFiles('/tmp/project.sb3')).toEqual({
      dialog: {
        type: 'confirm',
        message: 'Replace the current project?',
        url: 'https://example.test/upload',
      },
    });
    expect(await page.acceptDialog()).toBe(true);
  });
});

test('FileChooser.setFiles uses the current Page session after reconnect', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/dynamic-upload');
    fixture.openFileChooserOnNextClick({ backendNodeId: 92 });

    const chooserPromise = page.waitForFileChooser();
    await page.click('#open-upload');
    const chooser = await chooserPromise;
    fixture.setSession(targetOf(page), 'fresh-upload-session');

    await chooser.setFiles('/tmp/fresh.txt');

    const uploadCall = cdpCalls(fixture).find(
      ({ method, params }) => method === 'DOM.setFileInputFiles' && params.backendNodeId === 92,
    );
    expect(uploadCall?.sessionId).toBe('fresh-upload-session');
  });
});

test('unhandled file choosers are cancelled before a system dialog appears', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/upload-guard');
    fixture.openFileChooserOnNextClick();

    const error = await rejection(page.click('#open-upload'));
    expect(Reflect.get(error, 'code')).toBe('EGO_FILE_CHOOSER_OPENED');
    expect(error.message).toMatch(/page\.setInputFiles/);
    expect(error.message).toMatch(/page\.waitForFileChooser/);

    const prepared = fixture.calls.find(([kind]) => kind === 'prepareFileChooser');
    expect(prepared?.[2]).toMatchObject({ cancel: true });
    expect(fixture.systemFileChooserOpened()).toBe(false);
  });
});

test('Page and TaskSpace CDP commands preserve their intended scope', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const first = await openTestPage(task, 'https://example.test/first');
    await openTestPage(task, 'https://example.test/second');

    const pageResult = await first.cdp(
      'Runtime.evaluate',
      { expression: 'document.title' },
      { timeout: 1_234 },
    );
    const taskResult = await task.cdp('Browser.getVersion', {}, { timeout: 987 });

    expect(pageResult).toMatchObject({ result: { value: 'https://example.test/first' } });
    expect(taskResult.product).toBe('Ego Lite/Test');
    expect(
      cdpCalls(fixture).some(
        ({ method, sessionId, timeoutMs }) =>
          method === 'Runtime.evaluate' && sessionId === 'session:target-1' && timeoutMs === 1_234,
      ),
      'page.cdp must use the Page session and millisecond timeout',
    ).toBe(true);
    expect(
      cdpCalls(fixture).some(
        ({ method, sessionId, timeoutMs }) =>
          method === 'Browser.getVersion' && sessionId === undefined && timeoutMs === 987,
      ),
      'task.cdp must use the selected space without a Page session',
    ).toBe(true);
  });
});

test('Page and TaskSpace CDP reject a sessionId they would not honour', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');
    fixture.calls.length = 0;

    const error = await rejection(
      page.cdp('Runtime.evaluate', { expression: '1', sessionId: 'other' }),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toMatch(/Page\.cdp/);
    expect(error.message).toMatch(/Runtime\.evaluate/);
    await expect(task.cdp('Browser.getVersion', { sessionId: 'other' })).rejects.toThrow(
      /TaskSpace\.cdp.*Browser\.getVersion/,
    );
    await expect(task.cdp('Target.getTargets', { sessionId: 'other' })).rejects.toThrow(
      /TaskSpace\.cdp.*Target\.getTargets/,
    );
    expect(
      fixture.calls.filter(([kind]) => kind === 'cdp'),
      'a rejected command must never reach the browser',
    ).toEqual([]);

    await task.cdp('Target.detachFromTarget', { sessionId: 'other' });
    expect(
      cdpCalls(fixture).some(
        ({ method, params, sessionId }) =>
          method === 'Target.detachFromTarget' &&
          params.sessionId === 'other' &&
          sessionId === undefined,
      ),
      'Target commands that define params.sessionId must still pass through',
    ).toBe(true);
  });
});

test('Page waits and events remain isolated to the addressed target', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const first = await openTestPage(task, 'https://example.test/first');
    const second = await openTestPage(task, 'https://example.test/second');

    expect(
      await first.waitForSelector('#ready', {
        timeout: 250,
        state: 'visible',
      }),
    ).toBe(true);
    fixture.setDocumentLifecycle({
      readyState: 'interactive',
      domContentLoaded: true,
    });
    await first.waitForLoadState('domcontentloaded', { timeout: 250 });
    fixture.setDocumentLifecycle({
      readyState: 'complete',
      domContentLoaded: true,
    });
    await first.waitForLoadState();
    fixture.emitPageEvent(targetOf(first), 'Network.requestWillBeSent', {
      requestId: 'request-first',
    });
    fixture.emitPageEvent(targetOf(first), 'Network.loadingFinished', {
      requestId: 'request-first',
    });
    await first.waitForLoadState('networkidle', {
      timeout: 500,
      idleMs: 100,
    });

    fixture.emitPageEvent(targetOf(first), 'Runtime.consoleAPICalled', {
      value: 'first',
    });
    fixture.emitPageEvent(targetOf(second), 'Runtime.consoleAPICalled', {
      value: 'second',
    });
    expect((await second.events()).map(eventValue)).toEqual(['second']);
    expect(
      (await first.events()).map((event) => event.method),
      'network-idle must preserve the addressed Page event stream',
    ).toEqual(['Network.requestWillBeSent', 'Network.loadingFinished', 'Runtime.consoleAPICalled']);

    expect(
      cdpCalls(fixture).some(
        ({ method, sessionId }) => method === 'Network.enable' && sessionId === 'session:target-1',
      ),
      'network idle must enable events on the addressed Page session',
    ).toBe(true);
  });
});

test('Page network-idle sees an earlier request without consuming events', async () => {
  await withFixture(async (fixture) => {
    let now = 0;
    let childBusy = true;
    let childFinishedAt = 0;
    const task = taskForRound(fixture, 'round-a', {
      now: () => now,
      sleep(ms) {
        now += ms;
        if (childBusy && now >= 150) {
          childBusy = false;
          childFinishedAt = now;
        }
        return Promise.resolve();
      },
      ensureNetworkTracking() {
        return Promise.resolve();
      },
      pageNetworkSessions(sessionId) {
        return Promise.resolve([sessionId, 'session:oopif-child']);
      },
      networkActivity(sessionIds) {
        expect(sessionIds).toEqual(['session:target-1', 'session:oopif-child']);
        return {
          tracking: true,
          inflight: childBusy ? 1 : 0,
          lastActivityAt: childBusy ? 0 : childFinishedAt,
        };
      },
    });
    const page = await openTestPage(task, 'https://example.test/network-idle');
    fixture.emitPageEvent(targetOf(page), 'Runtime.consoleAPICalled', {
      value: 'preserve this event',
    });

    await page.waitForLoadState('networkidle', {
      timeout: 500,
      idleMs: 100,
    });

    expect(childBusy, 'a request started before the wait must finish').toBe(false);
    expect(now >= 250, 'the idle window begins after the earlier request ends').toBe(true);
    expect(
      (await page.events()).map(eventValue),
      'network-idle must not consume unrelated Page events',
    ).toEqual(['preserve this event']);
  });
});

test('Page waitForURL follows a popup from about:blank without activating it', async () => {
  await withFixture(async (fixture) => {
    let elapsedMs = 0;
    // Set once the popup exists; the sleep stub reads it from then on.
    const popupTarget: { id?: string } = {};
    const expectedUrl = 'https://example.test/delayed-popup';
    const task = taskForRound(fixture, 'round-a', {
      now: () => elapsedMs,
      sleep(ms) {
        elapsedMs += ms;
        if (popupTarget.id && elapsedMs >= 150) {
          const tab = fixture.tabs.get(popupTarget.id);
          if (tab) tab.url = expectedUrl;
        }
        return Promise.resolve();
      },
    });
    const source = await openTestPage(task, 'https://example.test/source');
    fixture.openPopupOnNextClick('about:blank');
    const receipt = await source.click('#open-popup');
    popupTarget.id = firstPopup(receipt).targetId;
    const popup = task.page(firstPopup(receipt).label);
    fixture.addExternalTab('target-user', 'https://example.test/user', {
      active: true,
    });
    const activationCallsBefore = cdpCalls(fixture).filter(
      ({ method }) => method === 'Target.activateTarget',
    ).length;

    await popup.waitForURL(expectedUrl, { timeout: 500 });
    await popup.waitForURL(/delayed-popup$/, { timeout: 1 });
    await popup.waitForURL('**/delayed-popup', { timeout: 1 });
    await popup.waitForURL(
      (url) => url.hostname === 'example.test' && url.pathname === '/delayed-popup',
      { timeout: 1 },
    );

    expect(await popup.url()).toBe(expectedUrl);
    expect(fixture.activeTarget(), 'waiting for a URL must not steal the active tab').toBe(
      'target-user',
    );
    expect(
      cdpCalls(fixture).filter(({ method }) => method === 'Target.activateTarget').length,
    ).toBe(activationCallsBefore);
  });
});

test('Page.waitForEvent arms before a click and resolves the opened popup', async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    const task = taskForRound(fixture, 'round-a');
    const source = await openTestPage(task, 'https://example.test/source');
    fixture.openPopupOnNextClick('https://example.test/popup');

    const popupPromise = source.waitForEvent('popup', { timeout: 1_000 });
    const receipt = await source.click('#open-popup');
    const popup = asPopup(await popupPromise);

    expect(popup.label).toBe(firstPopup(receipt).label);
    expect(await popup.url()).toBe('https://example.test/popup');
    expect(consumeUnhandledPageNotices()).toEqual([]);
  });
});

/** Answers `artifact` once the triggering click's mouse release reaches the Page. */
function downloadOnClick(
  fixture: Fixture,
  resolveDownload: (artifact: DownloadArtifact) => void,
  artifact: DownloadArtifact,
): CdpCall {
  const baseCdp = fixture.services.cdp;
  return fakeCdp(async (method, params, sessionId, timeoutMs) => {
    const result = await baseCdp(method, params, sessionId, timeoutMs);
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
      resolveDownload(artifact);
    }
    return result;
  });
}

test('Page.waitForEvent exposes a Playwright-style download object', async () => {
  await withFixture(async (fixture) => {
    // PiArc: no temp files. The download sits in the session's staging area under the name the
    // main process reports, and saveAs goes through Core (the artifact records the call).
    const stagingName = 'guid-report';
    const outputPath = '/home/agent/saved/report.txt';
    let resolveDownload: (artifact: DownloadArtifact) => void = () => undefined;
    const event = new Promise<DownloadArtifact>((resolve) => {
      resolveDownload = resolve;
    });
    const calls: unknown[][] = [];
    const artifact: DownloadArtifact = {
      url: 'https://example.test/report',
      suggestedFilename: 'report.txt',
      finished: Promise.resolve(),
      saveAs(path) {
        calls.push(['saveAs', path]);
        return Promise.resolve();
      },
      path() {
        return Promise.resolve(stagingName);
      },
      failure() {
        return Promise.resolve(null);
      },
      cancel() {
        calls.push(['cancel']);
        return Promise.resolve();
      },
      delete() {
        calls.push(['delete']);
        return Promise.resolve();
      },
    };
    const task = taskForRound(fixture, 'round-a', {
      prepareDownload(targetId, options): DownloadInterception {
        calls.push(['prepare', targetId, options]);
        return {
          ready(sessionId) {
            calls.push(['ready', sessionId]);
            return Promise.resolve();
          },
          event,
          dispose(error) {
            calls.push(['dispose', error?.message]);
            return Promise.resolve();
          },
        };
      },
      cdp: downloadOnClick(fixture, resolveDownload, artifact),
    });
    const source = await openTestPage(task, 'https://example.test/source');

    const downloadPromise = source.waitForEvent('download', {
      timeout: 1_000,
    });
    await source.click('#download');
    const download = asDownload(await downloadPromise);

    expect(download.page()).toBe(source);
    expect(download.url()).toBe('https://example.test/report');
    expect(download.suggestedFilename()).toBe('report.txt');
    expect(await download.path()).toBe(stagingName);
    expect(await download.failure()).toBeNull();
    await download.saveAs(outputPath);
    await download.cancel();
    await download.delete();
    expect(calls.slice(0, 2)).toEqual([
      ['prepare', source.targetId, { timeoutMs: 1_000 }],
      ['ready', `session:${targetOf(source)}`],
    ]);
    expect(calls.slice(-3)).toEqual([['saveAs', outputPath], ['cancel'], ['delete']]);
  });
});

test('Page reapplies download behavior after its CDP session reconnects', async () => {
  await withFixture(async (fixture) => {
    let markFirstReady: () => void = () => undefined;
    const firstReady = new Promise<void>((resolve) => {
      markFirstReady = resolve;
    });
    let resolveDownload: (artifact: DownloadArtifact) => void = () => undefined;
    const event = new Promise<DownloadArtifact>((resolve) => {
      resolveDownload = resolve;
    });
    const readySessions: string[] = [];
    const artifact: DownloadArtifact = {
      url: 'https://example.test/report',
      suggestedFilename: 'report.txt',
      finished: Promise.resolve(),
      saveAs: () => Promise.resolve(),
      path: () => Promise.resolve('report.txt'),
      failure: () => Promise.resolve(null),
      cancel: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };
    const task = taskForRound(fixture, 'round-a', {
      prepareDownload(): DownloadInterception {
        return {
          ready(sessionId) {
            readySessions.push(sessionId);
            if (readySessions.length === 1) markFirstReady();
            return Promise.resolve();
          },
          event,
          dispose: () => Promise.resolve(),
        };
      },
      cdp: downloadOnClick(fixture, resolveDownload, artifact),
    });
    const source = await openTestPage(task, 'https://example.test/source');

    const downloadPromise = source.waitForEvent('download', {
      timeout: 1_000,
    });
    await firstReady;
    fixture.setSession(targetOf(source), 'session:reconnected');
    await source.click('#download');
    await downloadPromise;

    expect(readySessions).toEqual([`session:${targetOf(source)}`, 'session:reconnected']);
  });
});

test('Page.waitForEvent ignores an older popup and resolves the next one', async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    const task = taskForRound(fixture, 'round-a');
    const source = await openTestPage(task, 'https://example.test/source');
    fixture.openPopupOnNextClick('https://example.test/old-popup');

    const oldReceipt = await source.click('#open-old-popup');
    fixture.openPopupOnNextClick('https://example.test/next-popup');
    const popupPromise = source.waitForEvent('popup', { timeout: 1_000 });
    const nextReceipt = await source.click('#open-next-popup');
    const popup = asPopup(await popupPromise);

    expect(popup.label).not.toBe(firstPopup(oldReceipt).label);
    expect(popup.label).toBe(firstPopup(nextReceipt).label);
    expect(await popup.url()).toBe('https://example.test/next-popup');
    expect(consumeUnhandledPageNotices().map((notice) => notice.targetId)).toEqual([
      firstPopup(oldReceipt).targetId,
    ]);
  });
});

test('Page.waitForEvent rejects unsupported events and times out cleanly', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const source = await openTestPage(task, 'https://example.test/source');

    expect(() => source.waitForEvent(untyped('request'), { timeout: 10 })).toThrow(
      /only supports the popup and download events/,
    );
    await expect(source.waitForEvent('popup', { timeout: 5 })).rejects.toThrow(
      /page\.waitForEvent\("popup"\) timed out after 5ms/,
    );
  });
});

test('Page.waitForURL immediately reports a matching popup opened by this Page', async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    const task = taskForRound(fixture, 'round-a');
    const source = await openTestPage(task, 'https://example.test/source');
    fixture.openPopupOnNextClick('https://example.test/drive/home');
    await source.click('#open-popup');

    const error = await rejection(source.waitForURL('**/drive/home', { timeout: 15_000 }));
    expect(Reflect.get(error, 'code')).toBe('EGO_URL_OPENED_IN_POPUP');
    expect(error.message).toMatch(/p1 did not navigate/);
    expect(error.message).toMatch(/popup p2 opened/);
    expect(error.message).toMatch(/task\.page\("p2"\)/);
    expect(error.message).toMatch(/triggering action already succeeded/i);
    expect(error.message).not.toMatch(/timed out/);
  });
});

test('Page.waitForURL still succeeds when the opener itself reaches the URL', async () => {
  await withFixture(async (fixture) => {
    resetPageNotices();
    const task = taskForRound(fixture, 'round-a');
    const source = await openTestPage(task, 'https://example.test/source');
    const expectedUrl = 'https://example.test/drive/home';
    fixture.openPopupOnNextClick(expectedUrl);
    fixture.navigateOnNextClick(expectedUrl);
    await source.click('#open-popup');

    await source.waitForURL(/\/drive\/home/, { timeout: 500 });
  });
});

test('Page waitForURL validates its matcher and reports the last URL', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'about:blank');

    await expect(page.waitForURL('https://example.test/never', { timeout: 10 })).rejects.toThrow(
      /waitForURL timed out after 10ms.*last URL was "about:blank"/,
    );
    await expect(page.waitForURL('', { timeout: 10 })).rejects.toThrow(
      /non-empty string, RegExp, or function/,
    );
    await expect(page.waitForURL(untyped(42), { timeout: 10 })).rejects.toThrow(
      /non-empty string, RegExp, or function/,
    );
    await expect(
      page.waitForURL(
        untyped(async () => {
          await Promise.resolve();
          return true;
        }),
        { timeout: 10 },
      ),
    ).rejects.toThrow(/predicate must return a boolean synchronously/);
    await expect(
      page.waitForURL(
        untyped((url: { includes(text: string): boolean }) => url.includes('/search?')),
        { timeout: 10 },
      ),
    ).rejects.toThrow(/url\.includes is not a function.*receives a URL object; use url\.href/);
    await expect(page.waitForURL('**/{ready', { timeout: 10 })).rejects.toThrow(
      /Invalid URL glob.*unmatched '\{'/,
    );
    await expect(page.waitForURL(/blank/, { timeout: 0 })).rejects.toThrow(
      /positive number of milliseconds/,
    );
  });
});

test('Page waitForURL retries a transient evaluation timeout', async () => {
  await withFixture(async (fixture) => {
    const expectedUrl = 'https://example.test/after-timeout';
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, expectedUrl);
    fixture.timeoutNextUrlEvaluation();

    await page.waitForURL(expectedUrl, { timeout: 2_000 });
    expect(await page.url()).toBe(expectedUrl);
  });
});

test('Page waitForSelector supports Playwright-style element states', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');

    fixture.setElementState({ present: true, visible: false });
    expect(await page.waitForSelector('#ready', { state: 'attached' })).toBe(true);
    expect(await page.waitForSelector('#ready', { state: 'hidden' })).toBe(true);

    fixture.setElementState({ present: false });
    expect(await page.waitForSelector('#ready', { state: 'detached' })).toBe(true);
    expect(await page.waitForSelector('#ready', { state: 'hidden' })).toBe(true);

    fixture.setElementState({ present: true, visible: true });
    expect(await page.waitForSelector('#ready', { state: 'visible' })).toBe(true);
  });
});

test('Page wait methods reject invalid states and millisecond timeouts', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');

    fixture.setDocumentLifecycle({
      readyState: 'interactive',
      domContentLoaded: false,
    });
    await expect(page.waitForLoadState('domcontentloaded', { timeout: 1 })).rejects.toThrow(
      /waitForLoadState\(domcontentloaded\) timed out/,
    );
    fixture.setDocumentLifecycle({
      readyState: 'interactive',
      domContentLoaded: true,
    });
    await page.waitForLoadState('domcontentloaded', { timeout: 1 });

    fixture.timeoutNextLifecycleEvaluation();
    await expect(page.waitForLoadState('load', { timeout: 10 })).rejects.toThrow(
      /waitForLoadState\(load\) timed out after 10ms/,
    );

    await expect(page.waitForLoadState(untyped('commit'))).rejects.toThrow(
      /supports only "domcontentloaded", "load", and "networkidle"/,
    );
    await expect(page.waitForSelector('#ready', { timeout: 0 })).rejects.toThrow(
      /positive number of milliseconds/,
    );
    await expect(page.waitForSelector('#ready', untyped({ state: 'stable' }))).rejects.toThrow(
      /state must be one of/,
    );
    await expect(task.cdp('Page.navigate')).rejects.toThrow(
      /only supports Target\. and Browser\. commands/,
    );
  });
});

test('Page actions resolve snapshot refs inside the addressed page', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const first = await openTestPage(task, 'https://example.test/first');
    const second = await openTestPage(task, 'https://example.test/second');

    await first.snapshot();
    await second.snapshot();
    await first.click('@21');
    await second.fill('@21', 'page-scoped');

    const resolvedIn = (sessionId: string) =>
      cdpCalls(fixture).find(
        (call) =>
          call.method === 'DOM.resolveNode' &&
          call.params.backendNodeId === 21 &&
          call.sessionId === sessionId,
      );
    expect(
      resolvedIn('session:target-1'),
      'click must resolve through the first Page session',
    ).toBeDefined();
    expect(
      resolvedIn('session:target-2'),
      'fill must resolve through the second Page session',
    ).toBeDefined();
    expect(fixture.activeTarget()).toBe(second.targetId);
  });
});

test('consecutive clicks preserve sibling refs from one snapshot', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a', {
      snapshot() {
        return Promise.resolve({
          content: 'button "First" [ref=19]\nbutton "Second" [ref=22]\nbutton "Third" [ref=23]',
          refs: [19, 22, 23].map((refId) => ({
            refId,
            backendNodeId: refId + 100,
            role: 'button',
          })),
        });
      },
    });
    const page = await openTestPage(task, 'https://example.test/buttons');
    await page.snapshot();

    await page.click('@19');
    await page.click('@22');
    await page.click('@23');

    expect(cdpParams(fixture, 'DOM.resolveNode').map((params) => params.backendNodeId)).toEqual([
      119, 122, 123,
    ]);
  });
});

test('fill and press reuse a published ref in a new round', async () => {
  await withFixture(async (fixture) => {
    const page = await openTestPage(taskForRound(fixture, 'round-a'), 'https://example.test/input');
    await page.snapshot();
    await fixture.services.sleep(4_000);
    const restored = taskForRound(fixture, 'round-b', {
      pageRefs: new PageRefRegistry(),
    }).page(page.label);

    await restored.fill('@21', 'M2');
    await restored.press('@21', 'Enter');

    expect(
      cdpParams(fixture, 'Input.dispatchKeyEvent').some((params) => params.key === 'Enter'),
    ).toBe(true);
    expect(
      fixture.calls.filter(([kind]) => kind === 'snapshot').length,
      'reusing the same node must not trigger a new snapshot',
    ).toBe(1);
  });
});

test('raw keyboard input preserves unchanged refs into the next round', async () => {
  await withFixture(async (fixture) => {
    const page = await openTestPage(taskForRound(fixture, 'round-a'), 'https://example.test/input');
    await page.snapshot();
    await page.keyboard.press('Tab');
    const restored = taskForRound(fixture, 'round-b', {
      pageRefs: new PageRefRegistry(),
    }).page(page.label);

    await restored.click('@21');
    expect(cdpParams(fixture, 'DOM.resolveNode')[0]?.backendNodeId).toBe(21);
  });
});

test('a new round restores the published ref without renumbering from a fresh snapshot', async () => {
  await withFixture(async (fixture) => {
    // Upstream reassigns the shared fixture's snapshot service before each round; the
    // equivalent here is one override per round.
    const firstRound = taskForRound(fixture, 'round-a', {
      snapshot() {
        fixture.calls.push(['snapshot', fixture.activeTarget()]);
        return Promise.resolve({
          content: 'button "Second" [ref=1]',
          refs: [{ refId: 1, backendNodeId: 42, role: 'button', name: 'Second' }],
        });
      },
    });
    const created = await openTestPage(firstRound, 'https://example.test/first');
    await created.snapshot();
    const snapshotsBefore = fixture.calls.filter(([kind]) => kind === 'snapshot').length;

    const secondRound = taskForRound(fixture, 'round-b', {
      pageRefs: new PageRefRegistry(),
      snapshot() {
        fixture.calls.push(['snapshot', created.targetId]);
        return Promise.resolve({
          content: 'button "First" [ref=1]',
          refs: [{ refId: 1, backendNodeId: 21, role: 'button', name: 'First' }],
        });
      },
    });
    await secondRound.page(created.label).click('@1');

    expect(
      fixture.calls.filter(([kind]) => kind === 'snapshot').length,
      'the saved mapping must survive a new round without reconstructing native ids',
    ).toBe(snapshotsBefore);
    const resolved = cdpParams(fixture, 'DOM.resolveNode');
    expect(resolved.at(-1)?.backendNodeId).toBe(42);
  });
});

test('an unknown Page ref fails without guessing a mapping from a new snapshot', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');

    await expect(page.click('@99')).rejects.toThrow(/Unknown ref: 99/);
    expect(fixture.calls.filter(([kind]) => kind === 'snapshot')).toEqual([]);
  });
});

test('raw CDP ref invalidation survives a new Agent round', async () => {
  await withFixture(async (fixture) => {
    const page = await openTestPage(taskForRound(fixture, 'round-a'), 'https://example.test/first');
    await page.snapshot();
    await page.cdp('Page.getFrameTree');
    const restored = taskForRound(fixture, 'round-b', {
      pageRefs: new PageRefRegistry(),
    }).page(page.label);

    await expect(restored.click('@21')).rejects.toThrow(/Stale ref: @21/);
    expect(cdpParams(fixture, 'DOM.resolveNode')).toHaveLength(0);
  });
});

for (const persistentFailure of [false, true]) {
  test(`cross-round refs survive an iframe document read failure${persistentFailure ? ' after the action times out' : ' during the first action'}`, async () => {
    await withFixture(async (fixture) => {
      let frameSession = 'session:oopif';
      let failFrameRead = false;
      const baseCdp = fixture.services.cdp;
      const overrides: PageModelOverrides = {
        cdp: fakeCdp((method, params, sessionId) => {
          if (method === 'Page.getFrameTree') {
            if (sessionId === 'session:target-1') {
              return {
                frameTree: {
                  frame: { id: 'main-frame', loaderId: 'main-document' },
                },
              };
            }
            if (failFrameRead) {
              failFrameRead = persistentFailure;
              frameSession = 'session:oopif-reconnected';
              throw Object.assign(new Error('Session with given id not found'), {
                sessionId,
              });
            }
            return {
              frameTree: {
                frame: { id: 'child-frame', loaderId: 'same-document' },
              },
            };
          }
          return baseCdp(method, params, sessionId);
        }),
        snapshot() {
          return Promise.resolve({
            content: 'textbox "Cell address" [ref=19]',
            refs: [{ refId: 19, backendNodeId: 42, frameId: 'child-frame' }],
          });
        },
        ensureFrameSessions() {
          return Promise.resolve(new Map([['child-frame', frameSession]]));
        },
      };
      const page = await openTestPage(
        taskForRound(fixture, 'round-a', overrides),
        'https://example.test/iframe',
      );
      await page.snapshot();
      failFrameRead = true;
      let restored = taskForRound(fixture, 'round-b', {
        ...overrides,
        pageRefs: new PageRefRegistry(),
      }).page(page.label);

      if (persistentFailure) {
        await expect(restored.press('@19', 'Enter', { timeout: 100 })).rejects.toThrow(
          /timed out.*Session with given id not found/,
        );
        failFrameRead = false;
        restored = taskForRound(fixture, 'round-c', {
          ...overrides,
          pageRefs: new PageRefRegistry(),
        }).page(page.label);
      }
      await restored.press('@19', 'Enter');

      expect(
        cdpParams(
          fixture,
          'Input.dispatchKeyEvent',
          (params) => params.type === 'keyUp' && params.key === 'Enter',
        ).length,
        'document verification must recover before dispatching input once',
      ).toBe(1);
      expect(
        cdpCalls(fixture).some(
          ({ method, params, sessionId }) =>
            method === 'DOM.resolveNode' &&
            params.backendNodeId === 42 &&
            sessionId === 'session:oopif-reconnected',
        ),
      ).toBe(true);
    });
  });
}

for (const mode of ['page', 'same-process iframe', 'OOPIF'] as const) {
  const frameId = mode === 'page' ? undefined : 'child-frame';
  test(`saved refs reject a changed ${mode} document even when backend ids repeat`, async () => {
    await withFixture(async (fixture) => {
      let loaderId = 'old-document';
      const baseCdp = fixture.services.cdp;
      const overrides: PageModelOverrides = {
        cdp: fakeCdp((method, params, sessionId) => {
          if (method === 'Page.getFrameTree')
            return {
              frameTree:
                sessionId === 'session:oopif'
                  ? { frame: { id: 'child-frame', loaderId } }
                  : {
                      frame: {
                        id: 'main-frame',
                        loaderId: frameId ? 'main-document' : loaderId,
                      },
                      childFrames:
                        mode === 'OOPIF' ? [] : [{ frame: { id: 'child-frame', loaderId } }],
                    },
            };
          return baseCdp(method, params, sessionId);
        }),
        snapshot() {
          return Promise.resolve({
            content: 'button "Save" [ref=1]',
            refs: [
              {
                refId: 1,
                backendNodeId: 42,
                ...(frameId === undefined ? {} : { frameId }),
                role: 'button',
                name: 'Save',
              },
            ],
          });
        },
        ensureFrameSessions() {
          return Promise.resolve(
            new Map([['child-frame', mode === 'OOPIF' ? 'session:oopif' : 'session:target-1']]),
          );
        },
      };
      const first = taskForRound(fixture, 'round-a', overrides);
      const page = await openTestPage(first, 'https://example.test/first');
      await page.snapshot();
      loaderId = 'new-document';
      const restored = taskForRound(fixture, 'round-b', {
        ...overrides,
        pageRefs: new PageRefRegistry(),
      }).page(page.label);

      await expect(restored.snapshot({ scope: 'subtree', root: '@1' })).rejects.toThrow(
        /Stale ref: @1/,
      );
      expect(cdpParams(fixture, 'DOM.resolveNode')).toHaveLength(0);
      const fresh = await restored.snapshot();
      expect(fresh, 'a new document cannot inherit an old public ref').not.toMatch(/\[ref=1\]/);
    });
  });
}

test('a navigation during snapshot capture is retried against the new document', async () => {
  await withFixture(async (fixture) => {
    let loaderId = 'before';
    let captures = 0;
    const baseCdp = fixture.services.cdp;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp((method, params, sessionId) => {
        if (method === 'Page.getFrameTree')
          return { frameTree: { frame: { id: 'main', loaderId } } };
        return baseCdp(method, params, sessionId);
      }),
      snapshot() {
        captures += 1;
        // The commit lands while the first capture is in flight; the retry
        // sees the stable new document.
        loaderId = 'after';
        return Promise.resolve({
          content: captures === 1 ? 'button "Old document" [ref=1]' : 'button "Save" [ref=1]',
          refs: [{ refId: 1, backendNodeId: 40 + captures }],
        });
      },
    });
    const page = await openTestPage(task, 'https://example.test/first');
    const content = await page.snapshot();
    expect(captures, 'the mixed capture is discarded and retried once').toBe(2);
    expect(content).toMatch(/Save.*\[ref=1\]/);
    expect(content).not.toMatch(/Old document/);
    expect(
      fixture.services.pageRefs.forTarget(targetOf(page)).get('1')?.backendNodeId,
      'only the stable capture publishes refs',
    ).toBe(42);
  });
});

test('a subtree snapshot whose root document commits away is stale, not retried with the old root', async () => {
  await withFixture(async (fixture) => {
    let loaderId = 'before';
    const requestedRoots: (number | undefined)[] = [];
    const baseCdp = fixture.services.cdp;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp((method, params, sessionId) => {
        if (method === 'Page.getFrameTree')
          return { frameTree: { frame: { id: 'main', loaderId } } };
        return baseCdp(method, params, sessionId);
      }),
      snapshot(options) {
        if (options.scope !== 'subtree') {
          return Promise.resolve({
            content: 'button "First" [ref=21]',
            refs: [{ refId: 21, backendNodeId: 21 }],
          });
        }
        requestedRoots.push(options.root);
        // The navigation commits while the subtree capture is in flight.
        loaderId = 'after';
        return Promise.resolve({
          content: 'button "First" [ref=21]',
          refs: [{ refId: 21, backendNodeId: 21 }],
        });
      },
    });
    const page = await openTestPage(task, 'https://example.test/first');
    await page.snapshot({ scope: 'full_page' });

    const error = await rejection(page.snapshot({ scope: 'subtree', root: '@21' }));
    expect(error.message).toMatch(/Stale ref: @21; take a new snapshot/);
    expect(Reflect.get(error, 'kind')).toBe('permanent');
    expect(requestedRoots, "the old document's root is not reused for a retry").toEqual([21]);
    expect(fixture.services.pageRefs.isInvalidated(targetOf(page), '21')).toBe(true);
  });
});

test('a page that keeps navigating during snapshot captures fails after bounded retries', async () => {
  await withFixture(async (fixture) => {
    let loaderId = 0;
    let captures = 0;
    const baseCdp = fixture.services.cdp;
    const task = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp((method, params, sessionId) => {
        if (method === 'Page.getFrameTree')
          return {
            frameTree: { frame: { id: 'main', loaderId: `load-${String(loaderId)}` } },
          };
        return baseCdp(method, params, sessionId);
      }),
      snapshot() {
        captures += 1;
        loaderId += 1;
        return Promise.resolve({
          content: 'button "Save" [ref=1]',
          refs: [{ refId: 1, backendNodeId: 42 }],
        });
      },
    });
    const page = await openTestPage(task, 'https://example.test/first');
    const error = await rejection(page.snapshot());
    expect(error.message).toMatch(/Page changed during snapshot/);
    expect(Reflect.get(error, 'kind')).toBe('transient');
    expect(captures, 'one capture plus two retries').toBe(3);
    expect(
      fixture.services.pageRefs.forTarget(targetOf(page)).get('1'),
      'a mixed capture never publishes refs',
    ).toBeUndefined();
  });
});

test('Page click uses the wheel motion engine to bring an element into view', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');
    fixture.scrollNextClickPoint();

    await page.click('#offscreen');

    const pointCalls = cdpParams(fixture, 'Runtime.callFunctionOn', (params) =>
      declarationOf(params).includes('getBoundingClientRect'),
    );
    expect(pointCalls.length >= 2, 'the element position is rechecked after scrolling').toBe(true);
    expect(declarationOf(pointCalls[0])).not.toMatch(/scrollIntoView/);
    const stabilityCall = pointCalls.find((params) =>
      declarationOf(params).includes('setTimeout(finish, 100)'),
    );
    expect(stabilityCall, 'the final point check samples element stability').toBeDefined();
    expect(
      declarationOf(stabilityCall),
      'stability sampling must not wait indefinitely for background animation frames',
    ).toMatch(/setTimeout\(finish, 100\)/);
    expect(
      declarationOf(stabilityCall),
      'click safety follows the recomputed hit point instead of requiring a static rectangle',
    ).not.toMatch(/firstRect|element is not stable/);
    const wheelCalls = cdpParams(
      fixture,
      'Input.dispatchMouseEvent',
      (params) => params.type === 'mouseWheel',
    );
    expect(wheelCalls.length).toBeGreaterThan(1);
    expect(wheelCalls.reduce((total, params) => total + numberOf(params.deltaY), 0)).toBe(600);
    const wheelEnd = fixture.calls.findLastIndex(isWheel);
    const press = fixture.calls.findIndex((call) =>
      isCdp(call, 'Input.dispatchMouseEvent', (params) => params.type === 'mousePressed'),
    );
    expect(wheelEnd < press, 'scrolling must finish before the click is dispatched').toBe(true);
  });
});

test('Page fill uses the wheel motion engine to bring an element into view', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');
    fixture.scrollNextClickPoint();

    await page.fill('#offscreen-field', 'filled');

    const pointCalls = cdpParams(fixture, 'Runtime.callFunctionOn', (params) =>
      declarationOf(params).includes('getBoundingClientRect'),
    );
    expect(pointCalls.length >= 2, 'the field position is rechecked after scrolling').toBe(true);
    expect(declarationOf(pointCalls[0])).not.toMatch(/scrollIntoView/);
    expect(
      declarationOf(pointCalls[0]),
      'fill scrolling must not block keyboard input on element motion',
    ).not.toMatch(/requestAnimationFrame|element is not stable/);
    const wheelCalls = cdpParams(
      fixture,
      'Input.dispatchMouseEvent',
      (params) => params.type === 'mouseWheel',
    );
    expect(wheelCalls.length).toBeGreaterThan(1);
    expect(wheelCalls.reduce((total, params) => total + numberOf(params.deltaY), 0)).toBe(600);
    const insertText = fixture.calls.findIndex((call) => isCdp(call, 'Input.insertText'));
    const wheelEnd = fixture.calls.findLastIndex(isWheel);
    expect(wheelEnd < insertText, 'scrolling must finish before text input is dispatched').toBe(
      true,
    );
  });
});

test('Page fill falls back to a programmatic scroll when wheel input does not move the target', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/map');
    fixture.trapClickPoints();

    await page.fill('#below-the-map', 'hello');

    const wheelCount = fixture.calls.filter(isWheel).length;
    expect(wheelCount > 1, 'wheel input is still tried first').toBe(true);
    expect(
      wheelCount <= 12,
      `one ineffective motion must not be repeated: ${String(wheelCount)} wheel events`,
    ).toBe(true);
    const fallbackIndex = fixture.calls.findIndex((call) =>
      isCdp(
        call,
        'DOM.scrollIntoViewIfNeeded',
        (params, session) =>
          params.objectId === `element:${targetOf(page)}` &&
          session === `session:${targetOf(page)}`,
      ),
    );
    expect(fallbackIndex > 0, 'a stalled motion falls back to DOM.scrollIntoViewIfNeeded').toBe(
      true,
    );
    expect(
      fallbackIndex > fixture.calls.findLastIndex(isWheel),
      'the fallback runs after the wheel motion proved ineffective',
    ).toBe(true);
    expect(
      fixture.calls.findIndex((call) => isCdp(call, 'Input.insertText')) > fallbackIndex,
      'text input waits for the fallback scroll',
    ).toBe(true);
  });
});

test('Page click gives up when neither wheel input nor the fallback scroll moves the target', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/map');
    fixture.trapClickPoints();
    const baseCdp = fixture.services.cdp;
    const task2 = taskForRound(fixture, 'round-a', {
      cdp: fakeCdp(async (method, params, sessionId, timeoutMs) => {
        const result = await baseCdp(method, params, sessionId, timeoutMs);
        // The programmatic scroll is accepted but changes nothing either.
        if (method === 'DOM.scrollIntoViewIfNeeded') fixture.trapClickPoints();
        return result;
      }),
    });
    const stuck = task2.page(page.label);

    await expect(stuck.click('#below-the-map', { timeout: 1_000 })).rejects.toThrow(
      /page\.click timed out after \d+ms: page\.click failed: element is not visible in the viewport/,
    );
    // A motion is a run of consecutive wheel events.
    let wheelMotions = 0;
    let inMotion = false;
    for (const call of fixture.calls) {
      const wheel = isWheel(call);
      if (wheel && !inMotion) wheelMotions += 1;
      inMotion = wheel;
    }
    const fallbacks = fixture.calls.filter((call) =>
      isCdp(call, 'DOM.scrollIntoViewIfNeeded'),
    ).length;
    expect(fallbacks >= 1, 'the fallback scroll was attempted').toBe(true);
    expect(
      wheelMotions <= fallbacks * 2,
      `each retry tries at most one wheel motion before and after the fallback: ${String(wheelMotions)} motions, ${String(fallbacks)} fallbacks`,
    ).toBe(true);
  });
});

test('Page fill stops auto-scrolling at the action deadline and reports the real duration', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/map');
    fixture.trapClickPoints();
    // A map that zooms on every wheel event keeps the renderer busy, so each
    // dispatched wheel event takes about two seconds to be acknowledged.
    fixture.setWheelDispatchDuration(2_000);
    const startedAt = fixture.services.now();

    const error = await rejection(page.fill('#below-the-map', 'hello', { timeout: 3_000 }));
    const elapsed = fixture.services.now() - startedAt;
    const reported = Number(/page\.fill timed out after (\d+)ms: /.exec(error.message)?.[1]);
    expect(
      reported > 3_000 && reported <= elapsed,
      `the timeout message reports the real duration, not the configured 3000ms: ${error.message} (elapsed ${String(elapsed)}ms)`,
    ).toBe(true);
    expect(
      elapsed < 6_000,
      `the action overran its 3000ms budget by ${String(elapsed - 3_000)}ms`,
    ).toBe(true);
    const wheelCount = fixture.calls.filter(isWheel).length;
    expect(
      wheelCount <= 3,
      `the motion stops at the deadline instead of finishing: ${String(wheelCount)} wheel events`,
    ).toBe(true);
  });
});

test('Page click retries a transient visibility change before dispatching input', async () => {
  await withFixture(async (fixture) => {
    const task = taskForRound(fixture, 'round-a');
    const page = await openTestPage(task, 'https://example.test/first');
    fixture.rejectNextClickPoint();

    expect(await page.click('#temporarily-hidden')).toEqual({});
    expect(
      cdpParams(fixture, 'Runtime.callFunctionOn', (params) =>
        declarationOf(params).includes('setTimeout(finish, 100)'),
      ).length,
    ).toBe(2);
    expect(
      cdpParams(fixture, 'Input.dispatchMouseEvent').some(
        (params) => params.type === 'mouseReleased',
      ),
    ).toBe(true);
  });
});

test('Page click retries when an iframe disappears during session discovery', async () => {
  await withFixture(async (fixture) => {
    let discoveries = 0;
    const discoveryTimeouts: (number | undefined)[] = [];
    const task = taskForRound(fixture, 'round-a', {
      ensureFrameSessions(_targetId, timeoutMs) {
        discoveries += 1;
        discoveryTimeouts.push(timeoutMs);
        if (discoveries === 1) {
          return Promise.reject(new Error('Frame with the given frameId is not found.'));
        }
        return Promise.resolve(new Map<string, string>());
      },
    });
    const page = await openTestPage(task, 'https://example.test/first');

    expect(await page.click('#ready', { timeout: 1_000 })).toEqual({});
    expect(discoveries).toBe(2);
    // The retry runs 50ms later on the remaining budget.
    expect(discoveryTimeouts).toEqual([1_000, 950]);
  });
});
