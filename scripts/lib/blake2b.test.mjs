import { createHash, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { blake2b } from './blake2b.mjs';

describe('blake2b', () => {
  it('matches the published BLAKE2b-256 vectors', () => {
    expect(blake2b(Buffer.alloc(0), 32).toString('hex')).toBe(
      '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8',
    );
    expect(blake2b(Buffer.from('abc'), 32).toString('hex')).toBe(
      'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319',
    );
  });

  it('equals node:crypto blake2b512 for 64-byte digests, across block boundaries', () => {
    for (const length of [0, 1, 104, 127, 128, 129, 255, 256, 257, 1000]) {
      const data = randomBytes(length);
      expect(blake2b(data, 64).toString('hex'), `length ${String(length)}`).toBe(
        createHash('blake2b512').update(data).digest('hex'),
      );
    }
  });

  it('rejects digest lengths outside 1–64', () => {
    expect(() => blake2b(Buffer.alloc(1), 0)).toThrow(RangeError);
    expect(() => blake2b(Buffer.alloc(1), 65)).toThrow(RangeError);
  });
});
