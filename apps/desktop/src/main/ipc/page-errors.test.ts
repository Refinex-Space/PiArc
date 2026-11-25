import { describe, expect, it } from 'vitest';

import { answer } from './page-errors.js';

const coreError = (kind: string, message: string) =>
  Object.assign(new Error(message), { code: -32000, data: { kind, retryable: false } });

describe('handler errors on their way to the page (I236)', () => {
  it('writes a Core error kind into the message, thrown or rejected', async () => {
    expect(() =>
      answer(() => {
        throw coreError('sessionNotFound', 'no open session s1');
      }),
    ).toThrow(/^\[piarc:sessionNotFound\] no open session s1$/u);
    await expect(
      answer(() => Promise.reject(coreError('busy', 'the queue is full'))),
    ).rejects.toThrow(/^\[piarc:busy\] the queue is full$/u);
  });

  it("passes the main process's own errors and results through unchanged", async () => {
    const own = new TypeError('Expected a session id');
    expect(() =>
      answer(() => {
        throw own;
      }),
    ).toThrow(own);
    await expect(answer(() => Promise.resolve('{"ok":true}'))).resolves.toBe('{"ok":true}');
    expect(answer(() => 3)).toBe(3);
  });
});
