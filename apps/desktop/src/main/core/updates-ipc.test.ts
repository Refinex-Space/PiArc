import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_MS,
  UpdateScheduler,
  installUpdate,
  parseInstallPlan,
  type Installer,
} from './updates-ipc.js';

describe('parseInstallPlan', () => {
  it('reads the macOS and Windows plans Core answers', () => {
    expect(
      parseInstallPlan('{"platform":"macos","version":"1.1.0","archive":"/c/PiArc.zip"}'),
    ).toEqual({ platform: 'macos', version: '1.1.0', archive: '/c/PiArc.zip' });
    expect(parseInstallPlan('{"platform":"windows","version":"1.1.0","feed":"C:\\\\u"}')).toEqual({
      platform: 'windows',
      version: '1.1.0',
      feed: 'C:\\u',
    });
  });

  it('rejects anything else', () => {
    for (const bad of [
      '{}',
      '[]',
      '{"platform":"linux","version":"1.0.0","archive":"x"}',
      '{"platform":"macos","version":"1.0.0"}',
      '{"platform":"windows","version":1,"feed":"x"}',
    ]) {
      expect(() => parseInstallPlan(bad), bad).toThrow(TypeError);
    }
  });
});

function installer(
  overrides: Partial<Installer> = {},
): Installer & { quit: ReturnType<typeof vi.fn> } {
  const quit = vi.fn();
  return {
    confirmQuit: () => Promise.resolve(true),
    install: () => Promise.resolve({ kind: 'restarting' }),
    ...overrides,
    quit,
  };
}

const PLAN = '{"platform":"macos","version":"1.1.0","archive":"/c/PiArc.zip"}';

describe('installUpdate', () => {
  it('quits after the platform step starts the restart', async () => {
    const install = vi.fn(() => Promise.resolve({ kind: 'restarting' } as const));
    const target = installer({ install });
    const outcome = await installUpdate({ updateInstallPlan: () => Promise.resolve(PLAN) }, target);
    expect(outcome).toEqual({ kind: 'restarting' });
    expect(install).toHaveBeenCalledWith({
      platform: 'macos',
      version: '1.1.0',
      archive: '/c/PiArc.zip',
    });
    expect(target.quit).toHaveBeenCalledOnce();
  });

  it('installs nothing when the user keeps PiArc running', async () => {
    const install = vi.fn();
    const target = installer({ confirmQuit: () => Promise.resolve(false), install });
    const outcome = await installUpdate({ updateInstallPlan: () => Promise.resolve(PLAN) }, target);
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(install).not.toHaveBeenCalled();
    expect(target.quit).not.toHaveBeenCalled();
  });

  it('stays running when the update must be installed by hand', async () => {
    const target = installer({
      install: () => Promise.resolve({ kind: 'manual', reason: 'translocated' }),
    });
    const outcome = await installUpdate({ updateInstallPlan: () => Promise.resolve(PLAN) }, target);
    expect(outcome).toEqual({ kind: 'manual', reason: 'translocated' });
    expect(target.quit).not.toHaveBeenCalled();
  });

  it('does not ask to quit when Core has nothing ready', async () => {
    const confirmQuit = vi.fn(() => Promise.resolve(true));
    await expect(
      installUpdate(
        { updateInstallPlan: () => Promise.reject(new Error('no downloaded update is ready')) },
        installer({ confirmQuit }),
      ),
    ).rejects.toThrow('no downloaded update is ready');
    expect(confirmQuit).not.toHaveBeenCalled();
  });
});

describe('UpdateScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function scheduler(enabled: () => boolean) {
    const check = vi.fn(() => Promise.resolve());
    const s = new UpdateScheduler({
      check,
      enabled,
      now: () => Date.now(),
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (timer) => {
        clearTimeout(timer as ReturnType<typeof setTimeout>);
      },
    });
    return { s, check };
  }

  it('checks 30 s after start and again a day later', async () => {
    const { s, check } = scheduler(() => true);
    s.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 60 * 60 * 1000);
    expect(check).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(check).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('does not check while the user turned it off, and resumes when turned on', async () => {
    let on = false;
    const { s, check } = scheduler(() => on);
    s.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS + 3 * 60 * 60 * 1000);
    expect(check).not.toHaveBeenCalled();
    on = true;
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(check).toHaveBeenCalledOnce();
    s.stop();
  });

  it('keeps running after a failed check', async () => {
    const check = vi.fn(() => Promise.reject(new Error('offline')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = new UpdateScheduler({
      check,
      enabled: () => true,
      now: () => Date.now(),
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (timer) => {
        clearTimeout(timer as ReturnType<typeof setTimeout>);
      },
    });
    s.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
    s.stop();
    warn.mockRestore();
  });
});
