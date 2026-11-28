import { describe, expect, it } from 'vitest';

import { KeepAwake, type PowerBlocker } from './keep-awake.js';

function fakeBlocker() {
  const started: number[] = [];
  const stopped: number[] = [];
  let next = 1;
  const port: PowerBlocker = {
    start: () => {
      const id = next++;
      started.push(id);
      return id;
    },
    stop: (id) => {
      stopped.push(id);
    },
  };
  return { port, started, stopped };
}

describe('KeepAwake', () => {
  it('holds one blocker while a session runs and releases it when none does', () => {
    const { port, started, stopped } = fakeBlocker();
    const awake = new KeepAwake(port, true);
    expect(awake.held()).toBe(false);
    awake.setRunning(2);
    awake.setRunning(1);
    expect(started).toEqual([1]);
    expect(awake.held()).toBe(true);
    awake.setRunning(0);
    expect(stopped).toEqual([1]);
    expect(awake.held()).toBe(false);
  });

  it('follows the setting both ways while work goes on', () => {
    const { port, started, stopped } = fakeBlocker();
    const awake = new KeepAwake(port, false);
    awake.setRunning(1);
    expect(awake.held()).toBe(false);
    awake.setEnabled(true);
    expect(started).toEqual([1]);
    awake.setEnabled(false);
    expect(stopped).toEqual([1]);
    expect(awake.held()).toBe(false);
  });

  it('releases on dispose and takes no new hold after it', () => {
    const { port, started, stopped } = fakeBlocker();
    const awake = new KeepAwake(port, true);
    awake.setRunning(1);
    awake.dispose();
    expect(stopped).toEqual([1]);
    awake.setRunning(3);
    awake.setEnabled(true);
    expect(started).toEqual([1]);
  });

  it('stays usable when the system refuses the blocker', () => {
    const awake = new KeepAwake(
      {
        start: () => {
          throw new Error('no power service');
        },
        stop: () => undefined,
      },
      true,
    );
    expect(() => {
      awake.setRunning(1);
    }).not.toThrow();
    expect(awake.held()).toBe(false);
  });
});
