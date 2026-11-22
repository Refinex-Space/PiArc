import { describe, expect, it } from 'vitest';

import { REMOTE_DEBUGGING_SWITCHES, refuseRemoteDebugging } from './runtime-switches.js';

function commandLine(present: string[]) {
  const switches = new Set(present);
  return {
    switches,
    hasSwitch: (name: string) => switches.has(name),
    removeSwitch: (name: string) => {
      switches.delete(name);
    },
  };
}

describe('remote debugging in release builds (THR-12)', () => {
  it('THR-12 removes and reports the remote debugging switches and nothing else', () => {
    const line = commandLine(['remote-debugging-port', 'remote-debugging-pipe', 'lang']);
    expect(refuseRemoteDebugging(line)).toEqual([...REMOTE_DEBUGGING_SWITCHES]);
    expect([...line.switches]).toEqual(['lang']);
    expect(refuseRemoteDebugging(commandLine(['user-data-dir']))).toEqual([]);
  });
});
