import { afterEach, describe, expect, it } from 'vitest';

import { setErrorLocale } from '../app/error-text.js';
import { encodeIpcError } from '../../shared/ipc-error.js';
import { failureKind, reason } from './errors.js';

/** What `ipcRenderer.invoke` rejects with when the main process threw `message`. */
const invoked = (message: string) =>
  new Error(`Error invoking remote method 'piarc:prompt': Error: ${message}`);

afterEach(() => {
  setErrorLocale('en');
});

describe('the reason of a failed call (I236)', () => {
  it("describes a Core error by its kind in the window's language", () => {
    const offline = invoked(encodeIpcError('hostUnavailable', 'the Agent Host stopped'));
    expect(reason(offline)).toBe('The Agent Host is not available: the Agent Host stopped');
    setErrorLocale('zh-CN');
    expect(reason(offline)).toBe('Agent Host 不可用：the Agent Host stopped');
    expect(reason(invoked(encodeIpcError('sessionBusy', 'a turn is running')))).toBe(
      '会话正忙，请等当前步骤结束。',
    );
    expect(failureKind(offline)).toBe('hostUnavailable');
  });

  it("keeps Core's text for a kind the catalog does not name", () => {
    setErrorLocale('zh-CN');
    expect(reason(invoked(encodeIpcError('frameTooLarge', 'frame of 9 MiB')))).toBe(
      'frame of 9 MiB',
    );
  });

  it("shows the main process's own errors and the page's as written", () => {
    expect(reason(new Error("Error invoking remote method 'piarc:x': TypeError: bad id"))).toBe(
      'bad id',
    );
    expect(reason(new Error('Could not encode the image'))).toBe('Could not encode the image');
    expect(reason('plain')).toBe('plain');
    expect(failureKind(new Error('bad id'))).toBeUndefined();
  });
});
