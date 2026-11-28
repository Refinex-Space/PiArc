// Markdown Studio's tableModel.ts preserves each cell segment and pipe. Marklyra's
// runtime/table-formatting.ts changes heading cells using parsed strong marks only.
// PiArc applies both to CodeMirror document offsets, including container prefixes.
import { markdownLanguage } from '@codemirror/lang-markdown';
import {
  cellSource,
  cellText,
  serializeLine,
  tableLines,
  alignColumn,
  type TableLine,
  type TableModel,
  type Change,
} from './table-model.js';

export interface Cell {
  row: number;
  col: number;
}
export interface Region {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
export type EditCommand =
  | 'addRow'
  | 'addRowBefore'
  | 'duplicateRow'
  | 'deleteRow'
  | 'moveUp'
  | 'moveDown'
  | 'addColumn'
  | 'addColumnBefore'
  | 'duplicateColumn'
  | 'deleteColumn'
  | 'moveLeft'
  | 'moveRight'
  | 'alignLeft'
  | 'alignRight'
  | 'alignCenter'
  | 'alignDefault'
  | 'headingRow'
  | 'headingColumn'
  | 'clear'
  | 'deleteTable';
export const maxRows = 128,
  maxColumns = 32;
export const area = (a: Cell, b: Cell): Region => ({
  top: Math.min(a.row, b.row),
  bottom: Math.max(a.row, b.row),
  left: Math.min(a.col, b.col),
  right: Math.max(a.col, b.col),
});
export const fullRow = (t: TableModel, row: number): Region => ({
  top: row,
  bottom: row,
  left: 0,
  right: t.columns - 1,
});
export const fullColumn = (t: TableModel, col: number): Region => ({
  top: 0,
  bottom: t.rows.length,
  left: col,
  right: col,
});
export const fullTable = (t: TableModel): Region => ({
  top: 0,
  bottom: t.rows.length,
  left: 0,
  right: t.columns - 1,
});
export const contains = (r: Region, c: Cell) =>
  c.row >= r.top && c.row <= r.bottom && c.col >= r.left && c.col <= r.right;
const displayed = (t: TableModel) => [t.header, ...t.rows];
const blank = (t: TableModel) => (t.header.segs.some((s) => s.startsWith(' ')) ? '  ' : ' ');
const blankRule = (t: TableModel) =>
  t.delimiter.segs.some((s) => s.startsWith(' ')) ? ' --- ' : '---';
const newRow = (t: TableModel, count = t.columns): TableLine => ({
  ...t.delimiter,
  segs: Array<string>(count).fill(blank(t)),
  starts: [],
  rest: '',
});
function changedLine(line: TableLine, after: string): Change | null {
  const before = serializeLine(line);
  if (before === after) return null;
  let a = 0,
    b = before.length,
    c = after.length;
  while (a < b && a < c && before.charCodeAt(a) === after.charCodeAt(a)) a++;
  while (b > a && c > a && before.charCodeAt(b - 1) === after.charCodeAt(c - 1)) {
    b--;
    c--;
  }
  return { from: line.from + a, to: line.from + b, insert: after.slice(a, c) };
}
// Minimize changes by line to preserve untouched source, its line endings and positions.
function patches(t: TableModel, lines: TableLine[]): Change[] {
  const before = tableLines(t),
    after = lines.map(serializeLine);
  const originals = before.map(serializeLine);
  let first = 0,
    b = before.length,
    a = after.length;
  while (first < b && first < a && originals[first] === after[first]) first++;
  while (first < b && first < a && originals[b - 1] === after[a - 1]) {
    b--;
    a--;
  }
  const result: Change[] = [];
  const common = Math.min(b, a);
  for (let i = first; i < common; i++) {
    const prev = before[i],
      next = after[i];
    if (prev && next !== undefined) {
      const ch = changedLine(prev, next);
      if (ch) result.push(ch);
    }
  }
  if (b > a) {
    const prev = before[a],
      last = before[b - 1];
    if (prev && last) result.push({ from: prev.from - 1, to: last.to, insert: '' });
  } else if (a > b) {
    const pos = before[b - 1]?.to ?? t.from;
    result.push({ from: pos, to: pos, insert: '\n' + after.slice(b, a).join('\n') });
  }
  return result;
}
function copyLines(t: TableModel) {
  return tableLines(t).map((line) => ({ ...line, segs: [...line.segs] }));
}
function pad(l: TableLine, n: number, fill: string) {
  while (l.segs.length < n) l.segs.push(fill);
}
function updateCell(l: TableLine, c: number, text: string, fill: string) {
  pad(l, c + 1, fill);
  const old = l.segs[c] ?? fill;
  const trimmed = old.trim();
  const indent = old.length - old.trimStart().length;
  l.segs[c] = trimmed
    ? old.slice(0, indent) + text + old.slice(indent + trimmed.length)
    : fill.startsWith(' ')
      ? ' ' + text + ' '
      : text;
}
const sourceIndex = (r: number) => (r === 0 ? 0 : r + 1);
export function boldHeading(raw: string) {
  const value = raw.trim();
  if (!value) return raw;
  const marks: { from: number; to: number }[] = [],
    hidden: { from: number; to: number }[] = [];
  markdownLanguage.parser.parse(value).iterate({
    enter(n) {
      if (n.name === 'StrongEmphasis') {
        hidden.push({ from: n.from, to: n.to });
        for (const mark of n.node.getChildren('EmphasisMark'))
          marks.push({ from: mark.from, to: mark.to });
      }
      if (n.name === 'URL' || n.name === 'LinkTitle' || n.name.endsWith('Mark'))
        hidden.push({ from: n.from, to: n.to });
      return ['InlineCode', 'URL', 'LinkTitle', 'HTMLTag'].includes(n.name) ? false : undefined;
    },
  });
  let cursor = 0,
    plain = '';
  for (const part of hidden.sort((a, b) => a.from - b.from)) {
    if (part.from > cursor) plain += value.slice(cursor, part.from);
    cursor = Math.max(cursor, part.to);
  }
  if (!(plain + value.slice(cursor)).trim()) return raw;
  let content = value;
  for (const m of marks.sort((a, b) => b.from - a.from))
    content = content.slice(0, m.from) + content.slice(m.to);
  const marker =
    content.includes('**') || content.startsWith('*') || content.endsWith('*') ? '__' : '**';
  const start = raw.length - raw.trimStart().length;
  return raw.slice(0, start) + marker + content + marker + raw.slice(start + value.length);
}
export function headingApplied(t: TableModel, r: Region) {
  const cells = displayed(t)
    .slice(r.top, r.bottom + 1)
    .flatMap((l) => l.segs.slice(r.left, r.right + 1))
    .filter((s) => s.trim());
  return cells.length > 0 && cells.every((s) => boldHeading(s) === s);
}
export function editAllowed(t: TableModel, r: Region, action: EditCommand) {
  switch (action) {
    case 'moveUp':
      return r.top > 1;
    case 'moveDown':
      return r.top > 0 && r.bottom < t.rows.length;
    case 'deleteRow':
    case 'addRowBefore':
      return r.top > 0 && (action === 'deleteRow' || t.rows.length + 1 < maxRows);
    case 'moveLeft':
      return r.left > 0;
    case 'moveRight':
      return r.right < t.columns - 1;
    case 'deleteColumn':
      return r.right - r.left + 1 < t.columns;
    case 'addRow':
      return t.rows.length + 1 < maxRows;
    case 'duplicateRow':
      return t.rows.length + 1 + r.bottom - r.top + 1 <= maxRows;
    case 'addColumn':
    case 'addColumnBefore':
      return t.columns < maxColumns;
    case 'duplicateColumn':
      return t.columns + r.right - r.left + 1 <= maxColumns;
    default:
      return true;
  }
}
function move<T>(list: T[], from: number, count: number, to: number) {
  list.splice(to, 0, ...list.splice(from, count));
  return list;
}
export function moveAxis(t: TableModel, r: Region, axis: 'row' | 'column', to: number): Change[] {
  const lines = copyLines(t),
    count = axis === 'row' ? r.bottom - r.top + 1 : r.right - r.left + 1;
  if (axis === 'row') {
    if (r.top < 1 || to < 1 || to > t.rows.length - count + 1) return [];
    return patches(t, move(lines, sourceIndex(r.top), count, sourceIndex(to)));
  } else {
    if (to < 0 || to > t.columns - count) return [];
    lines.forEach((l, i) => {
      pad(l, t.columns, i === 1 ? blankRule(t) : blank(t));
      l.segs = move(l.segs, r.left, count, to);
    });
  }
  return patches(t, lines);
}
export function editRegion(t: TableModel, r: Region, action: EditCommand): Change[] {
  if (!editAllowed(t, r, action)) return [];
  if (action === 'deleteTable') return [{ from: t.from, to: t.to, insert: '' }];
  if (action === 'moveUp' || action === 'moveDown')
    return moveAxis(t, r, 'row', r.top + (action === 'moveUp' ? -1 : 1));
  if (action === 'moveLeft' || action === 'moveRight')
    return moveAxis(t, r, 'column', r.left + (action === 'moveLeft' ? -1 : 1));
  if (
    action === 'alignLeft' ||
    action === 'alignCenter' ||
    action === 'alignRight' ||
    action === 'alignDefault'
  ) {
    const desired =
      action === 'alignLeft'
        ? 'left'
        : action === 'alignCenter'
          ? 'center'
          : action === 'alignRight'
            ? 'right'
            : null;
    const changes: Change[] = [];
    for (let c = r.left; c <= r.right; c++)
      if (t.aligns[c] !== desired) {
        const change = alignColumn(t, c, desired);
        if (change) changes.push(change);
      }
    return changes;
  }
  const lines = copyLines(t);
  const width = r.right - r.left + 1,
    height = r.bottom - r.top + 1;
  switch (action) {
    case 'addRowBefore':
      lines.splice(sourceIndex(r.top), 0, newRow(t));
      break;
    case 'addRow':
      lines.splice(r.bottom + 2, 0, newRow(t));
      break;
    case 'deleteRow':
      lines.splice(sourceIndex(r.top), height);
      break;
    case 'duplicateRow': {
      const clones = displayed(t)
        .slice(r.top, r.bottom + 1)
        .map((l, index) => ({
          ...l,
          indent: r.top === 0 && index === 0 ? t.delimiter.indent : l.indent,
        }));
      lines.splice(r.bottom + 2, 0, ...clones);
      break;
    }
    case 'duplicateColumn':
    case 'addColumn':
    case 'addColumnBefore':
    case 'deleteColumn':
      lines.forEach((l, i) => {
        const fill = i === 1 ? blankRule(t) : blank(t);
        pad(l, t.columns, fill);
        if (action === 'duplicateColumn')
          l.segs.splice(r.right + 1, 0, ...l.segs.slice(r.left, r.right + 1));
        else if (action === 'deleteColumn') l.segs.splice(r.left, width);
        else l.segs.splice(action === 'addColumnBefore' ? r.left : r.right + 1, 0, fill);
      });
      break;
    case 'clear':
    case 'headingRow':
    case 'headingColumn':
      for (let row = r.top; row <= r.bottom; row++) {
        const l = lines[sourceIndex(row)];
        if (!l) continue;
        for (let c = r.left; c <= r.right; c++) {
          const old = l.segs[c];
          if (!old?.trim()) continue;
          if (action === 'clear') updateCell(l, c, '', blank(t));
          else l.segs[c] = boldHeading(old);
        }
      }
      break;
  }
  return patches(t, lines);
}
export function resizeTable(t: TableModel, rows: number, columns: number): Change[] {
  if (
    !Number.isInteger(rows) ||
    !Number.isInteger(columns) ||
    rows < 1 ||
    rows > maxRows ||
    columns < 1 ||
    columns > maxColumns
  )
    return [];
  const lines = copyLines(t).slice(0, rows + 1);
  while (lines.length < rows + 1) lines.push(newRow(t, columns));
  lines.forEach((l, i) => {
    l.segs = l.segs.slice(0, columns);
    pad(l, columns, i === 1 ? blankRule(t) : blank(t));
  });
  return patches(t, lines);
}
export function rangeText(t: TableModel, r: Region, markdown: boolean) {
  const lines = displayed(t).slice(r.top, r.bottom + 1);
  if (markdown) {
    if (r.top === 0 && r.left === 0 && r.bottom === t.rows.length && r.right === t.columns - 1)
      return tableLines(t).map(serializeLine).join('\n');
    const row = (l: TableLine) =>
      '|' +
      Array.from({ length: r.right - r.left + 1 }, (_, i) => l.segs[i + r.left] ?? ' ').join('|') +
      '|';
    const values = lines.map(row);
    values.splice(1, 0, row(t.delimiter));
    return values.join('\n');
  }
  const escape = (s: string) => (/["\t\r\n]/u.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s);
  return lines
    .map((l) =>
      Array.from({ length: r.right - r.left + 1 }, (_, i) =>
        escape(cellText(l.segs[r.left + i])),
      ).join('\t'),
    )
    .join('\n');
}
export function pasteRectangle(t: TableModel, start: Cell, tsv: string): Change[] {
  if (tsv.length > 1024 * 1024) return [];
  const matrix: string[][] = [[]];
  let field = '',
    quoted = false;
  function endField() {
    matrix[matrix.length - 1]?.push(field);
    field = '';
  }
  const text = tsv.replace(/\r\n?/gu, '\n').replace(/\n$/u, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '"' && (quoted || !field)) {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && ch === '\t') {
      endField();
      if ((matrix.at(-1)?.length ?? 0) >= maxColumns) return [];
    } else if (!quoted && ch === '\n') {
      endField();
      if (matrix.length >= maxRows) return [];
      matrix.push([]);
    } else field += ch;
  }
  endField();
  const rows = Math.max(t.rows.length + 1, start.row + matrix.length),
    columns = Math.max(t.columns, start.col + Math.max(...matrix.map((l) => l.length)));
  if (rows > maxRows || columns > maxColumns) return [];
  const lines = copyLines(t);
  while (lines.length < rows + 1) lines.push(newRow(t, columns));
  if (columns > t.columns)
    lines.forEach((l, i) => {
      pad(l, columns, i === 1 ? blankRule(t) : blank(t));
    });
  matrix.forEach((cells, i) => {
    const l = lines[sourceIndex(start.row + i)];
    if (l)
      cells.forEach((v, c) => {
        updateCell(l, c + start.col, cellSource(v), blank(t));
      });
  });
  return patches(t, lines);
}
