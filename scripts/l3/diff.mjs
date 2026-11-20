// L3 structural diff (T30): compares two comparison documents (scripts/l3/normalize.mjs) and
// lists every difference by field path. Objects are compared key by key, arrays of objects
// element by element; scalars and arrays of scalars are leaves.
//
// Field paths join keys with `.`; a key that is not an identifier is written `["key"]` and an
// array index `[n]`, e.g. `requests.items[0].tools.Agent`, `files[".claude/x.json"]`.
// Allowlist patterns (scripts/l3/allowlist.mjs) use the same syntax with wildcards: `*`
// matches within one key, `[*]` any index, `**` any run of path.
import { isRecord } from '../lib/repo.mjs';

/** @typedef {{ path: string, piarc: unknown, claude: unknown }} Difference */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * @param {string} base
 * @param {string} key
 */
export function childPath(base, key) {
  if (IDENTIFIER.test(key)) return base === '' ? key : `${base}.${key}`;
  return `${base}[${JSON.stringify(key)}]`;
}

/** @param {unknown} value */
const isLeaf = (value) =>
  !isRecord(value) && !(Array.isArray(value) && value.some((v) => isRecord(v) || Array.isArray(v)));

/**
 * Every difference between the PiArc side `piarc` and the Claude Code side `claude`.
 * @param {unknown} piarc
 * @param {unknown} claude
 * @param {string} [base]
 * @returns {Difference[]}
 */
export function diff(piarc, claude, base = '') {
  if (piarc === undefined || claude === undefined || isLeaf(piarc) || isLeaf(claude)) {
    return JSON.stringify(piarc) === JSON.stringify(claude) ? [] : [{ path: base, piarc, claude }];
  }
  if (Array.isArray(piarc) && Array.isArray(claude)) {
    const length = Math.max(piarc.length, claude.length);
    return Array.from({ length }, (_, i) =>
      diff(piarc[i], claude[i], `${base}[${String(i)}]`),
    ).flat();
  }
  if (isRecord(piarc) && isRecord(claude)) {
    const keys = [...new Set([...Object.keys(piarc), ...Object.keys(claude)])].sort();
    return keys.flatMap((key) => diff(piarc[key], claude[key], childPath(base, key)));
  }
  return [{ path: base, piarc, claude }];
}

/**
 * Compiles a field-path pattern to a regular expression matching whole paths.
 * @param {string} pattern
 */
export function compilePattern(pattern) {
  let source = '';
  let quoted = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern.charAt(i);
    if (char === '"') {
      quoted = !quoted;
      source += '"';
    } else if (!quoted && pattern.startsWith('[*]', i)) {
      source += '\\[\\d+\\]';
      i += 2;
    } else if (!quoted && pattern.startsWith('**', i)) {
      source += '.*';
      i += 1;
    } else if (char === '*') {
      source += quoted ? '[^"]*' : '[^.\\[\\]]*';
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}
