// File helpers shared by the L3 sides: the workspace fingerprint (the same hash the PiArc side
// computes in `piarc_testkit::l3::file_hash`) and JSON-lines logs.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * `sha256:<first 16 hex digits>` of `bytes`.
 * @param {Uint8Array | string} bytes
 */
export function fileHash(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`;
}

/**
 * Every file under `root` by `/`-separated relative path, with its hash; top-level
 * directories named in `skip` are left out.
 * @param {string} root
 * @param {string[]} skip
 * @returns {Record<string, string>}
 */
export function fileHashes(root, skip) {
  /** @type {Record<string, string>} */
  const out = {};
  /** @param {string} dir @param {string[]} parts */
  const walk = (dir, parts) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = [...parts, entry.name];
      if (rel.length === 1 && skip.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out[rel.join('/')] = fileHash(readFileSync(full));
    }
  };
  walk(root, []);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Parses JSON lines; a line that is not JSON becomes `{unparsed: <length>}`.
 * @param {string} text
 * @returns {unknown[]}
 */
export function jsonLines(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return /** @type {unknown} */ (JSON.parse(line));
      } catch {
        return { unparsed: line.length };
      }
    });
}
