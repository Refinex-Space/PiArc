// PiArc tests for driver/page-input.ts (ported from ego-browser, ego-lite commit 56589ea8, MIT, see
// LICENSE; upstream has no test of its own): files reach Chromium only as staged copies, and the
// absolute-path check works without node:path.

import { expect, test } from 'vitest';

import { fakeCdp } from '../../testing.js';
import type { CdpObject } from '../cdp-types.js';
import { normalizeFilePaths, setFilesOnBackendNode } from './page-input.js';

function services(stage: (paths: readonly string[]) => readonly string[]) {
  const calls: [string, CdpObject, string | undefined][] = [];
  const staged: (readonly string[])[] = [];
  return {
    calls,
    staged,
    services: {
      cdp: fakeCdp((method, params, sessionId) => {
        calls.push([method, params, sessionId]);
        return {};
      }),
      stageUpload(paths: readonly string[]) {
        staged.push(paths);
        return Promise.resolve(stage(paths));
      },
    },
  };
}

test('setFilesOnBackendNode passes only the staged copies to DOM.setFileInputFiles', async () => {
  const fixture = services((paths) => paths.map((_, index) => `/staged/${String(index)}`));

  await setFilesOnBackendNode(fixture.services, 'session-1', ['/home/a.txt', 'C:\\b.txt'], 42);

  expect(fixture.staged).toEqual([['/home/a.txt', 'C:\\b.txt']]);
  expect(fixture.calls).toEqual([
    [
      'DOM.setFileInputFiles',
      { files: ['/staged/0', '/staged/1'], backendNodeId: 42 },
      'session-1',
    ],
  ]);
});

test('setFilesOnBackendNode refuses a staging answer that does not match the files', async () => {
  const fixture = services(() => ['/staged/0']);

  await expect(
    setFilesOnBackendNode(fixture.services, 'session-1', ['/a', '/b'], undefined, 'object-1'),
  ).rejects.toThrow('file staging answered 1 paths for 2 files');
  expect(fixture.calls).toEqual([]);
});

test('normalizeFilePaths accepts absolute paths of both platforms', () => {
  expect(normalizeFilePaths('/tmp/a.txt', 'page.setInputFiles')).toEqual(['/tmp/a.txt']);
  expect(
    normalizeFilePaths(['C:\\data\\a.txt', 'D:/b.txt', '\\\\server\\share\\c.txt'], 'x'),
  ).toEqual(['C:\\data\\a.txt', 'D:/b.txt', '\\\\server\\share\\c.txt']);
});

test('normalizeFilePaths rejects relative, empty and non-string paths', () => {
  for (const value of ['a.txt', './a.txt', 'C:a.txt', '', ['/ok', 'rel'], [42]]) {
    expect(() => normalizeFilePaths(value as string, 'page.setInputFiles')).toThrow(
      'page.setInputFiles requires absolute file paths',
    );
  }
});
