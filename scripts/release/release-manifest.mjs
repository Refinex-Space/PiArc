// Release manifests (ADR-0018 rule 4, ADR-0024): one JSON file per release that lists every
// artefact's name, size and SHA-256, signed with an Ed25519 key in minisign's format. The app
// verifies the signature with a built-in public key and then each downloaded file's size and
// hash (`piarc_core::release`); either failure refuses the update.
//
//   node scripts/release/release-manifest.mjs generate --version <semver> --key <secret key>
//        [--out <manifest.json>] [--product PiArc] <artefact>…
//       Writes the manifest and <manifest>.minisig next to it.
//   node scripts/release/release-manifest.mjs verify --pub <public key> <manifest.json>
//        [--files-dir <dir>]
//       Checks the signature and, with --files-dir, every listed file.
//   node scripts/release/release-manifest.mjs keygen --out-dir <dir> --name <name>
//       Writes an unencrypted key pair <name>.key / <name>.pub. Only for test keys: the release
//       key is generated and kept by T50 in the protected release environment.
//
// Formats (https://jedisct1.github.io/minisign/): public key "Ed" ‖ key id ‖ key; signature
// "ED" (prehashed: Ed25519 over BLAKE2b-512 of the file) ‖ key id ‖ signature, then a trusted
// comment and the global signature over signature ‖ trusted comment. The secret key file is
// minisign's, with the "no KDF" setting (`minisign -G -W`); only such keys are read here.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';

import { blake2b } from '../lib/blake2b.mjs';
import { isMain, isRecord } from '../lib/repo.mjs';

/** Value of the manifest's `format` member. */
export const MANIFEST_FORMAT = 'piarc-release-manifest/1';

const SIG_ALG = Buffer.from('Ed');
const SIG_ALG_PREHASHED = Buffer.from('ED');
const KDF_NONE = Buffer.from([0, 0]);
const CHK_ALG = Buffer.from('B2');

/**
 * @typedef {{ keyId: Buffer, seed: Buffer, publicKey: Buffer }} SecretKey
 * @typedef {{ keyId: Buffer, publicKey: Buffer }} PublicKey
 * @typedef {{ name: string, size: number, sha256: string }} ManifestFile
 * @typedef {{ format: string, product: string, version: string, createdAt: string,
 *   files: ManifestFile[] }} Manifest
 */

/** @param {Buffer} keyId */
function keyIdHex(keyId) {
  return Buffer.from(keyId).reverse().toString('hex').toUpperCase();
}

/**
 * The second line of a minisign file (the base64 payload), after its untrusted comment.
 * @param {string} text
 * @param {string} what
 */
function payloadLine(text, what) {
  const lines = text.split(/\r?\n/);
  if (!(lines[0] ?? '').startsWith('untrusted comment: ') || lines[1] === undefined) {
    throw new Error(`not a minisign ${what}: missing "untrusted comment:" line or payload`);
  }
  return Buffer.from(lines[1].trim(), 'base64');
}

/**
 * A new unencrypted key pair in minisign's file formats.
 * @param {string} comment shown in the files' untrusted comment
 */
export function generateKeyPair(comment) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  if (typeof jwk.d !== 'string' || typeof jwk.x !== 'string') {
    throw new Error('node:crypto returned an Ed25519 key without d and x');
  }
  const seed = Buffer.from(jwk.d, 'base64url');
  const publicKey = Buffer.from(jwk.x, 'base64url');
  const keyId = randomBytes(8);
  const sk = Buffer.concat([seed, publicKey]);
  const checksum = blake2b(Buffer.concat([SIG_ALG, keyId, sk]), 32);
  const secret = Buffer.concat([
    SIG_ALG,
    KDF_NONE,
    CHK_ALG,
    Buffer.alloc(32), // KDF salt, unused without a KDF
    Buffer.alloc(8), // opslimit
    Buffer.alloc(8), // memlimit
    keyId,
    sk,
    checksum,
  ]);
  return {
    keyId: keyIdHex(keyId),
    secretKeyText: `untrusted comment: ${comment} (unencrypted secret key)\n${secret.toString('base64')}\n`,
    publicKeyText: `untrusted comment: minisign public key ${keyIdHex(keyId)}\n${Buffer.concat([SIG_ALG, keyId, publicKey]).toString('base64')}\n`,
  };
}

/**
 * Reads an unencrypted minisign secret key and checks its checksum.
 * @param {string} text
 * @returns {SecretKey}
 */
export function parseSecretKey(text) {
  const bin = payloadLine(text, 'secret key');
  if (bin.length !== 158 || !bin.subarray(0, 2).equals(SIG_ALG)) {
    throw new Error('not an Ed25519 minisign secret key');
  }
  if (!bin.subarray(2, 4).equals(KDF_NONE)) {
    throw new Error('the secret key is encrypted; this tool only reads unencrypted test keys');
  }
  const keyId = bin.subarray(54, 62);
  const sk = bin.subarray(62, 126);
  const checksum = bin.subarray(126, 158);
  if (!blake2b(Buffer.concat([SIG_ALG, keyId, sk]), 32).equals(checksum)) {
    throw new Error('the secret key checksum does not match (damaged key file)');
  }
  return { keyId, seed: sk.subarray(0, 32), publicKey: sk.subarray(32, 64) };
}

/**
 * @param {string} text
 * @returns {PublicKey}
 */
export function parsePublicKey(text) {
  const bin = payloadLine(text, 'public key');
  if (bin.length !== 42 || !bin.subarray(0, 2).equals(SIG_ALG)) {
    throw new Error('not an Ed25519 minisign public key');
  }
  return { keyId: bin.subarray(2, 10), publicKey: bin.subarray(10, 42) };
}

/** @param {SecretKey} key */
function privateKeyObject(key) {
  return createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      d: key.seed.toString('base64url'),
      x: key.publicKey.toString('base64url'),
    },
    format: 'jwk',
  });
}

/** @param {Buffer} publicKey */
function publicKeyObject(publicKey) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: publicKey.toString('base64url') },
    format: 'jwk',
  });
}

/**
 * Signs `data` (prehashed) and returns the `.minisig` text.
 * @param {Buffer} data
 * @param {SecretKey} key
 * @param {string} trustedComment single line, without the "trusted comment: " prefix
 */
export function signData(data, key, trustedComment) {
  if (/[\r\n]/.test(trustedComment)) {
    throw new Error('the trusted comment must be one line');
  }
  const privateKey = privateKeyObject(key);
  const signature = sign(null, createHash('blake2b512').update(data).digest(), privateKey);
  const global = sign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), privateKey);
  return [
    `untrusted comment: signature from minisign secret key ${keyIdHex(key.keyId)}`,
    Buffer.concat([SIG_ALG_PREHASHED, key.keyId, signature]).toString('base64'),
    `trusted comment: ${trustedComment}`,
    global.toString('base64'),
    '',
  ].join('\n');
}

/**
 * Verifies a `.minisig` for `data`; returns the trusted comment or throws.
 * @param {Buffer} data
 * @param {string} signatureText
 * @param {PublicKey} key
 */
export function verifyData(data, signatureText, key) {
  const lines = signatureText.split(/\r?\n/);
  const bin = Buffer.from(lines[1] ?? '', 'base64');
  const trusted = lines[2] ?? '';
  const global = Buffer.from(lines[3] ?? '', 'base64');
  if (bin.length !== 74 || !trusted.startsWith('trusted comment: ') || global.length !== 64) {
    throw new Error('malformed signature');
  }
  if (!bin.subarray(2, 10).equals(key.keyId)) {
    throw new Error(`signed by key ${keyIdHex(bin.subarray(2, 10))}, not ${keyIdHex(key.keyId)}`);
  }
  const prehashed = bin.subarray(0, 2).equals(SIG_ALG_PREHASHED);
  const message = prehashed ? createHash('blake2b512').update(data).digest() : data;
  const signature = bin.subarray(10, 74);
  const publicKey = publicKeyObject(key.publicKey);
  if (!verify(null, message, publicKey, signature)) {
    throw new Error('signature verification failed');
  }
  const comment = trusted.slice('trusted comment: '.length);
  if (!verify(null, Buffer.concat([signature, Buffer.from(comment)]), publicKey, global)) {
    throw new Error('trusted comment verification failed');
  }
  return comment;
}

/**
 * Size and SHA-256 of one artefact.
 * @param {string} file
 * @returns {Promise<ManifestFile>}
 */
export async function describeFile(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return { name: path.basename(file), size: (await stat(file)).size, sha256: hash.digest('hex') };
}

/**
 * The manifest of a release; artefacts must have distinct file names.
 * @param {{ product: string, version: string, files: string[], createdAt?: Date }} options
 * @returns {Promise<Manifest>}
 */
export async function buildManifest({ product, version, files, createdAt = new Date() }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`version ${version} is not SemVer`);
  }
  const described = [];
  for (const file of files) {
    described.push(await describeFile(file));
  }
  const names = new Set(described.map((f) => f.name));
  if (names.size !== described.length) {
    throw new Error('two artefacts have the same file name');
  }
  return {
    format: MANIFEST_FORMAT,
    product,
    version,
    createdAt: createdAt.toISOString(),
    files: described.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** @param {Manifest} manifest */
export function serializeManifest(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * The trusted comment of a manifest signature: minisign's default fields.
 * @param {string} fileName
 * @param {Date} [now]
 */
export function trustedCommentFor(fileName, now = new Date()) {
  return `timestamp:${String(Math.floor(now.getTime() / 1000))}\tfile:${fileName}\tprehashed`;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      version: { type: 'string' },
      key: { type: 'string' },
      pub: { type: 'string' },
      out: { type: 'string' },
      product: { type: 'string', default: 'PiArc' },
      'files-dir': { type: 'string' },
      'out-dir': { type: 'string' },
      name: { type: 'string' },
    },
  });
  const [command, ...rest] = positionals;
  switch (command) {
    case 'keygen': {
      if (values['out-dir'] === undefined || values.name === undefined) {
        throw new Error('usage: keygen --out-dir <dir> --name <name>');
      }
      const pair = generateKeyPair(`PiArc ${values.name}`);
      await mkdir(values['out-dir'], { recursive: true });
      await writeFile(path.join(values['out-dir'], `${values.name}.key`), pair.secretKeyText);
      await writeFile(path.join(values['out-dir'], `${values.name}.pub`), pair.publicKeyText);
      console.log(`key ${pair.keyId} written to ${values['out-dir']}`);
      return;
    }
    case 'generate': {
      if (values.version === undefined || values.key === undefined || rest.length === 0) {
        throw new Error('usage: generate --version <v> --key <secret key> <artefact>…');
      }
      const out =
        values.out ?? path.join(path.dirname(rest[0] ?? '.'), 'piarc-release-manifest.json');
      const manifest = await buildManifest({
        product: values.product,
        version: values.version,
        files: rest,
      });
      const bytes = serializeManifest(manifest);
      const key = parseSecretKey(readFileSync(values.key, 'utf8'));
      await writeFile(out, bytes);
      await writeFile(
        `${out}.minisig`,
        signData(bytes, key, trustedCommentFor(path.basename(out))),
      );
      console.log(`${out} (${String(manifest.files.length)} files) and ${out}.minisig written`);
      return;
    }
    case 'verify': {
      const manifestPath = rest[0];
      if (values.pub === undefined || manifestPath === undefined) {
        throw new Error('usage: verify --pub <public key> <manifest.json>');
      }
      const bytes = await readFile(manifestPath);
      const comment = verifyData(
        bytes,
        await readFile(`${manifestPath}.minisig`, 'utf8'),
        parsePublicKey(await readFile(values.pub, 'utf8')),
      );
      console.log(`signature OK (${comment})`);
      /** @type {unknown} */
      const manifest = JSON.parse(bytes.toString('utf8'));
      if (
        values['files-dir'] !== undefined &&
        isRecord(manifest) &&
        Array.isArray(manifest.files)
      ) {
        for (const entry of manifest.files) {
          if (!isRecord(entry) || typeof entry.name !== 'string') {
            throw new Error('malformed manifest entry');
          }
          const actual = await describeFile(path.join(values['files-dir'], entry.name));
          if (actual.size !== entry.size || actual.sha256 !== entry.sha256) {
            throw new Error(`${entry.name} does not match the manifest`);
          }
          console.log(`  ${entry.name}: OK`);
        }
      }
      return;
    }
    default:
      throw new Error('usage: release-manifest.mjs generate|verify|keygen …');
  }
}

if (isMain(import.meta.url)) {
  await main();
}
