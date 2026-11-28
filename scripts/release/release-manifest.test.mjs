import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildManifest,
  generateKeyPair,
  MANIFEST_FORMAT,
  parsePublicKey,
  parseSecretKey,
  serializeManifest,
  signData,
  trustedCommentFor,
  verifyData,
} from './release-manifest.mjs';

const keys = path.join(import.meta.dirname, 'test-keys');
const secret = parseSecretKey(readFileSync(path.join(keys, 'release-manifest.test.key'), 'utf8'));
const publicKey = parsePublicKey(
  readFileSync(path.join(keys, 'release-manifest.test.pub'), 'utf8'),
);
const otherSecret = parseSecretKey(readFileSync(path.join(keys, 'other.test.key'), 'utf8'));

/** @param {string} text */
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'piarc manifest 清单-'));
  await writeFile(path.join(dir, 'PiArc-0.1.0-arm64.dmg'), 'dmg bytes');
  await writeFile(path.join(dir, 'PiArc-0.1.0-arm64.zip'), 'zip bytes, longer');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('release manifests', () => {
  it('lists name, size and SHA-256 of every artefact, sorted by name', async () => {
    const manifest = await buildManifest({
      product: 'PiArc',
      version: '0.1.0',
      files: [path.join(dir, 'PiArc-0.1.0-arm64.zip'), path.join(dir, 'PiArc-0.1.0-arm64.dmg')],
      createdAt: new Date('2026-11-16T00:00:00Z'),
    });
    expect(manifest).toEqual({
      format: MANIFEST_FORMAT,
      product: 'PiArc',
      version: '0.1.0',
      createdAt: '2026-11-16T00:00:00.000Z',
      files: [
        { name: 'PiArc-0.1.0-arm64.dmg', size: 9, sha256: sha256('dmg bytes') },
        { name: 'PiArc-0.1.0-arm64.zip', size: 17, sha256: sha256('zip bytes, longer') },
      ],
    });
  });

  it('refuses a version that is not SemVer and duplicate file names', async () => {
    await expect(buildManifest({ product: 'PiArc', version: 'v1', files: [] })).rejects.toThrow(
      'SemVer',
    );
    const file = path.join(dir, 'PiArc-0.1.0-arm64.dmg');
    await expect(
      buildManifest({ product: 'PiArc', version: '0.1.0', files: [file, file] }),
    ).rejects.toThrow('same file name');
  });

  it('signs in minisign format and verifies the signature and trusted comment', () => {
    const bytes = Buffer.from('{"format":"x"}\n');
    const comment = trustedCommentFor('piarc-release-manifest.json', new Date(1_700_000_000_000));
    const signature = signData(bytes, secret, comment);
    const lines = signature.split('\n');
    expect(lines[0]).toMatch(/^untrusted comment: /);
    expect(
      Buffer.from(lines[1] ?? '', 'base64')
        .subarray(0, 2)
        .toString(),
    ).toBe('ED');
    expect(lines[2]).toBe(`trusted comment: ${comment}`);
    expect(verifyData(bytes, signature, publicKey)).toBe(comment);
  });

  it('rejects changed content, a changed trusted comment and another key', () => {
    const bytes = serializeManifest({
      format: MANIFEST_FORMAT,
      product: 'PiArc',
      version: '0.1.0',
      createdAt: '2026-11-16T00:00:00.000Z',
      files: [],
    });
    const signature = signData(bytes, secret, trustedCommentFor('m.json'));
    const changed = Buffer.from(bytes.toString().replace('0.1.0', '0.1.1'));
    expect(() => verifyData(changed, signature, publicKey)).toThrow(
      'signature verification failed',
    );
    const lines = signature.split('\n');
    lines[2] = 'trusted comment: timestamp:1\tfile:other.json\tprehashed';
    expect(() => verifyData(bytes, lines.join('\n'), publicKey)).toThrow('trusted comment');
    const foreign = signData(bytes, otherSecret, trustedCommentFor('m.json'));
    expect(() => verifyData(bytes, foreign, publicKey)).toThrow('signed by key');
  });

  it('round-trips a generated key pair and detects a damaged secret key', () => {
    const pair = generateKeyPair('PiArc unit test');
    const key = parseSecretKey(pair.secretKeyText);
    const pub = parsePublicKey(pair.publicKeyText);
    const bytes = Buffer.from('hello');
    expect(verifyData(bytes, signData(bytes, key, 'c'), pub)).toBe('c');
    const lines = pair.secretKeyText.split('\n');
    const bin = Buffer.from(lines[1] ?? '', 'base64');
    bin[100] = (bin[100] ?? 0) ^ 1;
    lines[1] = bin.toString('base64');
    expect(() => parseSecretKey(lines.join('\n'))).toThrow('checksum');
  });
});
