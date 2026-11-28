// The local ESM graph shipped beside the bundled Node executable (ADR-0071).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const BUNDLE_MANIFEST = 'bundle-files.json';
export const CHUNK_DIR = 'chunks';
export const CHUNK_NAME = /^(?:entry|chunk)-[A-Z0-9]+\.mjs$/u;

/** @param {string} entry */
export function entrySource(entry) {
  return `import "./${CHUNK_DIR}/${entry}";\n`;
}

/** @param {Uint8Array} bytes */
export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reads one generation and verifies every static and deferred module listed by esbuild.
 * @param {string} directory
 * @returns {{ entry: string, files: Record<string, string> }}
 */
export function verifiedBundle(directory) {
  /** @type {unknown} */
  const raw = JSON.parse(readFileSync(path.join(directory, BUNDLE_MANIFEST), 'utf8'));
  if (
    !isRecord(raw) ||
    typeof raw.entry !== 'string' ||
    !isRecord(raw.files) ||
    !raw.entry.startsWith('entry-') ||
    !Object.hasOwn(raw.files, raw.entry)
  ) {
    throw new Error('Invalid Agent Host bundle manifest');
  }
  /** @type {Record<string, string>} */
  const files = {};
  for (const [name, expected] of Object.entries(raw.files)) {
    if (
      !CHUNK_NAME.test(name) ||
      typeof expected !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(expected)
    ) {
      throw new Error(`Invalid Agent Host module in manifest: ${name}`);
    }
    if (digest(readFileSync(path.join(directory, CHUNK_DIR, name))) !== expected) {
      throw new Error(`Agent Host module differs from the build manifest: ${name}`);
    }
    files[name] = expected;
  }
  return { entry: raw.entry, files };
}
