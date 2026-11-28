// Downloads the speech assets locked in third-party/speech-assets.lock.json (ADR-0094) and lays
// them out in target/speech-assets/<platform>-<arch>/, the directory packaging copies into
// Resources/speech/ and that a source-tree Core reads.
//
//   node scripts/dev/fetch-speech-assets.mjs [--platform darwin|win32] [--arch arm64|x64]
//       Lays out one target (default: this machine) and prints the directory.
//   node scripts/dev/fetch-speech-assets.mjs --all
//       Downloads and checks the archives of every target (after bumping a version; CI cache).
//
// Downloads land in .tools/cache/speech/ and are checked against the lock (size and SHA-256);
// only the members the lock lists are taken out of an archive, each checked again after
// extraction. bpe.vocab is exported from bpe.model here and must hash to the locked value.
// Real-speech test WAVs go to target/speech-assets/test-wavs/ and are never packaged.
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { isMain, isRecord, readJsonFile, repoRoot } from '../lib/repo.mjs';
import { downloadVerified, extract, mismatch } from './fetch-binaries.mjs';

export const SPEECH_LOCK = path.join(repoRoot, 'third-party', 'speech-assets.lock.json');
export const SPEECH_CACHE = path.join(repoRoot, '.tools', 'cache', 'speech');
export const SPEECH_ASSETS = path.join(repoRoot, 'target', 'speech-assets');

/**
 * @typedef {{ url: string, size: number, sha256: string }} Download
 * @typedef {{ to: string, size: number, sha256: string }} LockedFile
 * @typedef {Download & { root: string, files: Record<string, LockedFile> }} RuntimeArtefact
 * @typedef {{
 *   archive?: Download & { root: string },
 *   file?: Download & { to: string },
 *   files: Record<string, LockedFile>,
 *   derived: Record<string, LockedFile & { from: string }>,
 *   testFiles: Record<string, LockedFile>,
 * }} LockedModel
 * @typedef {{ runtime: Record<string, RuntimeArtefact>, models: Record<string, LockedModel> }} SpeechLock
 */

/** @param {unknown} value */
function isSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {Download}
 */
function download(value, where) {
  if (
    !isRecord(value) ||
    typeof value.url !== 'string' ||
    !value.url.startsWith('https://') ||
    typeof value.size !== 'number' ||
    !isSha(value.sha256)
  ) {
    throw new Error(`${SPEECH_LOCK}: ${where} needs an https url, a size and a sha256 hex`);
  }
  return { url: value.url, size: value.size, sha256: String(value.sha256) };
}

/**
 * Validates a relative destination: no absolute path, no `..`, forward slashes only.
 * @param {unknown} value
 * @param {string} where
 * @returns {string}
 */
function relative(value, where) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`${SPEECH_LOCK}: ${where} is not a plain relative path`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {Record<string, LockedFile>}
 */
function lockedFiles(value, where) {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${SPEECH_LOCK}: ${where} must be an object`);
  /** @type {Record<string, LockedFile>} */
  const files = {};
  for (const [member, entry] of Object.entries(value)) {
    relative(member, `${where}.${member}`);
    if (!isRecord(entry) || typeof entry.size !== 'number' || !isSha(entry.sha256)) {
      throw new Error(`${SPEECH_LOCK}: ${where}.${member} needs to, size and sha256`);
    }
    files[member] = {
      to: relative(entry.to, `${where}.${member}.to`),
      size: entry.size,
      sha256: String(entry.sha256),
    };
  }
  return files;
}

/** @returns {SpeechLock} */
export function readSpeechLock() {
  const lock = readJsonFile(SPEECH_LOCK);
  if (!isRecord(lock) || !isRecord(lock.runtime) || !isRecord(lock.runtime.artefacts)) {
    throw new Error(`${SPEECH_LOCK} has no runtime.artefacts`);
  }
  if (!isRecord(lock.models)) throw new Error(`${SPEECH_LOCK} has no models`);
  /** @type {Record<string, RuntimeArtefact>} */
  const runtime = {};
  for (const [target, entry] of Object.entries(lock.runtime.artefacts)) {
    const where = `runtime.artefacts.${target}`;
    if (!isRecord(entry) || typeof entry.root !== 'string') {
      throw new Error(`${SPEECH_LOCK}: ${where} needs a root`);
    }
    runtime[target] = {
      ...download(entry, where),
      root: relative(entry.root, `${where}.root`),
      files: lockedFiles(entry.files, `${where}.files`),
    };
  }
  /** @type {Record<string, LockedModel>} */
  const models = {};
  for (const [name, entry] of Object.entries(lock.models)) {
    const where = `models.${name}`;
    if (!isRecord(entry)) throw new Error(`${SPEECH_LOCK}: ${where} must be an object`);
    /** @type {LockedModel} */
    const model = {
      files: lockedFiles(entry.files, `${where}.files`),
      derived: {},
      testFiles: lockedFiles(entry.testFiles, `${where}.testFiles`),
    };
    if (entry.archive !== undefined) {
      if (!isRecord(entry.archive) || typeof entry.archive.root !== 'string') {
        throw new Error(`${SPEECH_LOCK}: ${where}.archive needs a root`);
      }
      model.archive = {
        ...download(entry.archive, `${where}.archive`),
        root: relative(entry.archive.root, `${where}.archive.root`),
      };
    }
    if (entry.file !== undefined) {
      if (!isRecord(entry.file)) throw new Error(`${SPEECH_LOCK}: ${where}.file`);
      model.file = {
        ...download(entry.file, `${where}.file`),
        to: relative(entry.file.to, `${where}.file.to`),
      };
    }
    if (entry.derived !== undefined) {
      if (!isRecord(entry.derived)) throw new Error(`${SPEECH_LOCK}: ${where}.derived`);
      for (const [file, derived] of Object.entries(
        lockedFiles(entry.derived, `${where}.derived`),
      )) {
        /** @type {unknown} */
        const raw = entry.derived[file];
        const from = isRecord(raw) ? raw.from : undefined;
        if (typeof from !== 'string' || model.files[from] === undefined) {
          throw new Error(`${SPEECH_LOCK}: ${where}.derived.${file}.from names no locked file`);
        }
        model.derived[file] = { ...derived, from };
      }
    }
    models[name] = model;
  }
  return { runtime, models };
}

/**
 * Formats a float32 score the way Python's `str(float)` does (sentencepiece's own vocab export
 * goes through Python), so the exported file is byte-identical to upstream's bpe.vocab files.
 * @param {number} value
 */
export function pythonFloat(value) {
  if (Number.isInteger(value)) return `${String(value)}.0`;
  const magnitude = Math.abs(value);
  if (magnitude < 1e-4 || magnitude >= 1e16) {
    // Python: shortest repr in exponent form with at least two exponent digits.
    const [mantissa = '', exponent = '0'] = value.toExponential().split('e');
    const sign = exponent.startsWith('-') ? '-' : '+';
    const digits = exponent.replace(/^[+-]/, '').padStart(2, '0');
    return `${mantissa}e${sign}${digits}`;
  }
  return String(value);
}

/**
 * Reads a protobuf varint at `offset`.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {[number, number]} value and the offset after it
 */
function varint(bytes, offset) {
  let value = 0;
  let shift = 0;
  let at = offset;
  for (;;) {
    const byte = bytes[at];
    if (byte === undefined) throw new Error('truncated varint in bpe.model');
    at += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (byte < 0x80) return [value, at];
  }
}

/**
 * Exports the pieces and scores of a sentencepiece model (`ModelProto`, field 1 = repeated
 * `SentencePiece { 1: piece, 2: score }`) as "piece\tscore" lines.
 * @param {Uint8Array} model
 * @returns {string}
 */
export function sentencepieceVocab(model) {
  const view = new DataView(model.buffer, model.byteOffset, model.byteLength);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  /** @type {string[]} */
  const lines = [];
  /**
   * @param {number} start
   * @param {number} end
   * @param {(field: number, wire: number, at: number, length: number) => void} visit
   */
  const walk = (start, end, visit) => {
    let at = start;
    while (at < end) {
      const [key, next] = varint(model, at);
      at = next;
      const field = Math.floor(key / 8);
      const wire = key % 8;
      if (wire === 0) {
        at = varint(model, at)[1];
      } else if (wire === 1) {
        at += 8;
      } else if (wire === 2) {
        const [length, body] = varint(model, at);
        visit(field, wire, body, length);
        at = body + length;
      } else if (wire === 5) {
        visit(field, wire, at, 4);
        at += 4;
      } else {
        throw new Error(`unsupported protobuf wire type ${String(wire)} in bpe.model`);
      }
    }
    if (at !== end) throw new Error('bpe.model has a truncated field');
  };
  walk(0, model.length, (field, wire, at, length) => {
    if (field !== 1 || wire !== 2) return;
    let piece = '';
    let score = 0;
    walk(at, at + length, (inner, innerWire, innerAt, innerLength) => {
      if (inner === 1 && innerWire === 2) {
        piece = decoder.decode(model.subarray(innerAt, innerAt + innerLength));
      } else if (inner === 2 && innerWire === 5) {
        score = view.getFloat32(innerAt, true);
      }
    });
    lines.push(`${piece}\t${pythonFloat(score)}`);
  });
  return `${lines.join('\n')}\n`;
}

/**
 * The files a packaged app carries for `target` (`<platform>-<arch>`), with their paths under
 * `Resources/speech/` (and under target/speech-assets/<target>/): the runtime libraries, the
 * models' files and the derived files. Test files are never among them.
 * @param {SpeechLock} lock
 * @param {string} target
 * @returns {LockedFile[]}
 */
export function bundledSpeechFiles(lock, target) {
  const runtime = lock.runtime[target];
  if (runtime === undefined) throw new Error(`${SPEECH_LOCK} has no runtime for ${target}`);
  return [
    ...Object.values(runtime.files),
    ...Object.values(lock.models).flatMap((model) => [
      ...(model.file === undefined ? [] : [model.file]),
      ...Object.values(model.files),
      ...Object.values(model.derived),
    ]),
  ].map(({ to, size, sha256 }) => ({ to, size, sha256 }));
}

/**
 * Copies `from` to `to` and checks the copy against its lock entry.
 * @param {string} from
 * @param {string} to
 * @param {LockedFile} entry
 * @param {string} label
 */
async function place(from, to, entry, label) {
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
  const problem = await mismatch(to, entry);
  if (problem !== null) {
    await rm(to, { force: true });
    throw new Error(`${label} does not match ${path.relative(repoRoot, SPEECH_LOCK)}: ${problem}`);
  }
}

/**
 * Lays out the runtime and models for one target in target/speech-assets/<platform>-<arch>/,
 * rebuilt from the verified downloads every time, and the test WAVs in target/speech-assets/.
 * @param {string} platform `darwin` or `win32`
 * @param {string} arch `arm64` or `x64`
 * @returns {Promise<string>} the laid-out directory
 */
export async function stageSpeechAssets(platform, arch) {
  const target = `${platform}-${arch}`;
  const lock = readSpeechLock();
  const runtime = lock.runtime[target];
  if (runtime === undefined) throw new Error(`${SPEECH_LOCK} has no runtime for ${target}`);
  const out = path.join(SPEECH_ASSETS, target);
  await rm(out, { recursive: true, force: true });
  await mkdir(SPEECH_ASSETS, { recursive: true });
  const scratch = await mkdtemp(path.join(SPEECH_ASSETS, `.${target}-`));
  try {
    const archive = await downloadVerified(
      runtime,
      path.join(SPEECH_CACHE, 'runtime'),
      SPEECH_LOCK,
    );
    await extract(archive, path.join(scratch, 'runtime'));
    for (const [member, entry] of Object.entries(runtime.files)) {
      const from = path.join(scratch, 'runtime', runtime.root, ...member.split('/'));
      await place(from, path.join(out, ...entry.to.split('/')), entry, `${target} ${member}`);
    }
    for (const [name, model] of Object.entries(lock.models)) {
      if (model.file !== undefined) {
        const file = await downloadVerified(model.file, path.join(SPEECH_CACHE, name), SPEECH_LOCK);
        await place(file, path.join(out, ...model.file.to.split('/')), model.file, name);
      }
      if (model.archive === undefined) continue;
      const file = await downloadVerified(
        model.archive,
        path.join(SPEECH_CACHE, name),
        SPEECH_LOCK,
      );
      const into = path.join(scratch, name);
      await extract(file, into);
      const root = path.join(into, model.archive.root);
      for (const [member, entry] of Object.entries(model.files)) {
        await place(
          path.join(root, ...member.split('/')),
          path.join(out, ...entry.to.split('/')),
          entry,
          `${name} ${member}`,
        );
      }
      for (const [file, entry] of Object.entries(model.derived)) {
        const source = await readFile(path.join(root, ...entry.from.split('/')));
        const written = path.join(scratch, `${name}-${file}`);
        await writeFile(written, sentencepieceVocab(new Uint8Array(source)));
        await place(written, path.join(out, ...entry.to.split('/')), entry, `${name} ${file}`);
      }
      for (const [member, entry] of Object.entries(model.testFiles)) {
        await place(
          path.join(root, ...member.split('/')),
          path.join(SPEECH_ASSETS, ...entry.to.split('/')),
          entry,
          `${name} ${member}`,
        );
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return out;
}

async function main() {
  const { values } = parseArgs({
    options: {
      platform: { type: 'string', default: process.platform },
      arch: { type: 'string', default: process.arch },
      all: { type: 'boolean', default: false },
    },
  });
  if (values.all) {
    const lock = readSpeechLock();
    for (const [target, artefact] of Object.entries(lock.runtime)) {
      console.log(
        `runtime ${target}: ${await downloadVerified(artefact, path.join(SPEECH_CACHE, 'runtime'), SPEECH_LOCK)}`,
      );
    }
    for (const [name, model] of Object.entries(lock.models)) {
      for (const item of [model.archive, model.file]) {
        if (item !== undefined) {
          console.log(
            `${name}: ${await downloadVerified(item, path.join(SPEECH_CACHE, name), SPEECH_LOCK)}`,
          );
        }
      }
    }
    return;
  }
  console.log(await stageSpeechAssets(values.platform, values.arch));
}

if (isMain(import.meta.url)) {
  await main();
}
