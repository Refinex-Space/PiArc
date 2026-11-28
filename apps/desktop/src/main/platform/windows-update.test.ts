import { describe, expect, it, vi } from 'vitest';

import { applyWindowsUpdate, type VelopackUpdates } from './windows-update.js';

function manager(found: string | null, installed = true) {
  const apply = vi.fn();
  const download = vi.fn(() => Promise.resolve());
  const updates: VelopackUpdates = {
    getCurrentVersion: () => {
      if (!installed) throw new Error('not installed');
      return '1.0.0';
    },
    checkForUpdatesAsync: () =>
      Promise.resolve(found === null ? null : { TargetFullRelease: { Version: found } }),
    downloadUpdateAsync: download,
    waitExitThenApplyUpdate: apply,
  };
  return { updates, apply, download };
}

describe('applyWindowsUpdate', () => {
  it('copies the verified package and applies it on exit with a restart', async () => {
    const { updates, apply, download } = manager('1.1.0');
    expect(await applyWindowsUpdate(() => updates, '1.1.0')).toBe('applying');
    expect(download).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith({ TargetFullRelease: { Version: '1.1.0' } }, false, true);
  });

  it('THR-09 refuses a version other than the one Core verified', async () => {
    const { updates, apply } = manager('1.2.0');
    await expect(applyWindowsUpdate(() => updates, '1.1.0')).rejects.toThrow(/expected 1.1.0/);
    const none = manager(null);
    await expect(applyWindowsUpdate(() => none.updates, '1.1.0')).rejects.toThrow(/no update/);
    expect(apply).not.toHaveBeenCalled();
  });

  it('answers notInstalled for a copy Velopack did not install', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { updates } = manager('1.1.0', false);
    expect(await applyWindowsUpdate(() => updates, '1.1.0')).toBe('notInstalled');
    expect(
      await applyWindowsUpdate(() => {
        throw new Error('no binding');
      }, '1.1.0'),
    ).toBe('notInstalled');
    warn.mockRestore();
  });
});
