// The rows of architecture chapter 11's budget table (T44): the first cell of every row between
// the table's header (`| 指标 | 预算 |`) and the first line that is not a table line.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { repoRoot } from '../lib/repo.mjs';

export const ARCHITECTURE = path.join(repoRoot, 'docs', 'architecture', 'ARCHITECTURE.md');

/**
 * The metric names (first cells) of chapter 11's table in `markdown`.
 * @param {string} markdown
 * @returns {string[]}
 */
export function chapter11Rows(markdown) {
  const lines = markdown.split('\n');
  const chapter = lines.findIndex((line) => line.startsWith('## 11.'));
  if (chapter < 0) throw new Error('chapter 11 is missing');
  const header = lines.findIndex((line, i) => i > chapter && line.startsWith('| 指标 | 预算 |'));
  if (header < 0) throw new Error("chapter 11's budget table is missing");
  const rows = [];
  for (let i = header + 2; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.startsWith('|')) break;
    const first = line.split('|')[1]?.trim() ?? '';
    if (first !== '') rows.push(first);
  }
  return rows;
}

/** @returns {Promise<string[]>} */
export async function readChapter11Rows() {
  return chapter11Rows(await readFile(ARCHITECTURE, 'utf8'));
}
