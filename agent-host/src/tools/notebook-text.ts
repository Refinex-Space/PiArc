// Cell edits of a Jupyter notebook's text (T42, `NotebookEdit`): the same algorithm as Core's
// `piarc_fs::notebook` (Core recomputes the result to show the approval card's diff and to check
// the write), so both run the shared vectors in `tests/notebook/`. Every byte outside the edited
// cell stays: the edit replaces one cell's range, inserts one cell or removes one, in the file's
// own indent, line endings and separators. See the Rust module for the rules.
import { createHash } from 'node:crypto';

export type EditMode = 'replace' | 'insert' | 'delete';
export type CellType = 'code' | 'markdown';

export interface CellEdit {
  readonly mode: EditMode;
  readonly cellId?: string | undefined;
  readonly newSource: string;
  readonly cellType?: CellType | undefined;
  /** Seed of a new cell's id (the tool call id). */
  readonly seed: string;
}

export type NotebookErrorKind = 'invalid' | 'cellNotFound' | 'missingCellId' | 'missingCellType';

/** Why an edit cannot be made; the message is for the model (Core's words). */
export class NotebookError extends Error {
  constructor(
    readonly kind: NotebookErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'NotebookError';
  }
}

function invalid(what: string): NotebookError {
  return new NotebookError('invalid', `The file is not a valid Jupyter notebook: ${what}`);
}

interface Member {
  readonly key: string;
  readonly keyStart: number;
  readonly value: Node;
}

type Node =
  | {
      readonly kind: 'object';
      readonly start: number;
      readonly end: number;
      readonly members: Member[];
    }
  | { readonly kind: 'array'; readonly start: number; readonly end: number; readonly items: Node[] }
  | { readonly kind: 'scalar'; readonly start: number; readonly end: number };

function member(node: Node, key: string): Member | undefined {
  return node.kind === 'object' ? node.members.find((m) => m.key === key) : undefined;
}

const SPACE = new Set([' ', '\t', '\n', '\r']);
const SCALAR_END = new Set([',', '}', ']', ' ', '\t', '\n', '\r']);

class Scanner {
  at = 0;
  constructor(readonly text: string) {}

  error(what: string): NotebookError {
    return invalid(`${what} at offset ${String(this.at)}`);
  }

  skipSpace(): void {
    while (this.at < this.text.length && SPACE.has(this.text.charAt(this.at))) this.at += 1;
  }

  expect(char: string): void {
    this.skipSpace();
    if (this.text.charAt(this.at) !== char) throw this.error(`expected '${char}'`);
    this.at += 1;
  }

  stringEnd(): number {
    this.at += 1;
    while (this.at < this.text.length) {
      const c = this.text.charAt(this.at);
      if (c === '\\') this.at += 2;
      else if (c === '"') {
        this.at += 1;
        return this.at;
      } else this.at += 1;
    }
    throw this.error('unterminated string');
  }

  value(depth: number): Node {
    if (depth > 128) throw this.error('nesting too deep');
    this.skipSpace();
    const start = this.at;
    const c = this.text.charAt(this.at);
    if (c === '{') return this.object(start, depth);
    if (c === '[') return this.array(start, depth);
    if (c === '"') return { kind: 'scalar', start, end: this.stringEnd() };
    if (c === '') throw this.error('unexpected end');
    while (this.at < this.text.length && !SCALAR_END.has(this.text.charAt(this.at))) this.at += 1;
    if (this.at === start) throw this.error('expected a value');
    return { kind: 'scalar', start, end: this.at };
  }

  object(start: number, depth: number): Node {
    this.at += 1;
    const members: Member[] = [];
    this.skipSpace();
    if (this.text.charAt(this.at) === '}') {
      this.at += 1;
      return { kind: 'object', start, end: this.at, members };
    }
    for (;;) {
      this.skipSpace();
      if (this.text.charAt(this.at) !== '"') throw this.error('expected a key');
      const keyStart = this.at;
      const keyEnd = this.stringEnd();
      const key: unknown = JSON.parse(this.text.slice(keyStart, keyEnd));
      if (typeof key !== 'string') throw this.error('expected a key');
      this.expect(':');
      const value = this.value(depth + 1);
      members.push({ key, keyStart, value });
      this.skipSpace();
      const next = this.text.charAt(this.at);
      if (next === ',') this.at += 1;
      else if (next === '}') {
        this.at += 1;
        return { kind: 'object', start, end: this.at, members };
      } else throw this.error("expected ',' or '}'");
    }
  }

  array(start: number, depth: number): Node {
    this.at += 1;
    const items: Node[] = [];
    this.skipSpace();
    if (this.text.charAt(this.at) === ']') {
      this.at += 1;
      return { kind: 'array', start, end: this.at, items };
    }
    for (;;) {
      items.push(this.value(depth + 1));
      this.skipSpace();
      const next = this.text.charAt(this.at);
      if (next === ',') this.at += 1;
      else if (next === ']') {
        this.at += 1;
        return { kind: 'array', start, end: this.at, items };
      } else throw this.error("expected ',' or ']'");
    }
  }
}

interface Style {
  readonly newline: string;
  readonly unit: string | undefined;
  readonly colon: string;
  readonly comma: string;
}

function lineIndent(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const line = text.slice(lineStart, at);
  const trimmed = line.replace(/^[ \t]+/u, '');
  return line.slice(0, line.length - trimmed.length);
}

function styleOf(text: string, root: Node, cells: Node): Style {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const body = text.slice(root.start, root.end);
  const colon = body.includes('": ') ? ': ' : ':';
  const comma = body.includes(', "') ? ', ' : ',';
  let unit: string | undefined;
  const cell = cells.kind === 'array' ? cells.items[0] : undefined;
  const first = cell?.kind === 'object' ? cell.members[0] : undefined;
  if (cell !== undefined && first !== undefined) {
    const outer = lineIndent(text, cell.start);
    const inner = lineIndent(text, first.keyStart);
    if (text.slice(cell.start, first.keyStart).includes('\n') && inner.length > outer.length) {
      unit = inner.slice(outer.length);
    }
  }
  const rootFirst = root.kind === 'object' ? root.members[0] : undefined;
  if (
    unit === undefined &&
    rootFirst !== undefined &&
    text.slice(root.start, rootFirst.keyStart).includes('\n')
  ) {
    const indent = lineIndent(text, rootFirst.keyStart);
    if (indent !== '') unit = indent;
  }
  return { newline, unit, colon, comma };
}

/** Jupyter's list of source lines: every line keeps its `\n` but the last. */
function sourceLines(source: string): string[] {
  if (source === '') return [];
  const lines: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf('\n', from);
    if (at === -1) {
      if (from < source.length) lines.push(source.slice(from));
      return lines;
    }
    lines.push(source.slice(from, at + 1));
    from = at + 1;
  }
}

const json = (text: string): string => JSON.stringify(text);

/** The first 8 hex digits of SHA-256 of `seed`, then `seed-1`, … not in `existing`. */
export function newCellId(seed: string, existing: readonly string[]): string {
  for (let n = 0; ; n += 1) {
    const input = n === 0 ? seed : `${seed}-${String(n)}`;
    const id = createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 8);
    if (!existing.includes(id)) return id;
  }
}

interface Written {
  readonly key: string;
  readonly value: string;
}

function writeCell(style: Style, indent: string, members: readonly Written[]): string {
  if (style.unit === undefined) {
    return `{${members.map((m) => `${json(m.key)}${style.colon}${m.value}`).join(style.comma)}}`;
  }
  const nl = style.newline;
  const inner = `${indent}${style.unit}`;
  const lines = members.map((m) => `${inner}${json(m.key)}${style.colon}${m.value}`);
  return `{${nl}${lines.join(`,${nl}`)}${nl}${indent}}`;
}

function writeSource(style: Style, indent: string, source: string): string {
  const lines = sourceLines(source);
  if (lines.length === 0) return '[]';
  if (style.unit === undefined) return `[${lines.map(json).join(style.comma)}]`;
  const nl = style.newline;
  const unit = style.unit;
  const items = lines.map((l) => `${indent}${unit}${json(l)}`);
  return `[${nl}${items.join(`,${nl}`)}${nl}${indent}]`;
}

const DECIDED = new Set(['cell_type', 'execution_count', 'outputs', 'source']);

function cellMembers(
  text: string,
  style: Style,
  indent: string,
  old: Node | undefined,
  cellType: CellType,
  source: string,
  newId: string | undefined,
): Written[] {
  const keyIndent = `${indent}${style.unit ?? ''}`;
  const written: Written[] = [];
  if (old?.kind === 'object') {
    for (const m of old.members) {
      if (!DECIDED.has(m.key)) {
        written.push({ key: m.key, value: text.slice(m.value.start, m.value.end) });
      }
    }
  }
  if (newId !== undefined) written.push({ key: 'id', value: json(newId) });
  if (!written.some((w) => w.key === 'metadata')) written.push({ key: 'metadata', value: '{}' });
  written.push({ key: 'cell_type', value: json(cellType) });
  if (cellType === 'code') {
    written.push({ key: 'execution_count', value: 'null' });
    written.push({ key: 'outputs', value: '[]' });
  }
  written.push({ key: 'source', value: writeSource(style, keyIndent, source) });
  return written.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function stringValue(text: string, m: Member | undefined): string | undefined {
  if (m === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text.slice(m.value.start, m.value.end));
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function locate(text: string, cells: readonly Node[], id: string): number | undefined {
  const found = cells.findIndex((c) => stringValue(text, member(c, 'id')) === id);
  if (found !== -1) return found;
  const number = id.startsWith('cell-') ? id.slice(5) : id;
  if (!/^\d+$/u.test(number)) return undefined;
  const index = Number(number);
  return index < cells.length ? index : undefined;
}

function intOf(text: string, m: Member | undefined): number | undefined {
  if (m === undefined) return undefined;
  const raw = text.slice(m.value.start, m.value.end).trim();
  return /^\d+$/u.test(raw) ? Number(raw) : undefined;
}

/** The notebook text after `edit`; throws [`NotebookError`]. */
export function editNotebook(text: string, edit: CellEdit): string {
  const scanner = new Scanner(text);
  if (text.startsWith('﻿')) scanner.at = 1;
  const root = scanner.value(0);
  scanner.skipSpace();
  if (scanner.at !== text.length) throw scanner.error('trailing text');
  const cellsMember = member(root, 'cells');
  if (cellsMember === undefined) throw invalid('there is no cells list');
  const cellsNode = cellsMember.value;
  if (cellsNode.kind !== 'array') throw invalid('cells is not a list');
  const cells = cellsNode.items;
  if (cells.some((c) => c.kind !== 'object')) throw invalid('a cell is not an object');
  const style = styleOf(text, root, cellsNode);
  let target: number | undefined;
  if (edit.cellId !== undefined) {
    target = locate(text, cells, edit.cellId);
    if (target === undefined) {
      throw new NotebookError(
        'cellNotFound',
        `Cell ${edit.cellId} was not found. Use a cell's id, or cell-N for the N-th cell (counting from 0) when the notebook has no ids; Read the notebook to see them.`,
      );
    }
  }
  if (edit.mode === 'replace') {
    if (target === undefined) {
      throw new NotebookError('missingCellId', 'cell_id is required to replace a cell.');
    }
    const cell = cells[target];
    if (cell === undefined) throw invalid('missing cell');
    const current = stringValue(text, member(cell, 'cell_type'));
    if (current !== 'code' && current !== 'markdown') {
      throw invalid(`cell ${String(target)} is neither code nor markdown`);
    }
    const indent = lineIndent(text, cell.start);
    const members = cellMembers(
      text,
      style,
      indent,
      cell,
      edit.cellType ?? current,
      edit.newSource,
      undefined,
    );
    return `${text.slice(0, cell.start)}${writeCell(style, indent, members)}${text.slice(cell.end)}`;
  }
  if (edit.mode === 'insert') {
    if (edit.cellType === undefined) {
      throw new NotebookError('missingCellType', 'cell_type is required to insert a cell.');
    }
    const major = intOf(text, member(root, 'nbformat'));
    const minor = intOf(text, member(root, 'nbformat_minor'));
    const usesIds =
      cells.some((c) => member(c, 'id') !== undefined) ||
      (major !== undefined && major > 4) ||
      (major === 4 && minor !== undefined && minor >= 5);
    const existing = cells.flatMap((c) => {
      const id = stringValue(text, member(c, 'id'));
      return id === undefined ? [] : [id];
    });
    const newId = usesIds ? newCellId(edit.seed, existing) : undefined;
    const first = cells[0];
    const indent =
      first === undefined
        ? `${lineIndent(text, cellsMember.keyStart)}${style.unit ?? ''}`
        : lineIndent(text, first.start);
    const members = cellMembers(
      text,
      style,
      indent,
      undefined,
      edit.cellType,
      edit.newSource,
      newId,
    );
    const written = writeCell(style, indent, members);
    const between = style.unit === undefined ? style.comma : `,${style.newline}${indent}`;
    if (first === undefined) {
      const closing = lineIndent(text, cellsMember.keyStart);
      const list =
        style.unit === undefined
          ? `[${written}]`
          : `[${style.newline}${indent}${written}${style.newline}${closing}]`;
      return `${text.slice(0, cellsNode.start)}${list}${text.slice(cellsNode.end)}`;
    }
    if (target !== undefined) {
      const after = cells[target];
      if (after === undefined) throw invalid('missing cell');
      return `${text.slice(0, after.end)}${between}${written}${text.slice(after.end)}`;
    }
    return `${text.slice(0, first.start)}${written}${between}${text.slice(first.start)}`;
  }
  if (target === undefined) {
    throw new NotebookError('missingCellId', 'cell_id is required to delete a cell.');
  }
  const cell = cells[target];
  if (cell === undefined) throw invalid('missing cell');
  if (cells.length === 1) {
    return `${text.slice(0, cellsNode.start)}[]${text.slice(cellsNode.end)}`;
  }
  const next = cells[target + 1];
  if (next !== undefined) return `${text.slice(0, cell.start)}${text.slice(next.start)}`;
  const previous = cells[target - 1];
  if (previous === undefined) throw invalid('missing cell');
  return `${text.slice(0, previous.end)}${text.slice(cell.end)}`;
}
