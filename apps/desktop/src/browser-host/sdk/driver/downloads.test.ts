// Ported from ego-browser package/ego-browser/src/driver/downloads.test.mjs (ego-lite commit
// 56589ea8, MIT, see LICENSE). PiArc: Vitest; no download directory: completion comes from
// Page.downloadProgress, saveAs goes through the saveFile binding (FakeBindings), and no test may
// see Page.setDownloadBehavior. Tests of the shared directory, cross-process waiter markers, file
// polling and .crdownload files are dropped; where a test's intent still applies it is kept with
// the PiArc mechanism (in-progress events, target reservation, disposal).

import { afterEach, expect, test } from 'vitest';

import { FakeBindings, fakeCdp, installBindings } from '../../testing.js';
import type { CdpEvent, CdpObject } from '../cdp-types.js';
import { disposeDownloadArtifacts, preparePageDownload } from './downloads.js';

interface RecordedCall {
  method: string;
  params: CdpObject;
  sessionId: string | undefined;
}

interface RecordingServices {
  calls: RecordedCall[];
  listeners: Map<string, (event: CdpEvent) => void>;
  answer: (method: string, params: CdpObject) => unknown;
  services: Parameters<typeof preparePageDownload>[0];
}

let restoreBindings: (() => void) | undefined;

afterEach(() => {
  disposeDownloadArtifacts();
  restoreBindings?.();
  restoreBindings = undefined;
});

function recordingServices(): RecordingServices {
  const recording: RecordingServices = {
    calls: [],
    listeners: new Map(),
    answer: () => ({}),
    services: {
      cdp: fakeCdp((method, params, sessionId) => {
        recording.calls.push({ method, params, sessionId });
        return recording.answer(method, params);
      }),
      subscribePageEvents(targetId, listener) {
        recording.listeners.set(targetId, listener);
        return () => recording.listeners.delete(targetId);
      },
    },
  };
  return recording;
}

function installFakeBindings(): FakeBindings {
  const bindings = new FakeBindings();
  restoreBindings = installBindings(bindings);
  return bindings;
}

function dispatch(recording: RecordingServices, targetId: string, event: CdpObject): void {
  const listener = recording.listeners.get(targetId);
  if (!listener) throw new Error(`no download listener for ${targetId}`);
  listener(event as unknown as CdpEvent);
}

function beginDownload(
  recording: RecordingServices,
  targetId: string,
  guid: string,
  suggestedFilename: string,
): void {
  dispatch(recording, targetId, {
    method: 'Page.downloadWillBegin',
    params: { guid, url: `https://example.test/${guid}`, suggestedFilename },
  });
}

function completeDownload(
  recording: RecordingServices,
  targetId: string,
  guid: string,
  /** null: the event names no staged file. */
  filePath: string | null = `staged/${guid}`,
): void {
  dispatch(recording, targetId, {
    method: 'Page.downloadProgress',
    params: { guid, state: 'completed', ...(filePath === null ? {} : { filePath }) },
  });
}

function behaviorCalls(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter(
    (call) =>
      call.method === 'Page.setDownloadBehavior' || call.method === 'Browser.setDownloadBehavior',
  );
}

test('a page download is staged under its guid and can be saved', async () => {
  const bindings = installFakeBindings();
  const recording = recordingServices();
  const interception = preparePageDownload(recording.services, 'target-1', {
    timeoutMs: 1_000,
  });

  await interception.ready('session-1');
  expect(recording.calls, 'the main process owns the download directory').toEqual([]);

  beginDownload(recording, 'target-1', 'guid-1', 'report.txt');
  const download = await interception.event;
  completeDownload(recording, 'target-1', 'guid-1');

  expect(download.url).toBe('https://example.test/guid-1');
  expect(download.suggestedFilename).toBe('report.txt');
  expect(await download.failure()).toBeNull();
  await download.cancel();
  expect(
    recording.calls.some((call) => call.method === 'Browser.cancelDownload'),
    'cancel is a no-op after completion',
  ).toBe(false);
  expect(await download.path()).toBe('staged/guid-1');
  await download.saveAs('/Users/agent/saved.txt');
  expect(bindings.calls.filter(([name]) => name === 'saveFile')).toEqual([
    ['saveFile', 'guid-1', '/Users/agent/saved.txt'],
  ]);
  expect(behaviorCalls(recording.calls)).toEqual([]);

  await download.delete();
  await expect(download.saveAs('/Users/agent/again.txt')).rejects.toThrow(/was deleted/);
});

test('saveAs waits for an in-progress download', async () => {
  const bindings = installFakeBindings();
  const recording = recordingServices();
  const interception = preparePageDownload(recording.services, 'target-slow', {
    timeoutMs: 1_000,
  });
  await interception.ready('session-slow');
  beginDownload(recording, 'target-slow', 'guid-slow', 'slow.txt');
  const download = await interception.event;
  let saved = false;
  const save = download.saveAs('C:\\Users\\agent\\slow.txt').then(() => {
    saved = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(saved).toBe(false);
  expect(bindings.calls.some(([name]) => name === 'saveFile')).toBe(false);
  completeDownload(recording, 'target-slow', 'guid-slow');

  await save;
  expect(bindings.calls.filter(([name]) => name === 'saveFile')).toEqual([
    ['saveFile', 'guid-slow', 'C:\\Users\\agent\\slow.txt'],
  ]);
  await download.delete();
});

test('an in-progress event does not complete the download', async () => {
  const recording = recordingServices();
  const interception = preparePageDownload(recording.services, 'target-partial', {
    timeoutMs: 1_000,
  });
  await interception.ready('session-partial');
  beginDownload(recording, 'target-partial', 'guid-partial', 'partial.bin');
  const download = await interception.event;
  dispatch(recording, 'target-partial', {
    method: 'Page.downloadProgress',
    params: { guid: 'guid-partial', state: 'inProgress', receivedBytes: 7, totalBytes: 70 },
  });
  let state = 'pending';
  const path = download.path().then(
    (value) => {
      state = 'resolved';
      return value;
    },
    () => {
      state = 'rejected';
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(state, 'an intermediate state is not the download').toBe('pending');

  completeDownload(recording, 'target-partial', 'guid-partial');
  expect(await path).toBe('staged/guid-partial');
  await download.delete();
});

test('path falls back to the guid when the completed event names no file', async () => {
  const recording = recordingServices();
  const interception = preparePageDownload(recording.services, 'target-unnamed', {
    timeoutMs: 1_000,
  });
  beginDownload(recording, 'target-unnamed', 'guid-unnamed', 'unnamed.bin');
  const download = await interception.event;
  completeDownload(recording, 'target-unnamed', 'guid-unnamed', null);

  expect(await download.path()).toBe('guid-unnamed');
});

test('events for another download guid are ignored', async () => {
  const recording = recordingServices();
  const interception = preparePageDownload(recording.services, 'target-other', {
    timeoutMs: 1_000,
  });
  beginDownload(recording, 'target-other', 'guid-mine', 'mine.bin');
  const download = await interception.event;
  completeDownload(recording, 'target-other', 'guid-theirs');
  let done = false;
  void download.finished.then(() => {
    done = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(done).toBe(false);
  completeDownload(recording, 'target-other', 'guid-mine');
  expect(await download.path()).toBe('staged/guid-mine');
});

test('saveAs requires an absolute file path', async () => {
  installFakeBindings();
  const recording = recordingServices();
  const interception = preparePageDownload(recording.services, 'target-relative', {
    timeoutMs: 1_000,
  });
  beginDownload(recording, 'target-relative', 'guid-relative', 'relative.txt');
  const download = await interception.event;
  completeDownload(recording, 'target-relative', 'guid-relative');

  await expect(download.saveAs('downloads/relative.txt')).rejects.toThrow(
    /download\.saveAs requires an absolute file path/,
  );
  await expect(download.saveAs('')).rejects.toThrow(/requires an absolute file path/);
  await download.saveAs('\\\\server\\share\\relative.txt');
});

test('saveAs reports a refused save from the binding', async () => {
  const bindings = new FakeBindings({
    saveFile: () =>
      Promise.resolve({
        error: 'Writing outside the workspace was denied',
        error_code: 'PIARC_FILE_REFUSED',
      }),
  });
  restoreBindings = installBindings(bindings);
  const recording = recordingServices();
  const interception = preparePageDownload(recording.services, 'target-refused', {
    timeoutMs: 1_000,
  });
  beginDownload(recording, 'target-refused', 'guid-refused', 'refused.txt');
  const download = await interception.event;
  completeDownload(recording, 'target-refused', 'guid-refused');

  await expect(download.saveAs('/etc/refused.txt')).rejects.toThrow(
    /download\.saveAs: Writing outside the workspace was denied/,
  );
});

test('cancel scopes the download guid to its browser context', async () => {
  const recording = recordingServices();
  recording.answer = (method) => {
    if (method === 'Target.getTargetInfo') {
      return { targetInfo: { browserContextId: 'context-1' } };
    }
    return {};
  };
  const interception = preparePageDownload(recording.services, 'target-1', {
    timeoutMs: 1_000,
  });
  await interception.ready('session-1');
  beginDownload(recording, 'target-1', 'guid-cancel', 'archive.zip');
  const download = await interception.event;

  await download.cancel();
  dispatch(recording, 'target-1', {
    method: 'Page.downloadProgress',
    params: { guid: 'guid-cancel', state: 'canceled' },
  });

  expect(
    recording.calls.some(
      (call) =>
        call.method === 'Browser.cancelDownload' &&
        call.params.guid === 'guid-cancel' &&
        call.params.browserContextId === 'context-1' &&
        call.sessionId === undefined,
    ),
  ).toBe(true);
  expect(behaviorCalls(recording.calls)).toEqual([]);
  expect(await download.failure()).toBe('canceled');
  await expect(download.path()).rejects.toThrow(/download failed: canceled/);
  await download.delete();
});

test('ready rejects once the waiter is no longer active', async () => {
  const recording = recordingServices();
  const interception = preparePageDownload(recording.services, 'target-rejected', {
    timeoutMs: 1_000,
  });
  void interception.event.catch(() => undefined);

  await interception.dispose(new Error('arming failed'));
  await expect(interception.event).rejects.toThrow(/arming failed/);
  await expect(interception.ready('session-rejected')).rejects.toThrow(
    /download waiter is no longer active/,
  );
  expect(recording.calls).toEqual([]);
});

test('one target cannot arm two download waits at the same time', async () => {
  const recording = recordingServices();
  const first = preparePageDownload(recording.services, 'target-shared', {
    timeoutMs: 1_000,
  });
  void first.event.catch(() => undefined);

  expect(() =>
    preparePageDownload(recording.services, 'target-shared', {
      timeoutMs: 1_000,
    }),
  ).toThrow(/target-shared is already waiting for a download/);

  await first.dispose();
});

test('different targets download concurrently under their own guids', async () => {
  const recording = recordingServices();
  const first = preparePageDownload(recording.services, 'target-a', {
    timeoutMs: 1_000,
  });
  const second = preparePageDownload(recording.services, 'target-b', {
    timeoutMs: 1_000,
  });
  await first.ready('session-a');
  beginDownload(recording, 'target-a', 'guid-a', 'a.txt');
  await second.ready('session-b');
  beginDownload(recording, 'target-b', 'guid-b', 'b.txt');

  const [downloadA, downloadB] = await Promise.all([first.event, second.event]);
  completeDownload(recording, 'target-b', 'guid-b');
  completeDownload(recording, 'target-a', 'guid-a');

  expect(await downloadA.path()).toBe('staged/guid-a');
  expect(await downloadB.path()).toBe('staged/guid-b');
  expect(behaviorCalls(recording.calls)).toEqual([]);
  await Promise.all([downloadA.delete(), downloadB.delete()]);
});

test('a download wait times out', async () => {
  const recording = recordingServices();
  const interception = preparePageDownload(recording.services, 'target-timeout', {
    timeoutMs: 5,
  });
  await interception.ready('session-timeout');

  await expect(interception.event).rejects.toThrow(
    /page\.waitForEvent\("download"\) timed out after 5ms/,
  );
  expect(recording.listeners.has('target-timeout'), 'the waiter unsubscribes').toBe(false);
  const next = preparePageDownload(recording.services, 'target-timeout', {
    timeoutMs: 1_000,
  });
  void next.event.catch(() => undefined);
  await next.dispose();
});

test('the target stays reserved until its download finishes', async () => {
  const recording = recordingServices();
  const first = preparePageDownload(recording.services, 'target-restoring', {
    timeoutMs: 1_000,
  });
  await first.ready('session-restoring');
  beginDownload(recording, 'target-restoring', 'guid-restoring', 'restoring.txt');
  const download = await first.event;

  expect(() =>
    preparePageDownload(recording.services, 'target-restoring', {
      timeoutMs: 1_000,
    }),
  ).toThrow(/target-restoring is already waiting for a download/);

  completeDownload(recording, 'target-restoring', 'guid-restoring');
  expect(await download.failure()).toBeNull();
  const next = preparePageDownload(recording.services, 'target-restoring', {
    timeoutMs: 1_000,
  });
  void next.event.catch(() => undefined);
  await next.dispose();
  await download.delete();
});

test('disposing the SDK stops pending download waits', async () => {
  const recording = recordingServices();
  const waiting = preparePageDownload(recording.services, 'target-dispose', {
    timeoutMs: 1_000,
  });
  const started = preparePageDownload(recording.services, 'target-started', {
    timeoutMs: 1_000,
  });
  beginDownload(recording, 'target-started', 'guid-started', 'started.txt');
  const download = await started.event;

  disposeDownloadArtifacts();

  await expect(waiting.event).rejects.toThrow(/download waiter was disposed/);
  expect(await download.failure()).toBe('download waiter was disposed');
  expect(recording.listeners.size).toBe(0);
  const again = preparePageDownload(recording.services, 'target-dispose', {
    timeoutMs: 1_000,
  });
  void again.event.catch(() => undefined);
  await again.dispose();
});
