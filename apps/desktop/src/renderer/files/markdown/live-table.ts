import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
// Table mutations reuse Markdown Studio's lossless cell model. Every keystroke becomes
// a CodeMirror transaction, so autosave, undo, and external-file conflict detection share it.
import { redo, undo } from '@codemirror/commands';
import { WidgetType, type EditorView } from '@codemirror/view';
import { paintCell } from './table-cell.js';
import { hostOf } from './widget-host.js';
import {
  parseTable,
  cellText,
  setCell,
  insertRow,
  insertColumn,
  deleteRow,
  deleteColumn,
  alignColumn,
  moveColumn,
  moveRow,
  type Change,
  type TableModel,
} from './table-model.js';
interface Cell {
  row: number;
  col: number;
}
export type TableAction =
  | 'addRow'
  | 'addColumn'
  | 'deleteRow'
  | 'deleteColumn'
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'
  | 'moveLeft'
  | 'moveRight'
  | 'moveUp'
  | 'moveDown'
  | 'source';
export const tableActions: readonly TableAction[] = [
  'addRow',
  'addColumn',
  'deleteRow',
  'deleteColumn',
  'alignLeft',
  'alignCenter',
  'alignRight',
  'moveLeft',
  'moveRight',
  'moveUp',
  'moveDown',
  'source',
];
interface TableDOM {
  source: string;
  focused: Cell;
  fields: HTMLInputElement[][];
}
const mounted = new WeakMap<HTMLElement, TableDOM>();
const currentCell = new WeakMap<
  EditorView,
  { holder: HTMLElement; input: HTMLInputElement; row: number; col: number }
>();
export function cellSelection(view: EditorView) {
  const cell = currentCell.get(view);
  if (!cell) return undefined;
  const m = currentTable(view, cell.holder);
  const l = cell.row === 0 ? m?.header : m?.rows[cell.row - 1];
  const raw = l?.segs[cell.col],
    at = l?.starts[cell.col];
  if (!l || raw === undefined || at === undefined) return undefined;
  const trimmed = raw.trim(),
    start = at + raw.length - raw.trimStart().length;
  const sourceOffset = (index: number) => {
    let source = 0;
    for (let typed = 0; typed < index && source < trimmed.length; typed++) {
      if (trimmed[source] === '\\' && trimmed[source + 1] === '|') source++;
      source++;
    }
    return start + source;
  };
  const a = sourceOffset(cell.input.selectionStart ?? 0),
    z = sourceOffset(cell.input.selectionEnd ?? 0);
  return {
    anchor: cell.input.selectionDirection === 'backward' ? z : a,
    head: cell.input.selectionDirection === 'backward' ? a : z,
  };
}
export function forgetTableSelection(view: EditorView) {
  currentCell.delete(view);
}
function cellChanges(
  table: TableModel,
  cell: Cell,
  action: Exclude<TableAction, 'source'>,
): Change | Change[] | null {
  switch (action) {
    case 'addRow':
      return insertRow(table, cell.row);
    case 'addColumn':
      return insertColumn(table, cell.col + 1);
    case 'deleteRow':
      return deleteRow(table, cell.row);
    case 'deleteColumn':
      return deleteColumn(table, cell.col);
    case 'alignLeft':
      return alignColumn(table, cell.col, 'left');
    case 'alignCenter':
      return alignColumn(table, cell.col, 'center');
    case 'alignRight':
      return alignColumn(table, cell.col, 'right');
    case 'moveLeft':
      return moveColumn(table, cell.col, -1);
    case 'moveRight':
      return moveColumn(table, cell.col, 1);
    case 'moveUp':
      return moveRow(table, cell.row, -1);
    case 'moveDown':
      return moveRow(table, cell.row, 1);
  }
}
export function tableAtCursor(state: EditorState): SyntaxNode | null {
  const pos = state.selection.main.head;
  for (const bias of [1, -1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, bias); n; n = n.parent) {
      if (n.name === 'Table') return n;
    }
  }
  return null;
}
export function applySourceTableAction(view: EditorView, action: TableAction) {
  const state = view.state,
    node = tableAtCursor(state);
  if (!node || action === 'source' || state.readOnly || view.composing) return;
  const model = parseTable(state.sliceDoc(node.from, node.to), node.from);
  if (!model) return;
  const pos = state.selection.main.head;
  const delta = state.doc.lineAt(pos).number - state.doc.lineAt(node.from).number;
  const row = Math.max(0, Math.min(model.rows.length, delta - 1));
  const line = delta === 1 ? model.delimiter : row === 0 ? model.header : model.rows[row - 1];
  const col = Math.max(
    0,
    Math.min(model.columns - 1, (line?.starts.filter((start) => start <= pos).length ?? 1) - 1),
  );
  const edits = cellChanges(model, { row, col }, action);
  if (edits) view.dispatch({ changes: edits, userEvent: 'input.table', scrollIntoView: true });
  view.focus();
}
function currentTable(view: EditorView, holder: HTMLElement) {
  const mountedTable = mounted.get(holder);
  if (!mountedTable || !view.dom.contains(holder)) return null;
  const pos = view.posAtDOM(holder);
  if (view.state.sliceDoc(pos, pos + mountedTable.source.length) !== mountedTable.source)
    return null;
  return parseTable(mountedTable.source, pos);
}
function tableDom(source: string, view: EditorView) {
  const doc = view.dom.ownerDocument,
    t = hostOf(view.state).t;
  const holder = doc.createElement('div');
  holder.className = 'md-live-table';
  holder.contentEditable = 'false';
  const model = parseTable(source, 0);
  if (!model) return holder;
  const table = doc.createElement('table'),
    toolbar = doc.createElement('div'),
    menu = doc.createElement('select');
  const state: TableDOM = { source, focused: { row: 0, col: 0 }, fields: [] };
  mounted.set(holder, state);
  const label = t('md.edit.tableActions');
  menu.setAttribute('aria-label', label);
  const title = doc.createElement('option');
  title.textContent = label;
  title.value = '';
  menu.append(title);
  for (const action of tableActions) {
    const option = doc.createElement('option');
    option.value = action;
    option.textContent = t(`md.edit.${action}`);
    menu.append(option);
  }
  function available(cell: Cell) {
    for (const opt of menu.options) {
      const a = opt.value;
      opt.disabled =
        a !== '' &&
        a !== 'source' &&
        (view.state.readOnly ||
          ((a === 'deleteRow' || a === 'moveUp' || a === 'moveDown') && cell.row === 0) ||
          (a === 'deleteColumn' && model?.columns === 1) ||
          (a === 'moveUp' && cell.row <= 1) ||
          (a === 'moveDown' && cell.row === (model?.rows.length ?? 0)) ||
          (a === 'moveLeft' && cell.col === 0) ||
          (a === 'moveRight' && cell.col === (model?.columns ?? 1) - 1));
    }
  }
  available(state.focused);
  menu.onchange = () => {
    const m = currentTable(view, holder);
    const cmd = tableActions.find((id) => id === menu.value);
    menu.value = '';
    if (!m || !cmd) return;
    if (cmd === 'source') {
      view.dispatch({
        selection: { anchor: m.from + Math.min(1, m.to - m.from) },
        scrollIntoView: true,
      });
      view.focus();
      return;
    }
    const changes = cellChanges(m, state.focused, cmd);
    if (changes && !view.state.readOnly) {
      const cell = { ...state.focused };
      view.dispatch({ changes, userEvent: 'input.table' });
      const next = Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.md-live-table')).find(
        (el) => view.posAtDOM(el) === m.from,
      );
      const rows = next ? mounted.get(next)?.fields : undefined;
      if (rows?.length) {
        const row =
          rows[
            Math.min(
              rows.length - 1,
              Math.max(
                0,
                cell.row + (cmd === 'moveUp' ? -1 : cmd === 'moveDown' || cmd === 'addRow' ? 1 : 0),
              ),
            )
          ];
        row?.[
          Math.min(
            row.length - 1,
            Math.max(
              0,
              cell.col +
                (cmd === 'moveLeft' ? -1 : cmd === 'moveRight' || cmd === 'addColumn' ? 1 : 0),
            ),
          )
        ]?.focus();
      }
    }
  };
  toolbar.append(menu);
  const head = doc.createElement('thead'),
    body = doc.createElement('tbody');
  for (const [row, line] of [model.header, ...model.rows].entries()) {
    const tr = doc.createElement('tr'),
      fields: HTMLInputElement[] = [];
    state.fields[row] = fields;
    for (let col = 0; col < model.columns; col++) {
      const td = doc.createElement(row === 0 ? 'th' : 'td'),
        input = doc.createElement('input');
      input.value = cellText(line.segs[col]);
      input.readOnly = view.state.readOnly;
      input.tabIndex = row === 0 && col === 0 ? 0 : -1;
      input.setAttribute('aria-label', t('md.edit.tableCell', { row: row + 1, col: col + 1 }));
      td.style.textAlign = model.aligns[col] ?? 'start';
      input.style.textAlign = 'inherit';
      input.onfocus = () => {
        currentCell.set(view, { holder, input, row, col });
        const old = state.fields[state.focused.row]?.[state.focused.col];
        if (old) old.tabIndex = -1;
        state.focused = { row, col };
        input.tabIndex = 0;
        available({ row, col });
      };
      const commit = () => {
        if (view.state.readOnly) return;
        const m = currentTable(view, holder);
        if (!m) return;
        const ch = setCell(m, row, col, input.value);
        if (ch && view.state.sliceDoc(ch.from, ch.to) !== ch.insert)
          view.dispatch({ changes: ch, userEvent: 'input.type' });
      };
      input.oninput = (event) => {
        if (!event.isComposing) commit();
      };
      input.addEventListener('compositionend', commit);
      input.onkeydown = (e) => {
        if (e.isComposing) return;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && ['z', 'y'].includes(e.key.toLowerCase())) {
          e.preventDefault();
          e.stopPropagation();
          (e.shiftKey || e.key.toLowerCase() === 'y' ? redo : undo)(view);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          view.focus();
          return;
        }
        if (!['Tab', 'Enter', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        const at = row * model.columns + col;
        const step =
          e.key === 'Tab'
            ? e.shiftKey
              ? -1
              : 1
            : model.columns * (e.key === 'ArrowUp' || e.shiftKey ? -1 : 1);
        const n = at + step;
        const next = state.fields[Math.floor(n / model.columns)]?.[n % model.columns];
        if (next) {
          e.preventDefault();
          e.stopPropagation();
          next.focus();
          next.select();
        }
      };
      const display = doc.createElement('span');
      display.className = 'md-cell-display';
      display.setAttribute('aria-hidden', 'true');
      paintCell(display, input.value);
      display.dataset.raw = input.value;
      td.append(display, input);
      tr.append(td);
      fields.push(input);
    }
    (row === 0 ? head : body).append(tr);
  }
  table.append(head, body);
  holder.append(table, toolbar);
  return holder;
}
export class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  override eq(other: TableWidget) {
    return other.source === this.source;
  }
  toDOM(view: EditorView) {
    return tableDom(this.source, view);
  }
  override updateDOM(holder: HTMLElement, view: EditorView) {
    const state = mounted.get(holder),
      model = parseTable(this.source, 0);
    if (
      !state ||
      !model ||
      state.fields.length !== model.rows.length + 1 ||
      state.fields[0]?.length !== model.columns
    )
      return false;
    state.source = this.source;
    for (const [r, l] of [model.header, ...model.rows].entries()) {
      for (const [c, input] of (state.fields[r] ?? []).entries()) {
        const value = cellText(l.segs[c]);
        if (input.value !== value) input.value = value;
        const display = input.previousElementSibling;
        if (display && display.getAttribute('data-raw') !== value) {
          paintCell(display as HTMLElement, value);
          display.setAttribute('data-raw', value);
        }
        if (input.parentElement) input.parentElement.style.textAlign = model.aligns[c] ?? 'start';
        input.readOnly = view.state.readOnly;
      }
    }
    return true;
  }
}
