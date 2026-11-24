// The row and column grips follow the cell under the pointer (Markdown Studio
// livePreview/table.ts and Marklyra runtime/table-controls.ts). Hover is view state;
// source transactions start only on an explicit keyboard, menu or drop action.
import { isolateHistory, undo, redo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { isImeComposing } from '../../composer/ime-guard.js';
import { hostOf } from './widget-host.js';
import {
  area,
  contains,
  editRegion,
  fullColumn,
  fullRow,
  fullTable,
  moveAxis,
  pasteRectangle,
  rangeText,
  resizeTable,
  type Cell,
  type EditCommand,
  type Region,
} from './table-operations.js';
import { TablePanel, controlTitle, type Axis, type TableChoice } from './table-panel.js';
import type { TableModel, Change } from './table-model.js';
interface Parts {
  holder: HTMLElement;
  table: HTMLTableElement;
  scroller: HTMLElement;
  view: EditorView;
  model: () => TableModel | null;
  focusCell: (pos: number, cell: Cell, where: 'start' | 'end' | 'all') => void;
}
interface Selected {
  region: Region;
  anchor: Cell;
  focus: Cell;
}
type Grip = 'row' | 'column' | 'corner' | 'append-row' | 'append-column';
const data = (n: number) => String(Math.round(n * 100) / 100) + 'px';
function normalized(t: TableModel, p: Cell): Cell {
  return {
    row: Math.max(0, Math.min(t.rows.length, p.row)),
    col: Math.max(0, Math.min(t.columns - 1, p.col)),
  };
}
function targetCell(target: EventTarget | null, table: HTMLTableElement): Cell | null {
  const element = target as Element | null;
  const c =
    typeof element?.closest === 'function' ? element.closest<HTMLTableCellElement>('td,th') : null;
  return c?.closest('table') === table
    ? { row: (c.parentElement as HTMLTableRowElement).rowIndex, col: c.cellIndex }
    : null;
}
export class TableControls {
  private hit: Cell | null = null;
  private focus: Cell | null = null;
  private suppressClickUntil = 0;
  private picked: Selected | null = null;
  private menu: TablePanel | null = null;
  private grips = new Map<Grip, HTMLButtonElement>();
  private cleanup: (() => void)[] = [];
  private stopPointer: (() => void) | null = null;
  private viewActive = true;
  private opening = false;
  private composing = false;
  private resize: ResizeObserver | null = null;
  private dragOrigin: {
    x: number;
    y: number;
    axis: 'row' | 'column';
    cell: Cell;
    moved: boolean;
    to: number;
    doc: EditorView['state']['doc'];
  } | null = null;
  private restore: (() => void) | null = null;
  private status: HTMLElement;
  constructor(private readonly p: Parts) {
    const { holder, table, scroller, view } = p,
      doc = holder.ownerDocument,
      win = doc.defaultView;
    this.status = doc.createElement('span');
    this.status.className = 'visually-hidden';
    this.status.setAttribute('role', 'status');
    holder.append(this.status);
    holder.tabIndex = -1;
    holder.dataset.tableWidget = '';
    if (!view.state.readOnly)
      for (const role of ['row', 'column', 'corner', 'append-row', 'append-column'] as const)
        this.grip(role);
    this.listen(table, 'pointerover', (e) => {
      const cell = targetCell(e.target, table);
      if (cell && !this.menu && !this.dragOrigin && !this.composing) this.hover(cell);
    });
    this.listen(table, 'focusin', (e) => {
      const cell = targetCell(e.target, table);
      if (cell && !this.menu) {
        this.focus = cell;
        this.setSelection(null);
        this.hover(cell);
      }
    });
    this.listen(holder, 'pointerleave', () => {
      if (!this.opening && !this.menu && !this.dragOrigin && !this.picked) this.hover(null);
    });
    this.listen(holder, 'focusout', (e) => {
      const next = (e as FocusEvent).relatedTarget as Node | null;
      if (next && !holder.contains(next) && !this.menu && !this.opening) {
        this.setSelection(null);
        this.hover(null);
      }
    });
    this.listen(table, 'pointerdown', (e) => {
      this.pointer(e as PointerEvent);
    });
    this.listen(holder, 'contextmenu', (e) => {
      const m = e as MouseEvent;
      const cell = targetCell(m.target, table);
      if (!cell || this.composing || view.state.readOnly) return;
      m.preventDefault();
      m.stopPropagation();
      this.hit = cell;
      const region =
        this.picked && contains(this.picked.region, cell) ? this.picked.region : area(cell, cell);
      this.show('table', cell, region, { x: m.clientX, y: m.clientY }, false);
    });
    this.listen(holder, 'compositionstart', () => {
      this.composing = true;
      this.close(false);
      this.hover(null);
    });
    this.listen(holder, 'compositionend', () => {
      this.composing = false;
    });
    this.listen(
      holder,
      'keydown',
      (e) => {
        this.key(e as KeyboardEvent);
      },
      true,
    );
    this.listen(holder, 'copy', (e) => {
      this.clipboard(e as ClipboardEvent, false);
    });
    this.listen(holder, 'cut', (e) => {
      this.clipboard(e as ClipboardEvent, true);
    });
    this.listen(holder, 'paste', (e) => {
      this.paste(e as ClipboardEvent);
    });
    this.listen(scroller, 'scroll', () => {
      this.close(false);
      this.position();
    });
    if (win?.ResizeObserver) {
      this.resize = new win.ResizeObserver(() => {
        this.position();
      });
      this.resize.observe(table);
      this.resize.observe(scroller);
    }
  }
  private listen(target: EventTarget, type: string, handler: EventListener, capture = false) {
    target.addEventListener(type, handler, capture);
    this.cleanup.push(() => {
      target.removeEventListener(type, handler, capture);
    });
  }
  private grip(role: Grip) {
    const { holder, view } = this.p,
      doc = holder.ownerDocument,
      t = hostOf(view.state).t;
    const b = doc.createElement('button');
    b.type = 'button';
    b.hidden = true;
    b.tabIndex = -1;
    b.className = 'md-table-grip';
    b.dataset.tableControl = role;
    const label =
      role === 'row' || role === 'column'
        ? controlTitle(t, role)
        : t(
            role === 'corner'
              ? 'md.table.corner'
              : role === 'append-row'
                ? 'md.table.appendRow'
                : 'md.table.appendColumn',
          );
    b.setAttribute('aria-label', label);
    b.title = label;
    if (!role.startsWith('append')) {
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
    }
    b.onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (role === 'row' || role === 'column') this.startAxisDrag(e, role);
    };
    b.onpointerenter = () => {
      if (!this.menu && this.hit) this.paintHover(role);
    };
    b.onpointerleave = () => {
      delete holder.dataset.tableHoverAxis;
    };
    b.onclick = (e) => {
      if (e.detail && performance.now() < this.suppressClickUntil) return;
      const m = this.p.model(),
        cell = this.hit;
      if (!m || !cell || this.composing || view.state.readOnly) return;
      const drag = this.dragOrigin;
      this.dragOrigin = null;
      if (drag?.moved) return;
      if (role === 'append-row') {
        this.edit(fullRow(m, m.rows.length), 'addRow', { row: m.rows.length + 1, col: cell.col });
        return;
      }
      if (role === 'append-column') {
        this.edit(fullColumn(m, m.columns - 1), 'addColumn', { row: cell.row, col: m.columns });
        return;
      }
      const axis = role === 'corner' ? 'table' : role;
      const region = this.axisRegion(m, axis, cell, e.shiftKey);
      const rect = b.getBoundingClientRect();
      this.show(axis, cell, region, { x: rect.left, y: rect.bottom + 4 }, e.detail === 0);
    };
    holder.append(b);
    this.grips.set(role, b);
  }
  private hover(next: Cell | null) {
    if (this.dragOrigin || this.composing) return;
    if (next && this.hit?.row === next.row && this.hit.col === next.col) return;
    this.hit = next;
    this.position();
  }
  private axisRegion(m: TableModel, axis: Axis, c: Cell, extend = false) {
    if (axis === 'table') return fullTable(m);
    const target = axis === 'row' ? fullRow(m, c.row) : fullColumn(m, c.col);
    if (extend && this.picked) {
      if (axis === 'row') {
        target.top = Math.min(this.picked.anchor.row, c.row);
        target.bottom = Math.max(this.picked.anchor.row, c.row);
      } else {
        target.left = Math.min(this.picked.anchor.col, c.col);
        target.right = Math.max(this.picked.anchor.col, c.col);
      }
    }
    return target;
  }
  private paintHover(axis: Grip) {
    if (axis === 'row' || axis === 'column' || axis === 'corner')
      this.p.holder.dataset.tableHoverAxis = axis;
  }
  private position() {
    const { holder, scroller, table, view } = this.p;
    for (const g of this.grips.values()) g.hidden = true;
    if (!this.hit || view.state.readOnly || this.composing) return;
    const tr = table.rows[this.hit.row],
      cell = tr?.cells[this.hit.col];
    if (!cell) return;
    const h = holder.getBoundingClientRect(),
      scroll = scroller.getBoundingClientRect(),
      r = tr.getBoundingClientRect(),
      c = cell.getBoundingClientRect(),
      t = table.getBoundingClientRect();
    const x = Math.max(scroll.left, t.left) - h.left,
      y = t.top - h.top;
    const end = Math.min(scroll.right, t.right) - h.left,
      w = end - x;
    const left = Math.max(c.left, scroll.left) - h.left,
      right = Math.min(c.right, scroll.right) - h.left;
    let idx = 0;
    for (const row of table.rows) {
      row.toggleAttribute('data-hover-row', idx++ === this.hit.row);
    }
    const cols = table.querySelectorAll('[data-hover-column]');
    for (const el of cols) el.removeAttribute('data-hover-column');
    for (const row of table.rows) row.cells[this.hit.col]?.setAttribute('data-hover-column', '');
    const place = (
      id: Grip,
      l: number,
      top: number,
      width: number,
      height: number,
      shown = true,
    ) => {
      const b = this.grips.get(id);
      if (!b) return;
      b.hidden = !shown;
      if (shown)
        Object.assign(b.style, {
          left: data(l),
          top: data(top),
          width: data(Math.max(1, width)),
          height: data(Math.max(1, height)),
        });
    };
    place('corner', x - 24, y - 24, 24, 24);
    place('row', x - 24, r.top - h.top, 24, r.height);
    place(
      'column',
      left,
      y - 24,
      right - left,
      24,
      (c.right > scroll.left && c.left < scroll.right) || c.width === 0,
    );
    place('append-row', x, t.bottom - h.top, w, 24, this.hit.row === table.rows.length - 1);
    place(
      'append-column',
      end,
      y,
      24,
      t.height,
      this.hit.col === tr.cells.length - 1 && (t.right <= scroll.right + 1 || t.width === 0),
    );
  }
  private mark(region: Region | null) {
    for (const row of this.p.table.rows)
      for (const cell of row.cells) {
        const selected = !!region && contains(region, { row: row.rowIndex, col: cell.cellIndex });
        cell.toggleAttribute('data-table-selected', selected);
        if (selected) cell.setAttribute('aria-selected', 'true');
        else cell.removeAttribute('aria-selected');
      }
  }
  private setSelection(s: Selected | null) {
    this.picked = s;
    this.mark(s?.region ?? null);
  }
  private select(region: Region, anchor: Cell, focus = anchor) {
    this.setSelection({ region, anchor, focus });
  }
  private show(
    axis: Axis,
    cell: Cell,
    region: Region,
    point: { x: number; y: number },
    keyboard: boolean,
  ) {
    const { view, holder } = this.p,
      m = this.p.model();
    if (!m || view.state.readOnly || this.composing) return;
    this.close(false);
    const root = holder.getRootNode() as ShadowRoot | Document,
      previous = root.activeElement as HTMLElement | null;
    const oldInput = previous?.tagName === 'INPUT' ? (previous as HTMLInputElement) : null;
    const selection = oldInput
      ? ([oldInput.selectionStart, oldInput.selectionEnd, oldInput.selectionDirection] as const)
      : null;
    this.restore = () => {
      if (previous && previous.isConnected && holder.contains(previous)) {
        previous.focus({ preventScroll: true });
        if (oldInput && selection)
          oldInput.setSelectionRange(selection[0], selection[1], selection[2] ?? 'none');
      } else this.focusCell(m.from, cell);
    };
    this.hit = cell;
    this.select({ ...region }, cell);
    this.position();
    const original = view.state.doc,
      valid = () =>
        this.viewActive && !this.composing && !view.state.readOnly && view.state.doc === original;
    const o = {
      host: view.dom,
      t: hostOf(view.state).t,
      point,
      axis,
      model: m,
      region: { ...region },
      keyboard,
      valid,
      selectAxis: (next: Axis) => {
        const nextRegion = this.axisRegion(m, next, cell);
        Object.assign(o.region, nextRegion);
        this.select(nextRegion, cell);
      },
      pick: (action: TableChoice) => {
        this.choose(action, o.region, cell);
      },
      resize: (rows: number, cols: number) => {
        this.close(false);
        this.write(m, resizeTable(m, rows, cols), {
          row: Math.min(cell.row, rows - 1),
          col: Math.min(cell.col, cols - 1),
        });
      },
      dismiss: (restore: boolean) => {
        this.close(restore);
      },
    };
    this.grips.get(axis === 'table' ? 'corner' : axis)?.setAttribute('aria-expanded', 'true');
    this.opening = true;
    try {
      this.menu = new TablePanel(o);
    } finally {
      this.opening = false;
    }
  }
  private choose(cmd: TableChoice, r: Region, c: Cell) {
    const m = this.p.model();
    if (!m || this.composing || this.p.view.state.readOnly) return;
    this.close(false);
    if (cmd === 'copy' || cmd === 'copyMarkdown') {
      this.p.holder.focus({ preventScroll: true });
      this.copy(r, cmd === 'copyMarkdown');
      return;
    }
    if (cmd === 'selectTable' || cmd === 'selectRow' || cmd === 'selectColumn') {
      this.select(
        this.axisRegion(
          m,
          cmd === 'selectTable' ? 'table' : cmd === 'selectRow' ? 'row' : 'column',
          c,
        ),
        c,
      );
      this.p.holder.focus({ preventScroll: true });
      return;
    }
    if (cmd === 'source') {
      const anchor = m.header.from + 1;
      this.p.view.dispatch({ selection: { anchor }, scrollIntoView: true });
      this.p.view.focus();
      return;
    }
    if (cmd === 'resize') return;
    const region =
      cmd === 'headingRow'
        ? { ...fullRow(m, r.top), bottom: r.bottom }
        : cmd === 'headingColumn'
          ? { ...fullColumn(m, r.left), right: r.right }
          : r;
    this.edit(region, cmd, {
      row: c.row + (cmd === 'moveUp' ? -1 : cmd === 'moveDown' || cmd === 'addRow' ? 1 : 0),
      col: c.col + (cmd === 'moveLeft' ? -1 : cmd === 'moveRight' || cmd === 'addColumn' ? 1 : 0),
    });
  }
  private close(restore: boolean) {
    const old = this.menu,
      returnFocus = this.restore;
    this.menu = null;
    this.restore = null;
    old?.destroy();
    for (const b of this.grips.values())
      if (b.hasAttribute('aria-haspopup')) b.setAttribute('aria-expanded', 'false');
    if (restore && old) returnFocus?.();
  }
  private focusCell(pos: number, c: Cell, where: 'start' | 'end' | 'all' = 'all') {
    this.p.focusCell(pos, c, where);
  }
  private write(m: TableModel, changes: Change[], focus: Cell) {
    if (!changes.length) return;
    const view = this.p.view;
    view.dispatch({ changes, annotations: isolateHistory.of('full'), userEvent: 'input.table' });
    if (
      changes.length === 1 &&
      changes[0]?.insert === '' &&
      changes[0].from === m.from &&
      changes[0].to === m.to
    ) {
      view.focus();
      return;
    }
    this.focusCell(m.from, focus);
  }
  private edit(region: Region, command: EditCommand, focus: Cell) {
    const m = this.p.model();
    if (m && !this.p.view.state.readOnly && !this.composing)
      this.write(m, editRegion(m, region, command), focus);
  }
  private copy(region: Region, markdown: boolean) {
    const m = this.p.model();
    if (!m) return;
    const clipboard = this.p.holder.ownerDocument.defaultView?.navigator.clipboard;
    if (!clipboard) {
      this.status.textContent = hostOf(this.p.view.state).t('md.table.copyFailed');
      return;
    }
    void clipboard.writeText(rangeText(m, region, markdown)).catch(() => {
      this.status.textContent = hostOf(this.p.view.state).t('md.table.copyFailed');
    });
  }
  private clipboard(event: ClipboardEvent, cut: boolean) {
    const r = this.picked?.region,
      m = this.p.model();
    if (!r || !m || !event.clipboardData) return;
    event.preventDefault();
    event.stopPropagation();
    event.clipboardData.setData('text/plain', rangeText(m, r, false));
    if (cut) this.edit(r, 'clear', { row: r.top, col: r.left });
  }
  private paste(event: ClipboardEvent) {
    if (!event.clipboardData || this.composing || this.p.view.state.readOnly) return;
    const text = event.clipboardData.getData('text/plain');
    if (!this.picked && !/[\t\r\n]/u.test(text)) return;
    const m = this.p.model(),
      start = this.picked
        ? { row: this.picked.region.top, col: this.picked.region.left }
        : targetCell(event.target, this.p.table);
    if (!m || !start) return;
    event.preventDefault();
    event.stopPropagation();
    this.write(m, pasteRectangle(m, start, text), start);
  }
  private track(
    pointer: number,
    move: (e: PointerEvent) => void,
    finish: (event: PointerEvent) => void,
  ) {
    this.stopPointer?.();
    const doc = this.p.holder.ownerDocument;
    const travel = (e: PointerEvent) => {
      if (e.pointerId === pointer) move(e);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      stop();
      finish(e);
    };
    const stop = () => {
      doc.removeEventListener('pointermove', travel, true);
      doc.removeEventListener('pointerup', end, true);
      doc.removeEventListener('pointercancel', end, true);
      if (this.stopPointer === stop) this.stopPointer = null;
    };
    this.stopPointer = stop;
    doc.addEventListener('pointermove', travel, true);
    doc.addEventListener('pointerup', end, true);
    doc.addEventListener('pointercancel', end, true);
  }
  private cellUnder(e: PointerEvent) {
    const { holder, table } = this.p,
      root = holder.getRootNode() as ShadowRoot | Document;
    return (
      targetCell(e.composedPath()[0] ?? null, table) ??
      targetCell(root.elementFromPoint(e.clientX, e.clientY) ?? null, table)
    );
  }
  private pointer(e: PointerEvent) {
    if (e.button !== 0 || this.composing || this.p.view.state.readOnly) return;
    const c = targetCell(e.target, this.p.table);
    if (!c) return;
    const original = this.p.view.state.doc;
    this.close(false);
    if (e.shiftKey) {
      const anchor = this.picked?.anchor ?? this.focus ?? c;
      e.preventDefault();
      this.select(area(anchor, c), anchor, c);
      this.p.holder.focus({ preventScroll: true });
      return;
    }
    this.setSelection(null);
    this.hover(c);
    let selecting = false;
    this.track(
      e.pointerId,
      (ev) => {
        if (this.p.view.state.doc !== original) return;
        const hit = this.cellUnder(ev);
        if (!hit || (!selecting && hit.row === c.row && hit.col === c.col)) return;
        selecting = true;
        ev.preventDefault();
        this.select(area(c, hit), c, hit);
      },
      () => {
        if (selecting) this.p.holder.focus({ preventScroll: true });
      },
    );
  }
  private startAxisDrag(e: PointerEvent, axis: 'row' | 'column') {
    const m = this.p.model(),
      origin = this.hit;
    if (!m || !origin || this.composing || this.p.view.state.readOnly) return;
    const drag = {
      x: e.clientX,
      y: e.clientY,
      axis,
      cell: origin,
      moved: false,
      to: -1,
      doc: this.p.view.state.doc,
    };
    this.dragOrigin = drag;
    this.track(
      e.pointerId,
      (ev) => {
        if (drag.doc !== this.p.view.state.doc) return;
        if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) < 5 && !drag.moved)
          return;
        const hit = this.cellUnder(ev);
        if (!hit) return;
        drag.moved = true;
        ev.preventDefault();
        drag.to = axis === 'row' ? hit.row : hit.col;
        this.select(this.axisRegion(m, axis, origin), origin);
        this.p.holder.dataset.tableDragging = axis;
        for (const el of this.p.table.querySelectorAll('[data-table-drop]'))
          el.removeAttribute('data-table-drop');
        const dest = this.p.table.rows[hit.row]?.cells[hit.col];
        (axis === 'row' ? dest?.parentElement : dest)?.setAttribute('data-table-drop', axis);
      },
      (ev) => {
        delete this.p.holder.dataset.tableDragging;
        for (const el of this.p.table.querySelectorAll('[data-table-drop]'))
          el.removeAttribute('data-table-drop');
        if (
          ev.type === 'pointercancel' ||
          !drag.moved ||
          drag.to < 0 ||
          drag.doc !== this.p.view.state.doc
        ) {
          this.dragOrigin = null;
          return;
        }
        this.suppressClickUntil = performance.now() + 220;
        const region = this.axisRegion(m, axis, origin);
        this.write(
          m,
          moveAxis(m, region, axis, drag.to),
          axis === 'row' ? { ...origin, row: drag.to } : { ...origin, col: drag.to },
        );
        queueMicrotask(() => {
          if (this.dragOrigin === drag) this.dragOrigin = null;
        });
      },
    );
  }
  private leave(m: TableModel, after: boolean) {
    const view = this.p.view,
      line = view.state.doc.lineAt(after ? m.to : m.from);
    const adjacent = line.number + (after ? 1 : -1);
    if (adjacent >= 1 && adjacent <= view.state.doc.lines) {
      const dest = view.state.doc.line(adjacent);
      view.dispatch({ selection: { anchor: after ? dest.from : dest.to }, scrollIntoView: true });
    } else if (!view.state.readOnly) {
      const at = after ? line.to : line.from;
      view.dispatch({
        changes: { from: at, insert: '\n' },
        selection: { anchor: at + (after ? 1 : 0) },
        userEvent: 'input.type',
        scrollIntoView: true,
      });
    }
    view.focus();
  }
  private key(e: KeyboardEvent) {
    if (this.composing || isImeComposing(e)) return;
    const { view, holder, table } = this.p;
    const m = this.p.model();
    if (!m) return;
    const current = targetCell(e.target, table) ?? this.picked?.focus ?? this.hit;
    if (!current) return;
    const field = table.rows[current.row]?.cells[current.col]?.querySelector('input');
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if ((e.shiftKey && e.key === 'F10') || (e.altKey && e.shiftKey && e.code === 'KeyT')) {
      if (view.state.readOnly) return;
      stop();
      const rect = (field ?? holder).getBoundingClientRect();
      this.show(
        'row',
        current,
        fullRow(m, current.row),
        { x: rect.left, y: rect.bottom + 4 },
        true,
      );
      return;
    }
    if (this.picked && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      stop();
      this.select(fullTable(m), current);
      holder.focus({ preventScroll: true });
      return;
    }
    if (this.picked && (e.key === 'Delete' || e.key === 'Backspace')) {
      stop();
      this.edit(this.picked.region, 'clear', current);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && ['z', 'y'].includes(e.key.toLowerCase())) {
      stop();
      if (!view.state.readOnly) (e.key.toLowerCase() === 'y' || e.shiftKey ? redo : undo)(view);
      return;
    }
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.shiftKey && e.key.startsWith('Arrow')) {
      if (!this.picked && ['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const next = normalized(m, {
        row: current.row + (e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0),
        col: current.col + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0),
      });
      const a = this.picked?.anchor ?? current;
      stop();
      this.select(area(a, next), a, next);
      holder.focus({ preventScroll: true });
      return;
    }
    if (!field || e.target !== field) {
      if (e.key === 'Escape' && this.picked) {
        stop();
        this.setSelection(null);
        this.focusCell(m.from, current, 'end');
      }
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (!view.state.readOnly && mod && !e.altKey && ['b', 'i'].includes(e.key.toLowerCase())) {
      stop();
      const mark = e.key.toLowerCase() === 'b' ? '**' : '*',
        a = field.selectionStart ?? 0,
        b = field.selectionEnd ?? a;
      field.setRangeText(mark + field.value.slice(a, b) + mark, a, b, 'select');
      field.setSelectionRange(a + mark.length, b + mark.length);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const last = current.row === m.rows.length,
      first = current.row === 0,
      edge = first && current.col === 0,
      tail = last && current.col === m.columns - 1;
    if (e.key === 'Tab') {
      if (view.state.readOnly) return;
      stop();
      if (edge && e.shiftKey) {
        this.leave(m, false);
        return;
      }
      if (tail && !e.shiftKey) {
        this.edit(fullRow(m, m.rows.length), 'addRow', { row: m.rows.length + 1, col: 0 });
        return;
      }
      const i = current.row * m.columns + current.col + (e.shiftKey ? -1 : 1);
      this.focusCell(m.from, { row: Math.floor(i / m.columns), col: i % m.columns });
      return;
    }
    if (e.key === 'Escape') {
      stop();
      this.leave(m, true);
      return;
    }
    if (e.key === 'Enter' && mod) {
      if (!view.state.readOnly) {
        stop();
        this.edit(fullRow(m, current.row), 'addRow', { ...current, row: current.row + 1 });
      }
      return;
    }
    if (e.altKey || e.shiftKey || mod) return;
    if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      stop();
      const down = e.key !== 'ArrowUp';
      if ((down && last) || (!down && first)) this.leave(m, down);
      else this.focusCell(m.from, { ...current, row: current.row + (down ? 1 : -1) }, 'end');
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const right = e.key === 'ArrowRight';
      if (
        field.selectionStart !== field.selectionEnd ||
        field.selectionStart !== (right ? field.value.length : 0)
      )
        return;
      stop();
      if ((right && tail) || (!right && edge)) this.leave(m, right);
      else {
        const i = current.row * m.columns + current.col + (right ? 1 : -1);
        this.focusCell(
          m.from,
          { row: Math.floor(i / m.columns), col: i % m.columns },
          right ? 'start' : 'end',
        );
      }
    }
  }
  invalidate() {
    this.dragOrigin = null;
    this.stopPointer?.();
    this.close(false);
    this.setSelection(null);
    this.hover(null);
  }
  destroy() {
    this.viewActive = false;
    this.close(false);
    this.stopPointer?.();
    this.resize?.disconnect();
    for (const off of this.cleanup) off();
  }
}
