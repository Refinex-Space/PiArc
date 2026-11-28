// Voice dictation quality evaluation (voice dictation addendum 3.6 V-6.5, 5.4, appendix B).
//
//   node scripts/speech/eval.mjs [--out <dir>] [--assets <dir>]
//
// Synthesizes the corpus of scripts/speech/corpus.json with the macOS `say` voices it names
// (16 kHz mono WAV under target/speech-eval/), plays every file through the production
// pipeline with `crates/piarc-speech/examples/voice-bench.rs` (once with the built-in
// technical terms as hotwords, once without), and scores the text with appendix B's
// normalization: CER for Chinese, WER for English, MER for mixed and long items, term recall
// (built-in dictionary and other terms apart), negations, numbers, versions and paths kept,
// swallowed last words and repeats, and no text from silence or noise. Writes report.json and
// report.md to tmp/evidence/voice/eval/ (or --out); exits 1 when a quality gate of V-6.5 is
// missed, which marks a release blocker. Recordings of real speakers are not part of it.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { isMain, isRecord, readJsonFile, repoRoot } from '../lib/repo.mjs';

export const CORPUS = path.join(repoRoot, 'scripts', 'speech', 'corpus.json');
export const WORK = path.join(repoRoot, 'target', 'speech-eval');
const VOCABULARY = path.join(repoRoot, 'crates', 'piarc-speech', 'src', 'vocabulary.rs');

/** Quality gates of V-6.5. */
export const GATES = Object.freeze({ cer: 0.12, wer: 0.15, mer: 0.18, termRecall: 0.85 });

/**
 * @typedef {{ id: string, kind: string, voice: string, locale: string, text: string,
 *   terms?: string[], negations?: string[], numbers?: string[], versions?: string[],
 *   paths?: string[] }} Item
 * @typedef {{ id: string, kind: string, seconds?: number, dbfs?: number, of?: string[],
 *   expect: string }} Special
 */

// ---- Appendix B normalization and scoring (pure, tested in eval.test.mjs) ----

/**
 * NFKC, lowercase, punctuation removed, `.` `/` `-` in versions and paths as spaces.
 * @param {string} text
 */
export function normalize(text) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Tokens: one per CJK character, one per run of Latin letters or digits.
 * @param {string} text
 * @returns {string[]}
 */
export function tokens(text) {
  return normalize(text).match(/\p{Script=Han}|[a-z0-9]+/gu) ?? [];
}

/**
 * Levenshtein distance between two token lists.
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 */
export function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Errors and reference length in tokens.
 * @param {string} reference
 * @param {string} hypothesis
 */
export function errors(reference, hypothesis) {
  const ref = tokens(reference);
  return { errors: editDistance(ref, tokens(hypothesis)), length: ref.length };
}

/**
 * A term is recognized when it appears ignoring case and spaces (`-` `.` `/` kept).
 * @param {string} hypothesis
 * @param {string} term
 */
export function hasTerm(hypothesis, term) {
  const squeeze = (/** @type {string} */ s) =>
    s.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
  return squeeze(hypothesis).includes(squeeze(term));
}

/**
 * How many of `needles` appear in `text`, each occurrence counted once.
 * @param {string} text
 * @param {readonly string[]} needles
 */
export function kept(text, needles) {
  let rest = text.normalize('NFKC').toLowerCase();
  let found = 0;
  for (const needle of needles) {
    const at = rest.indexOf(needle.toLowerCase());
    if (at >= 0) {
      found += 1;
      rest = rest.slice(0, at) + rest.slice(at + needle.length);
    }
  }
  return found;
}

/**
 * Whether the reference's last token is missing from the end of the hypothesis.
 * @param {string} reference
 * @param {string} hypothesis
 */
export function swallowedLast(reference, hypothesis) {
  const ref = tokens(reference);
  const hyp = tokens(hypothesis);
  const last = ref.at(-1);
  return last !== undefined && !hyp.slice(-3).includes(last);
}

/**
 * Adjacent repeated tokens in the hypothesis that the reference does not repeat.
 * @param {string} reference
 * @param {string} hypothesis
 */
export function repeats(reference, hypothesis) {
  const count = (/** @type {string[]} */ list) =>
    list.filter((t, i) => i > 0 && t === list[i - 1] && !/\p{Script=Han}/u.test(t)).length;
  return Math.max(0, count(tokens(hypothesis)) - count(tokens(reference)));
}

/** The built-in dictionary's terms (piarc_speech::vocabulary::BUILTIN). */
export async function builtinTerms() {
  const source = await readFile(VOCABULARY, 'utf8');
  return [...source.matchAll(/\b(?:term|common)\("([^"]+)"\)/gu)].map((m) => m[1] ?? '');
}

/**
 * Scores one pass.
 * @param {Item[]} items
 * @param {Map<string, string>} texts id → recognized text
 * @param {readonly string[]} builtin
 */
export function score(items, texts, builtin) {
  /** @type {Record<string, { errors: number, length: number }>} */
  const byKind = {};
  const terms = { builtin: { hit: 0, total: 0 }, other: { hit: 0, total: 0 } };
  /** @type {Record<'negations' | 'numbers' | 'versions' | 'paths', { kept: number, total: number }>} */
  const special = {
    negations: { kept: 0, total: 0 },
    numbers: { kept: 0, total: 0 },
    versions: { kept: 0, total: 0 },
    paths: { kept: 0, total: 0 },
  };
  let swallowed = 0;
  let repeated = 0;
  const rows = [];
  const inBuiltin = (/** @type {string} */ term) =>
    builtin.some((b) => b.toLowerCase() === term.toLowerCase());
  for (const item of items) {
    const hypothesis = texts.get(item.id) ?? '';
    const result = errors(item.text, hypothesis);
    const kind = (byKind[item.kind] ??= { errors: 0, length: 0 });
    kind.errors += result.errors;
    kind.length += result.length;
    for (const term of item.terms ?? []) {
      const bucket = inBuiltin(term) ? terms.builtin : terms.other;
      bucket.total += 1;
      if (hasTerm(hypothesis, term)) bucket.hit += 1;
    }
    for (const key of /** @type {const} */ (['negations', 'numbers', 'versions', 'paths'])) {
      const expected = item[key] ?? [];
      special[key].kept += kept(hypothesis, expected);
      special[key].total += expected.length;
    }
    const lost = swallowedLast(item.text, hypothesis);
    if (lost) swallowed += 1;
    repeated += repeats(item.text, hypothesis);
    rows.push({
      id: item.id,
      kind: item.kind,
      reference: item.text,
      hypothesis,
      errorRate: result.length === 0 ? 0 : result.errors / result.length,
      swallowedLast: lost,
    });
  }
  const rate = (/** @type {string} */ kind) => {
    const k = byKind[kind];
    return k === undefined || k.length === 0 ? undefined : k.errors / k.length;
  };
  const recall = (/** @type {{ hit: number, total: number }} */ b) =>
    b.total === 0 ? undefined : b.hit / b.total;
  return {
    cer: rate('zh'),
    wer: rate('en'),
    mer: rate('mix'),
    long: rate('long'),
    termRecall: recall(terms.builtin),
    termRecallOther: recall(terms.other),
    terms,
    special,
    swallowedLast: swallowed,
    repeats: repeated,
    rows,
  };
}

// ---- Corpus synthesis ----

/**
 * The installed `say` voice named `name` for `locale` (names are localized).
 * @param {string} name
 * @param {string} locale
 * @returns {string}
 */
function voiceFor(name, locale) {
  const list = spawnSync('say', ['-v', '?'], { encoding: 'utf8' });
  if (list.status !== 0) throw new Error('`say` is not available: the corpus needs macOS');
  for (const line of list.stdout.split('\n')) {
    const match = /^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})\s/u.exec(line);
    const voice = match?.[1];
    if (match?.[2] === locale && voice?.split(' (')[0] === name) return voice;
  }
  throw new Error(`macOS voice ${name} (${locale}) is not installed`);
}

/**
 * 16 kHz mono 16-bit PCM WAV of `samples` (−1…1).
 * @param {readonly number[]} samples
 */
export function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2);
  });
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * The samples of a 16 kHz mono 16-bit WAV written by `say` (its data chunk).
 * @param {Buffer} bytes
 * @returns {number[]}
 */
function samplesOf(bytes) {
  const at = bytes.indexOf('data', 12);
  const size = bytes.readUInt32LE(at + 4);
  /** @type {number[]} */
  const out = [];
  for (let i = at + 8; i + 1 < at + 8 + size && i + 1 < bytes.length; i += 2) {
    out.push(bytes.readInt16LE(i) / 32768);
  }
  return out;
}

/**
 * Synthesizes the corpus; returns the items, the special cases and `id → path`.
 * @returns {Promise<{ items: Item[], special: Special[], files: Map<string, string> }>}
 */
export async function prepareCorpus() {
  const corpus = readJsonFile(CORPUS);
  if (!isRecord(corpus) || !Array.isArray(corpus.items) || !Array.isArray(corpus.special)) {
    throw new Error(`${CORPUS} has the wrong shape`);
  }
  const items = /** @type {Item[]} */ (corpus.items);
  const special = /** @type {Special[]} */ (corpus.special);
  const dir = path.join(WORK, 'corpus');
  await mkdir(dir, { recursive: true });
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const item of items) {
    const file = path.join(dir, `${item.id}.wav`);
    const said = spawnSync(
      'say',
      [
        '-v',
        voiceFor(item.voice, item.locale),
        '--file-format=WAVE',
        '--data-format=LEI16@16000',
        '-o',
        file,
        item.text,
      ],
      { encoding: 'utf8' },
    );
    if (said.status !== 0) throw new Error(`say failed for ${item.id}: ${said.stderr}`);
    files.set(item.id, file);
  }
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (const sp of special) {
    const file = path.join(dir, `${sp.id}.wav`);
    /** @type {number[]} */
    let samples = [];
    if (sp.kind === 'silence') samples = Array.from({ length: 16000 * (sp.seconds ?? 3) }, () => 0);
    if (sp.kind === 'noise') {
      const amplitude = 10 ** ((sp.dbfs ?? -35) / 20) * Math.sqrt(3);
      samples = Array.from(
        { length: 16000 * (sp.seconds ?? 3) },
        () => (random() * 2 - 1) * amplitude,
      );
    }
    if (sp.kind === 'concat') {
      for (const id of sp.of ?? []) {
        const part = samplesOf(await readFile(files.get(id) ?? ''));
        // concat, not push(...): a minute of audio is too many arguments for one call.
        samples = samples.concat(
          part,
          Array.from({ length: 9600 }, () => 0),
        );
      }
    }
    await writeFile(file, wav(samples));
    files.set(sp.id, file);
  }
  return { items, special, files };
}

/**
 * Runs voice-bench over `files`; returns its JSON report.
 * @param {string} assets
 * @param {Map<string, string>} files
 * @param {{ hotwords: boolean, cold?: number }} options
 */
export async function bench(assets, files, { hotwords, cold = 0 }) {
  const list = path.join(WORK, `list-${hotwords ? 'on' : 'off'}.tsv`);
  await writeFile(list, [...files].map(([id, file]) => `${id}\t${file}`).join('\n') + '\n');
  const run = spawnSync(
    'cargo',
    [
      'run',
      '--release',
      '-q',
      '-p',
      'piarc-speech',
      '--features',
      'testing',
      '--example',
      'voice-bench',
      '--',
      '--assets',
      assets,
      '--list',
      list,
      '--hotwords',
      hotwords ? 'on' : 'off',
      '--cold',
      String(cold),
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  if (run.status !== 0) throw new Error(`voice-bench failed (${String(run.status)})`);
  const line = run.stdout.trim().split('\n').at(-1) ?? '';
  /** @type {unknown} */
  const report = JSON.parse(line);
  if (!isRecord(report) || !Array.isArray(report.items))
    throw new Error('voice-bench printed no report');
  return report;
}

/**
 * `id → text` of a bench report.
 * @param {Record<string, unknown>} report
 */
export function textsOf(report) {
  /** @type {Map<string, string>} */
  const texts = new Map();
  for (const item of /** @type {unknown[]} */ (report.items)) {
    if (isRecord(item) && typeof item.id === 'string') {
      texts.set(item.id, typeof item.text === 'string' ? item.text : '');
    }
  }
  return texts;
}

const percent = (/** @type {number | undefined} */ v) =>
  v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`;

async function main() {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, assets: { type: 'string' } },
  });
  const out = values.out ?? path.join(repoRoot, 'tmp', 'evidence', 'voice', 'eval');
  const assets =
    values.assets ??
    path.join(repoRoot, 'target', 'speech-assets', `${process.platform}-${process.arch}`);
  const { items, special, files } = await prepareCorpus();
  const builtin = await builtinTerms();
  /** @type {Record<string, unknown>} */
  const passes = {};
  for (const hotwords of [true, false]) {
    console.log(`Running ${String(files.size)} files with hotwords ${hotwords ? 'on' : 'off'}…`);
    const report = await bench(assets, files, { hotwords });
    const texts = textsOf(report);
    passes[hotwords ? 'hotwords' : 'plain'] = {
      scores: score(items, texts, builtin),
      special: special.map((sp) => ({
        id: sp.id,
        expect: sp.expect,
        text: texts.get(sp.id) ?? '',
      })),
      bench: report,
    };
  }
  const main =
    /** @type {{ scores: ReturnType<typeof score>, special: { id: string, text: string }[] }} */ (
      passes.hotwords
    );
  const plain = /** @type {{ scores: ReturnType<typeof score> }} */ (passes.plain);
  const gates = [
    ['Chinese CER', main.scores.cer, GATES.cer, true],
    ['English WER', main.scores.wer, GATES.wer, true],
    ['Mixed MER', main.scores.mer, GATES.mer, true],
    ['Term recall (dictionary)', main.scores.termRecall, GATES.termRecall, false],
  ].map(([name, value, gate, lower]) => ({
    name,
    value,
    gate,
    pass: typeof value === 'number' && (lower ? value <= Number(gate) : value >= Number(gate)),
  }));
  const silent = main.special.filter((s) => s.id !== 'sp-long').every((s) => s.text.trim() === '');
  await mkdir(out, { recursive: true });
  await writeFile(
    path.join(out, 'report.json'),
    `${JSON.stringify({ corpus: path.relative(repoRoot, CORPUS), gates, silent, passes }, null, 2)}\n`,
  );
  const md = [
    '# Voice dictation quality (synthetic corpus)',
    '',
    `Corpus: ${String(items.length)} items synthesized with macOS \`say\` (${path.relative(repoRoot, CORPUS)}); real speakers: NOT RUN.`,
    '',
    '| Metric | Hotwords on | Hotwords off | Gate |',
    '|---|---|---|---|',
    `| Chinese CER | ${percent(main.scores.cer)} | ${percent(plain.scores.cer)} | ≤ ${percent(GATES.cer)} |`,
    `| English WER | ${percent(main.scores.wer)} | ${percent(plain.scores.wer)} | ≤ ${percent(GATES.wer)} |`,
    `| Mixed MER | ${percent(main.scores.mer)} | ${percent(plain.scores.mer)} | ≤ ${percent(GATES.mer)} |`,
    `| Long MER | ${percent(main.scores.long)} | ${percent(plain.scores.long)} | — |`,
    `| Term recall, dictionary | ${percent(main.scores.termRecall)} | ${percent(plain.scores.termRecall)} | ≥ ${percent(GATES.termRecall)} |`,
    `| Term recall, other | ${percent(main.scores.termRecallOther)} | ${percent(plain.scores.termRecallOther)} | — |`,
    ...Object.entries(main.scores.special).map(
      ([k, v]) => `| ${k} kept | ${String(v.kept)}/${String(v.total)} | — | — |`,
    ),
    `| Swallowed last words | ${String(main.scores.swallowedLast)} | ${String(plain.scores.swallowedLast)} | — |`,
    `| Repeats | ${String(main.scores.repeats)} | ${String(plain.scores.repeats)} | — |`,
    `| Silence and noise give no text | ${silent ? 'yes' : 'no'} | — | yes |`,
    '',
    '| Item | Reference | Hypothesis (hotwords on) | Error rate |',
    '|---|---|---|---|',
    ...main.scores.rows.map(
      (r) =>
        `| ${r.id} | ${r.reference} | ${r.hypothesis.replace(/\|/gu, '\\|')} | ${percent(r.errorRate)} |`,
    ),
    '',
  ].join('\n');
  await writeFile(path.join(out, 'report.md'), md);
  console.log(md);
  const failed = gates.filter((g) => !g.pass);
  if (failed.length > 0 || !silent) {
    console.log(
      `RELEASE BLOCKER: ${[...failed.map((g) => g.name), ...(silent ? [] : ['text from silence or noise'])].join(', ')}`,
    );
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) await main();
