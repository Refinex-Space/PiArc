import { Prec } from '@codemirror/state';
// Table mutations reuse Markdown Studio's lossless cell model. Every keystroke becomes
// a CodeMirror transaction, so autosave, undo, and external-file conflict detection share it.
import { TableControls } from './table-controls.js';
import { WidgetType, keymap, type EditorView } from '@codemirror/view';
import { repeatTableHeadings } from './table-fit.js';
import { paintCell } from './table-cell.js';
import { hostOf } from './widget-host.js';
import { parseTable, cellText, setCell } from './table-model.js';
interface Cell {
  row: number;
  col: number;
}
interface TableDOM {
  source: string;
  focused: Cell;
  fields: HTMLTextAreaElement[][];
  controls?: TableControls;
}
const mounted = new WeakMap<HTMLElement, TableDOM>();
const currentCell = new WeakMap<
  EditorView,
  { holder: HTMLElement; input: HTMLTextAreaElement; row: number; col: number }
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
  const a = sourceOffset(cell.input.selectionStart),
    z = sourceOffset(cell.input.selectionEnd);
  return {
    anchor: cell.input.selectionDirection === 'backward' ? z : a,
    head: cell.input.selectionDirection === 'backward' ? a : z,
  };
}
export function forgetTableSelection(view: EditorView) {
  currentCell.delete(view);
}
function currentTable(view: EditorView, holder: HTMLElement) {
  const mountedTable = mounted.get(holder);
  if (!mountedTable || !view.dom.contains(holder)) return null;
  const pos = view.posAtDOM(holder);
  if (view.state.sliceDoc(pos, pos + mountedTable.source.length) !== mountedTable.source)
    return null;
  return parseTable(mountedTable.source, pos);
}
// Keyboard approach to a rendered block follows Markdown Studio's livePreview/index.ts:
// move into the grid only once the arrow would leave the current wrapped visual line.
function enterTable(view: EditorView, down: boolean) {
  const selection = view.state.selection.main;
  if (!selection.empty || view.composing) return false;
  const line = view.state.doc.lineAt(selection.head);
  const neighbor = line.number + (down ? 1 : -1);
  if (neighbor < 1 || neighbor > view.state.doc.lines) return false;
  for (const holder of view.contentDOM.querySelectorAll<HTMLElement>('.md-live-table')) {
    const info = mounted.get(holder);
    if (!info) continue;
    const start = view.posAtDOM(holder),
      edge = down ? start : start + info.source.length;
    if (view.state.doc.lineAt(edge).number !== neighbor) continue;
    const next = view.moveVertically(selection, down);
    if (down ? next.head <= line.to : next.head >= line.from) return false;
    const field = down ? info.fields[0]?.[0] : info.fields.at(-1)?.at(-1);
    if (!field) return false;
    field.focus({ preventScroll: true });
    field.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const end = field.value.length;
    field.setSelectionRange(end, end);
    return true;
  }
  return false;
}
export const tableArrowKeys = Prec.high(
  keymap.of([
    { key: 'ArrowDown', run: (view) => enterTable(view, true) },
    { key: 'ArrowUp', run: (view) => enterTable(view, false) },
  ]),
);
function tableDom(source: string, view: EditorView) {
  const doc = view.dom.ownerDocument,
    t = hostOf(view.state).t;
  const holder = doc.createElement('div');
  holder.className = 'md-live-table';
  holder.contentEditable = 'false';
  const model = parseTable(source, 0);
  if (!model) return holder;
  const table = doc.createElement('table'),
    scroller = doc.createElement('div');
  scroller.className = 'md-table-scroller';
  table.setAttribute('role', 'grid');
  table.setAttribute('aria-label', t('files.viewer.table'));
  table.setAttribute('aria-multiselectable', 'true');
  table.setAttribute('aria-readonly', String(view.state.readOnly));
  const state: TableDOM = { source, focused: { row: 0, col: 0 }, fields: [] };
  mounted.set(holder, state);
  const head = doc.createElement('thead'),
    body = doc.createElement('tbody');
  for (const [row, line] of [model.header, ...model.rows].entries()) {
    const tr = doc.createElement('tr'),
      fields: HTMLTextAreaElement[] = [];
    state.fields[row] = fields;
    for (let col = 0; col < model.columns; col++) {
      const td = doc.createElement(row === 0 ? 'th' : 'td'),
        input = doc.createElement('textarea');
      input.rows = 1;
      input.wrap = 'soft';
      input.value = cellText(line.segs[col]);
      input.readOnly = view.state.readOnly;
      input.tabIndex = row === 0 && col === 0 ? 0 : -1;
      td.setAttribute('role', row === 0 ? 'columnheader' : 'gridcell');
      input.setAttribute('aria-keyshortcuts', 'Alt+Shift+T Shift+F10');
      input.setAttribute('aria-label', t('md.edit.tableCell', { row: row + 1, col: col + 1 }));
      td.style.textAlign = model.aligns[col] ?? 'start';
      input.style.textAlign = 'inherit';
      input.onfocus = () => {
        currentCell.set(view, { holder, input, row, col });
        const old = state.fields[state.focused.row]?.[state.focused.col];
        if (old) old.tabIndex = -1;
        state.focused = { row, col };
        input.tabIndex = 0;
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
      const display = doc.createElement('span');
      display.className = 'md-cell-display';
      display.setAttribute('aria-hidden', 'true');
      paintCell(display, input.value);
      display.dataset.raw = input.value;
      const contents = doc.createElement('div');
      contents.className = 'md-table-cell';
      contents.append(display, input);
      td.append(contents);
      tr.append(td);
      fields.push(input);
    }
    (row === 0 ? head : body).append(tr);
  }
  table.append(head, body);
  scroller.append(table);
  holder.append(scroller);
  state.controls = new TableControls({
    holder,
    table,
    scroller,
    view,
    model: () => currentTable(view, holder),
    focusCell: (pos, cell, where) => {
      const next = Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.md-live-table')).find(
        (el) => view.posAtDOM(el) === pos,
      );
      const rows = next ? mounted.get(next)?.fields : undefined;
      const line = rows?.[Math.max(0, Math.min(cell.row, rows.length - 1))],
        input = line?.[Math.max(0, Math.min(cell.col, line.length - 1))];
      if (!input) return;
      input.focus({ preventScroll: true });
      input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const end = input.value.length;
      input.setSelectionRange(
        where === 'all' || where === 'start' ? 0 : end,
        where === 'start' ? 0 : end,
      );
    },
  });
  return holder;
}
export class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly readOnly = false,
  ) {
    super();
  }
  override eq(other: TableWidget) {
    return other.source === this.source && other.readOnly === this.readOnly;
  }
  toDOM(view: EditorView) {
    return tableDom(this.source, view);
  }
  override destroy(holder: HTMLElement) {
    mounted.get(holder)?.controls?.destroy();
    mounted.delete(holder);
  }
  override updateDOM(holder: HTMLElement, view: EditorView, previous: this) {
    if (previous.readOnly !== this.readOnly) return false;
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
    state.controls?.invalidate();
    let headingChanged = false;
    for (const [r, l] of [model.header, ...model.rows].entries()) {
      for (const [c, input] of (state.fields[r] ?? []).entries()) {
        const value = cellText(l.segs[c]);
        if (input.value !== value) input.value = value;
        const display = input.previousElementSibling;
        if (display && display.getAttribute('data-raw') !== value) {
          if (r === 0) headingChanged = true;
          paintCell(display as HTMLElement, value);
          display.setAttribute('data-raw', value);
        }
        const cell = input.closest<HTMLTableCellElement>('td,th');
        if (cell) cell.style.textAlign = model.aligns[c] ?? 'start';
        input.readOnly = view.state.readOnly;
      }
    }
    if (headingChanged) {
      const table = holder.querySelector('table');
      if (table) repeatTableHeadings(table);
    }
    return true;
  }
}
