import { describe, expect, it } from 'vitest';

import { coreErrorKind, decodeIpcError, encodeIpcError } from './ipc-error.js';

describe('Core errors across IPC (I236)', () => {
  it('carries the kind in front of the message and reads it back', () => {
    const message = encodeIpcError('sessionBusy', 'a turn is running\nsecond line');
    expect(message).toBe('[piarc:sessionBusy] a turn is running\nsecond line');
    expect(decodeIpcError(message)).toEqual({
      kind: 'sessionBusy',
      message: 'a turn is running\nsecond line',
    });
  });

  it('leaves other messages alone', () => {
    expect(decodeIpcError('Expected a session id')).toBeUndefined();
    expect(decodeIpcError('see [piarc:busy] later')).toBeUndefined();
    expect(decodeIpcError('[piarc:not a kind] text')).toBeUndefined();
  });

  it('reads the kind of an error the NAPI boundary threw', () => {
    const core = Object.assign(new Error('no open session s1'), {
      code: -32001,
      data: { kind: 'sessionNotFound', retryable: false },
    });
    expect(coreErrorKind(core)).toBe('sessionNotFound');
    expect(coreErrorKind(new TypeError('bad argument'))).toBeUndefined();
    expect(coreErrorKind(Object.assign(new Error('x'), { data: { kind: 'a b' } }))).toBeUndefined();
    expect(coreErrorKind('sessionNotFound')).toBeUndefined();
  });
});
