#!/usr/bin/env node
// Generates the model providers' marks for the renderer (ADR-0107) from the SVG files in
// design/brand/providers/ (LobeHub icons, copied unmodified, each checked against its SHA-256
// in sources.json there) and the Pi mark in design/brand/mark.svg (Radius, Pi's own service).
//
// The renderer may not build DOM from markup strings, so the output is data: each mark's view
// box and paths, drawn by `ProviderMark` in shell/icons.tsx with `currentColor`. Only what these
// files use is accepted (paths with `d`, fill and clip rules, fill opacity); anything else fails
// instead of being dropped. The output is Prettier-formatted, so `--check` compares bytes.
//
// Usage: node scripts/dev/gen-provider-marks.mjs [--check]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as prettier from 'prettier';

import { isMain, isRecord, readJsonFile, repoRoot } from '../lib/repo.mjs';

const MARKS_DIR = path.join(repoRoot, 'design', 'brand', 'providers');
const PI_MARK = path.join(repoRoot, 'design', 'brand', 'mark.svg');
export const OUTPUT = path.join(
  'apps',
  'desktop',
  'src',
  'renderer',
  'shell',
  'provider-marks.generated.ts',
);

const PATH_ATTRIBUTES = new Set(['d', 'fill-rule', 'clip-rule', 'fill-opacity', 'class']);
const RULES = new Set(['evenodd', 'nonzero']);

/**
 * @typedef {{ d: string, fillRule?: string, clipRule?: string, fillOpacity?: number }} MarkPath
 * @typedef {{ viewBox: string, fillRule?: string, paths: MarkPath[] }} Mark
 */

/**
 * The attributes of one tag.
 * @param {string} tag
 * @returns {Map<string, string>}
 */
function attributes(tag) {
  return new Map(
    [...tag.matchAll(/\s([a-zA-Z:-]+)="([^"]*)"/g)].map((m) => [m[1] ?? '', m[2] ?? '']),
  );
}

/**
 * A mark's shape from its SVG text.
 * @param {string} name for errors
 * @param {string} svg
 * @returns {Mark}
 */
export function parseMark(name, svg) {
  const body = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<title>[^<]*<\/title>/g, '')
    .replace(/<style>[\s\S]*?<\/style>/g, '');
  const root = /<svg\b[^>]*>/.exec(body);
  if (!root) throw new Error(`${name}: no <svg> element`);
  const rootAttributes = attributes(root[0]);
  const viewBox = rootAttributes.get('viewBox');
  if (viewBox === undefined || !/^0 0 \d+(\.\d+)? \d+(\.\d+)?$/.test(viewBox))
    throw new Error(`${name}: unsupported viewBox ${String(viewBox)}`);
  const fill = rootAttributes.get('fill');
  if (fill !== undefined && fill !== 'currentColor')
    throw new Error(`${name}: the root fill is ${fill}, not currentColor`);
  const rootRule = rootAttributes.get('fill-rule');
  if (rootRule !== undefined && !RULES.has(rootRule))
    throw new Error(`${name}: unsupported fill-rule ${rootRule}`);
  const inner = body.slice(root.index + root[0].length).replace(/<\/svg>\s*$/, '');
  /** @type {MarkPath[]} */
  const paths = [];
  const rest = inner.replace(/<path\b[^>]*?(?:\/>|>\s*<\/path>)/g, (tag) => {
    const found = attributes(tag);
    for (const key of found.keys()) {
      if (!PATH_ATTRIBUTES.has(key)) throw new Error(`${name}: unsupported path attribute ${key}`);
    }
    const d = (found.get('d') ?? '').replace(/\s+/g, ' ').trim();
    if (d === '') throw new Error(`${name}: a path without d`);
    /** @type {MarkPath} */
    const shape = { d };
    const fillRule = found.get('fill-rule');
    const clipRule = found.get('clip-rule');
    const opacity = found.get('fill-opacity');
    if (fillRule !== undefined) {
      if (!RULES.has(fillRule)) throw new Error(`${name}: unsupported fill-rule ${fillRule}`);
      shape.fillRule = fillRule;
    }
    if (clipRule !== undefined) {
      if (!RULES.has(clipRule)) throw new Error(`${name}: unsupported clip-rule ${clipRule}`);
      shape.clipRule = clipRule;
    }
    if (opacity !== undefined) {
      const value = Number(opacity);
      if (!(value >= 0 && value <= 1)) throw new Error(`${name}: bad fill-opacity ${opacity}`);
      shape.fillOpacity = value;
    }
    paths.push(shape);
    return '';
  });
  if (rest.trim() !== '')
    throw new Error(`${name}: unsupported content ${rest.trim().slice(0, 60)}`);
  if (paths.length === 0) throw new Error(`${name}: no paths`);
  return { viewBox, ...(rootRule === undefined ? {} : { fillRule: rootRule }), paths };
}

/**
 * The vendored files, each checked against the lock.
 * @returns {{ name: string, svg: string }[]}
 */
export function vendoredMarks() {
  const lock = readJsonFile(path.join(MARKS_DIR, 'sources.json'));
  if (!isRecord(lock) || !isRecord(lock.files)) throw new Error('sources.json: no files');
  return Object.entries(lock.files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, hash]) => {
      if (!file.endsWith('.svg') || typeof hash !== 'string')
        throw new Error(`sources.json: bad entry ${file}`);
      const bytes = readFileSync(path.join(MARKS_DIR, file));
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== hash) throw new Error(`${file}: SHA-256 ${actual} differs from sources.json`);
      return { name: file.slice(0, -'.svg'.length), svg: bytes.toString('utf8') };
    });
}

/**
 * The generated module's text, Prettier-formatted.
 * @returns {Promise<string>}
 */
export async function generateProviderMarks() {
  const marks = [...vendoredMarks(), { name: 'pi', svg: await readFile(PI_MARK, 'utf8') }].map(
    ({ name, svg }) => /** @type {const} */ ([name, parseMark(name, svg)]),
  );
  const lines = marks.map(([name, mark]) => `  ${JSON.stringify(name)}: ${JSON.stringify(mark)},`);
  const source = [
    '// Generated by scripts/dev/gen-provider-marks.mjs from design/brand/providers/ (LobeHub icons,',
    '// MIT, third-party/licenses/lobe-icons.LICENSE) and design/brand/mark.svg. Do not edit.',
    '',
    'export interface MarkPath {',
    '  readonly d: string;',
    '  readonly fillRule?: string;',
    '  readonly clipRule?: string;',
    '  readonly fillOpacity?: number;',
    '}',
    '',
    'export interface Mark {',
    '  readonly viewBox: string;',
    '  readonly fillRule?: string;',
    '  readonly paths: readonly MarkPath[];',
    '}',
    '',
    'export const PROVIDER_MARKS = {',
    ...lines,
    '} as const satisfies Record<string, Mark>;',
    '',
    'export type ProviderMarkName = keyof typeof PROVIDER_MARKS;',
    '',
  ].join('\n');
  const filepath = path.join(repoRoot, OUTPUT);
  const config = (await prettier.resolveConfig(filepath)) ?? {};
  return prettier.format(source, { ...config, filepath });
}

async function main() {
  const content = await generateProviderMarks();
  const target = path.join(repoRoot, OUTPUT);
  if (process.argv.includes('--check')) {
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current !== content) {
      console.error(`${OUTPUT} is out of date: run node scripts/dev/gen-provider-marks.mjs`);
      process.exitCode = 1;
      return;
    }
    console.log(`${OUTPUT} is up to date`);
    return;
  }
  await writeFile(target, content, 'utf8');
  console.log(`wrote ${OUTPUT}`);
}

if (isMain(import.meta.url)) {
  await main();
}
