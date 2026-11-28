// L3 prompt-stripping check (T30, ADR-0006): every recording must hold only the whitelisted
// structure, so no prompt, tool description or parameter description of either side reaches
// the disk. Two checks per file:
//
// 1. the whitelist schema below (closed objects everywhere except a tool's input schema and a
//    scripted tool input, whose strings the scan covers);
// 2. a scan of every string, keys included: natural-language text (`isProse`: mostly plain
//    words, or anything longer than MAX_CHARS) is an error. Scripted tool inputs are commands
//    and paths, which are not mostly words; scenarios keep them under MAX_CHARS.
//
// Usage: node scripts/l3/check-recordings.mjs <file or directory>...   (exit 1 on a problem)
// `npm run l3` runs it after every recording.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';

import { isMain } from '../lib/repo.mjs';
import { FORMAT } from './recording.mjs';

export const PROSE_MIN_CHARS = 40;
export const PROSE_MIN_WORDS = 6;
export const PROSE_WORD_SHARE = 0.8;
export const MAX_CHARS = 160;

const fingerprint = {
  type: 'object',
  additionalProperties: false,
  required: ['len', 'hash'],
  properties: {
    len: { type: 'integer', minimum: 0 },
    hash: { type: 'string', pattern: '^sha256:[0-9a-f]{16}$' },
    cache: { type: 'boolean' },
    type: { const: 'text' },
  },
};

const block = {
  oneOf: [
    { $ref: '#/$defs/fingerprint', required: ['type', 'len', 'hash', 'cache'] },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'len', 'cache'],
      properties: {
        type: { enum: ['thinking', 'redacted_thinking'] },
        len: { type: 'integer' },
        cache: { type: 'boolean' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id', 'name', 'input', 'cache'],
      properties: {
        type: { const: 'tool_use' },
        id: { type: 'string' },
        name: { type: 'string' },
        input: { type: 'object' },
        cache: { type: 'boolean' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'tool_use_id', 'is_error', 'len', 'cache'],
      properties: {
        type: { const: 'tool_result' },
        tool_use_id: { type: 'string' },
        is_error: { type: 'boolean' },
        len: { type: 'integer' },
        cache: { type: 'boolean' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'cache'],
      properties: {
        type: {
          not: { enum: ['text', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result'] },
        },
        cache: { type: 'boolean' },
      },
    },
  ],
};

const structure = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'endpoint', 'keys', 'stream', 'tools', 'system', 'messages'],
      properties: {
        kind: { enum: ['main', 'auxiliary'] },
        endpoint: { type: 'string' },
        keys: { type: 'array', items: { type: 'string' } },
        stream: { type: 'boolean' },
        tools: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['keys', 'cache'],
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              description: { $ref: '#/$defs/fingerprint' },
              input_schema: { type: 'object' },
              keys: { type: 'array', items: { type: 'string' } },
              cache: { type: 'boolean' },
            },
          },
        },
        system: { type: 'array', items: block },
        messages: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['role', 'content'],
            properties: { role: { type: 'string' }, content: { type: 'array', items: block } },
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'endpoint', 'malformed'],
      properties: {
        kind: { const: 'auxiliary' },
        endpoint: { type: 'string' },
        malformed: { const: true },
      },
    },
    { type: 'null' },
  ],
};

const closed = (/** @type {Record<string, unknown>} */ properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const nullableString = { type: ['string', 'null'] };

/** The whitelist: the only shape a recording may have. */
export const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $defs: { fingerprint },
  ...closed({
    format: { const: FORMAT },
    side: { enum: ['piarc', 'claude-code'] },
    version: { type: 'string' },
    scenario: { type: 'string' },
    run: closed({
      exit: { type: ['integer', 'null'] },
      failures: { type: 'array', items: { type: 'string' } },
    }),
    requests: {
      type: 'array',
      items: closed({
        structure,
        outcome: { type: 'string' },
        violations: { type: 'array', items: { type: 'string' } },
      }),
    },
    trace: closed({
      tool_calls: {
        type: 'array',
        items: closed({
          id: { type: 'string' },
          tool: { type: 'string' },
          status: { type: 'string' },
        }),
      },
      asks: {
        type: 'array',
        items: closed({
          tool: nullableString,
          call: nullableString,
          decision: { enum: ['allow', 'deny', 'session', 'always', 'wait'] },
          scripted: { type: 'boolean' },
        }),
      },
      hooks: {
        type: 'array',
        items: closed({
          hook: { type: 'string' },
          event: nullableString,
          fields: { type: 'array', items: { type: 'string' } },
          tool: nullableString,
          tool_use_id: nullableString,
          run: { type: 'integer' },
          returned: closed({ exit: { type: 'integer' }, decision: nullableString }),
        }),
      },
      final: closed({ status: { type: 'string' } }),
      files: {
        type: 'object',
        additionalProperties: { type: 'string', pattern: '^sha256:[0-9a-f]{16}$' },
      },
    }),
  }),
};

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(SCHEMA);

/**
 * Whether `text` reads as natural language rather than an identifier, path or command:
 * longer than PROSE_MIN_CHARS with at least PROSE_MIN_WORDS whitespace-separated pieces, of
 * which at least PROSE_WORD_SHARE are plain words (letters, an optional apostrophe part and
 * trailing punctuation); or anything longer than MAX_CHARS.
 * @param {string} text
 */
export function isProse(text) {
  if (text.length > MAX_CHARS) return true;
  if (text.length <= PROSE_MIN_CHARS) return false;
  const pieces = text.trim().split(/\s+/);
  if (pieces.length < PROSE_MIN_WORDS) return false;
  const words = pieces.filter((p) => /^[("'`]?\p{L}+(['’]\p{L}+)?[)"'`]?[.,;:!?]?$/u.test(p));
  return words.length / pieces.length >= PROSE_WORD_SHARE;
}

/**
 * Every prose string in `value` (keys included), as `<JSON pointer>: <length> characters`.
 * @param {unknown} value
 * @param {string} [pointer]
 * @returns {string[]}
 */
export function proseStrings(value, pointer = '') {
  if (typeof value === 'string') {
    return isProse(value) ? [`${pointer || '/'}: ${String(value.length)} characters of text`] : [];
  }
  if (Array.isArray(value))
    return value.flatMap((v, i) => proseStrings(v, `${pointer}/${String(i)}`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, v]) => [
      ...(isProse(key) ? [`${pointer}/<key>: ${String(key.length)} characters of text`] : []),
      ...proseStrings(v, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`),
    ]);
  }
  return [];
}

/**
 * Problems of one recording's parsed content.
 * @param {unknown} recording
 * @returns {string[]}
 */
export function checkRecording(recording) {
  /** @type {string[]} */
  const problems = [];
  if (!validate(recording)) {
    for (const e of validate.errors ?? []) {
      problems.push(`not in the whitelist: ${e.instancePath || '/'} ${e.message ?? ''}`.trim());
    }
  }
  for (const found of proseStrings(recording)) problems.push(`prompt-like text at ${found}`);
  return problems;
}

/**
 * The `.json` files under `target` (a file or a directory, recursively).
 * @param {string} target
 * @returns {string[]}
 */
function jsonFiles(target) {
  if (statSync(target).isFile()) return [target];
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) return jsonFiles(full);
    return entry.name.endsWith('.json') ? [full] : [];
  });
}

/**
 * Checks every recording under `targets`.
 * @param {string[]} targets
 * @returns {{ files: number, problems: string[] }}
 */
export function checkRecordings(targets) {
  const files = targets.flatMap(jsonFiles).sort();
  /** @type {string[]} */
  const problems = [];
  for (const file of files) {
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const problem of checkRecording(parsed)) problems.push(`${file}: ${problem}`);
  }
  return { files: files.length, problems };
}

if (isMain(import.meta.url)) {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error('usage: node scripts/l3/check-recordings.mjs <file or directory>...');
    process.exit(2);
  }
  const { files, problems } = checkRecordings(targets);
  for (const problem of problems) console.error(`✖ ${problem}`);
  if (files === 0) {
    console.error('✖ no recordings found');
    process.exitCode = 1;
  } else if (problems.length > 0) {
    console.error(
      `recording check failed: ${String(problems.length)} problem(s) in ${String(files)} file(s)`,
    );
    process.exitCode = 1;
  } else {
    console.log(`recording check passed: ${String(files)} file(s), whitelist structure only`);
  }
}
