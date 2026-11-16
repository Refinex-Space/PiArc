// BLAKE2b with a chosen digest length (RFC 7693), unkeyed. Node's crypto only offers the
// 64-byte `blake2b512`; minisign's secret-key checksum is BLAKE2b-256 (a different
// parameter block, not a truncation). Only scripts/release/release-manifest.mjs uses it, on
// inputs of about a hundred bytes; signatures themselves go through node:crypto.
// blake2b.test.mjs checks it against node:crypto for 64-byte digests and against the
// published BLAKE2b-256 vectors.

const MASK = (1n << 64n) - 1n;

const IV = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
];

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

/**
 * @param {bigint} x
 * @param {bigint} n
 */
function rotr(x, n) {
  return ((x >> n) | (x << (64n - n))) & MASK;
}

/**
 * The compression function F.
 * @param {bigint[]} h state, updated in place
 * @param {Uint8Array} block 128 bytes
 * @param {bigint} t bytes compressed so far, including this block
 * @param {boolean} last
 */
function compress(h, block, t, last) {
  const view = new DataView(block.buffer, block.byteOffset, 128);
  const m = Array.from({ length: 16 }, (_, i) => view.getBigUint64(i * 8, true));
  const v = [...h, ...IV];
  v[12] = (v[12] ?? 0n) ^ (t & MASK);
  v[13] = (v[13] ?? 0n) ^ (t >> 64n);
  if (last) {
    v[14] = (v[14] ?? 0n) ^ MASK;
  }
  /** @type {(a: number, b: number, c: number, d: number, x: bigint, y: bigint) => void} */
  const g = (a, b, c, d, x, y) => {
    const at = (/** @type {number} */ i) => v[i] ?? 0n;
    v[a] = (at(a) + at(b) + x) & MASK;
    v[d] = rotr(at(d) ^ at(a), 32n);
    v[c] = (at(c) + at(d)) & MASK;
    v[b] = rotr(at(b) ^ at(c), 24n);
    v[a] = (at(a) + at(b) + y) & MASK;
    v[d] = rotr(at(d) ^ at(a), 16n);
    v[c] = (at(c) + at(d)) & MASK;
    v[b] = rotr(at(b) ^ at(c), 63n);
  };
  for (let round = 0; round < 12; round += 1) {
    const s = SIGMA[round % 10] ?? [];
    const word = (/** @type {number} */ i) => m[s[i] ?? 0] ?? 0n;
    g(0, 4, 8, 12, word(0), word(1));
    g(1, 5, 9, 13, word(2), word(3));
    g(2, 6, 10, 14, word(4), word(5));
    g(3, 7, 11, 15, word(6), word(7));
    g(0, 5, 10, 15, word(8), word(9));
    g(1, 6, 11, 12, word(10), word(11));
    g(2, 7, 8, 13, word(12), word(13));
    g(3, 4, 9, 14, word(14), word(15));
  }
  for (let i = 0; i < 8; i += 1) {
    h[i] = (h[i] ?? 0n) ^ (v[i] ?? 0n) ^ (v[i + 8] ?? 0n);
  }
}

/**
 * BLAKE2b of `data` with an `outlen`-byte digest (1–64).
 * @param {Uint8Array} data
 * @param {number} outlen
 * @returns {Buffer}
 */
export function blake2b(data, outlen) {
  if (!Number.isInteger(outlen) || outlen < 1 || outlen > 64) {
    throw new RangeError(`BLAKE2b digest length must be 1–64 bytes, got ${String(outlen)}`);
  }
  const h = [...IV];
  h[0] = (h[0] ?? 0n) ^ (0x01010000n | BigInt(outlen));
  const blocks = Math.max(1, Math.ceil(data.length / 128));
  for (let i = 0; i < blocks; i += 1) {
    const block = new Uint8Array(128);
    const chunk = data.subarray(i * 128, (i + 1) * 128);
    block.set(chunk);
    const last = i === blocks - 1;
    compress(h, block, BigInt(last ? data.length : (i + 1) * 128), last);
  }
  const out = Buffer.alloc(64);
  h.forEach((word, i) => out.writeBigUInt64LE(word, i * 8));
  return out.subarray(0, outlen);
}
