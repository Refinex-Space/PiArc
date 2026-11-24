// Row, column and table controls share a single popup. Keep the alignment flyout
// anchored to the parent panel's edge while the table's own scroller moves independently.
import { isImeComposing } from '../../composer/ime-guard.js';
import type { AppContextValue } from '../../app/app-context.js';
import type { EditCommand, Region } from './table-operations.js';
import {
  editAllowed,
  fullRow,
  fullColumn,
  headingApplied,
  maxRows,
  maxColumns,
} from './table-operations.js';
import type { TableModel } from './table-model.js';
export type Axis = 'row' | 'column' | 'table';
export type TableChoice =
  | EditCommand
  | 'copy'
  | 'copyMarkdown'
  | 'source'
  | 'selectRow'
  | 'selectColumn'
  | 'selectTable'
  | 'resize';
type T = AppContextValue['t'];
const labels = {
  addRow: 'md.edit.addRow',
  addRowBefore: 'md.table.addRowBefore',
  duplicateRow: 'md.table.duplicateRow',
  deleteRow: 'md.edit.deleteRow',
  moveUp: 'md.edit.moveUp',
  moveDown: 'md.edit.moveDown',
  addColumnBefore: 'md.table.addColumnBefore',
  addColumn: 'md.edit.addColumn',
  duplicateColumn: 'md.table.duplicateColumn',
  deleteColumn: 'md.edit.deleteColumn',
  moveLeft: 'md.edit.moveLeft',
  moveRight: 'md.edit.moveRight',
  alignLeft: 'md.edit.alignLeft',
  alignCenter: 'md.edit.alignCenter',
  alignRight: 'md.edit.alignRight',
  alignDefault: 'md.table.alignDefault',
  headingRow: 'md.table.headingRow',
  headingColumn: 'md.table.headingColumn',
  clear: 'md.table.clear',
  deleteTable: 'md.table.deleteTable',
  copy: 'md.table.copy',
  copyMarkdown: 'md.table.copyMarkdown',
  source: 'md.edit.source',
  selectRow: 'md.table.selectRow',
  selectColumn: 'md.table.selectColumn',
  selectTable: 'md.table.selectTable',
  resize: 'md.table.resize',
} as const;
const axisLabel = {
  row: 'md.table.rowActions',
  column: 'md.table.columnActions',
  table: 'md.table.tableActions',
} as const;
export const controlTitle = (t: T, a: Axis) => t(axisLabel[a]);
const groups: Record<Axis, readonly (readonly (TableChoice | 'align')[])[]> = {
  row: [
    ['moveUp', 'moveDown'],
    ['addRowBefore', 'addRow', 'duplicateRow'],
    ['selectRow', 'headingRow'],
    ['copy', 'deleteRow'],
  ],
  column: [
    ['moveLeft', 'moveRight'],
    ['addColumnBefore', 'addColumn', 'duplicateColumn'],
    ['selectColumn', 'headingColumn', 'align'],
    ['copy', 'deleteColumn'],
  ],
  table: [
    ['selectRow', 'selectColumn', 'selectTable'],
    ['copy', 'copyMarkdown', 'clear'],
    ['resize', 'source', 'deleteTable'],
  ],
};
interface Options {
  host: HTMLElement;
  t: T;
  point: { x: number; y: number };
  axis: Axis;
  model: TableModel;
  region: Region;
  valid: () => boolean;
  pick: (action: TableChoice, axis: Axis) => void;
  resize: (rows: number, cols: number) => void;
  selectAxis: (axis: Axis) => void;
  dismiss: (restore: boolean) => void;
  keyboard: boolean;
}
export class TablePanel {
  private readonly root: HTMLDivElement;
  private readonly doc: Document;
  private readonly win: Window;
  private child: HTMLDivElement | null = null;
  private axis: Axis;
  private closed = false;
  private alignTrigger: HTMLButtonElement | null = null;
  private readonly outside: (e: Event) => void;
  private readonly resizeWindow: () => void;
  constructor(private readonly o: Options) {
    this.doc = o.host.ownerDocument;
    this.win = this.doc.defaultView ?? window;
    this.axis = o.axis;
    this.root = this.doc.createElement('div');
    this.root.className = 'md-table-popover';
    this.mount(this.root);
    this.render();
    this.place(this.root, o.point.x, o.point.y);
    this.outside = (e) => {
      const path = e.composedPath();
      if (!path.includes(this.root) && !(this.child && path.includes(this.child))) o.dismiss(false);
    };
    this.resizeWindow = () => {
      o.dismiss(false);
    };
    this.doc.addEventListener('pointerdown', this.outside, true);
    this.win.addEventListener('resize', this.resizeWindow);
    if (o.keyboard) this.first(this.root)?.focus({ preventScroll: true });
    else this.root.querySelector<HTMLElement>('[role=menu]')?.focus({ preventScroll: true });
  }
  private mount(el: HTMLElement) {
    this.o.host.append(el);
    if (el.isConnected && typeof el.showPopover === 'function') {
      el.setAttribute('popover', 'manual');
      el.showPopover();
    }
  }
  private place(el: HTMLElement, x: number, y: number) {
    const rect = el.getBoundingClientRect();
    el.style.left = String(Math.max(4, Math.min(x, this.win.innerWidth - rect.width - 4))) + 'px';
    el.style.top = String(Math.max(4, Math.min(y, this.win.innerHeight - rect.height - 4))) + 'px';
  }
  private clearChild() {
    this.child?.remove();
    this.child = null;
    this.alignTrigger?.setAttribute('aria-expanded', 'false');
  }
  private enabled(root: HTMLElement) {
    return [...root.querySelectorAll<HTMLButtonElement>('button[role^=menuitem]:not(:disabled)')];
  }
  private first(el: HTMLElement) {
    return this.enabled(el)[0];
  }
  private item(choice: TableChoice | 'align', parent: HTMLElement, sub = false) {
    const { o } = this;
    const b = this.doc.createElement('button');
    b.type = 'button';
    b.className = 'md-table-menu-item';
    b.tabIndex = -1;
    b.textContent = choice === 'align' ? o.t('md.table.alignment') : o.t(labels[choice]);
    b.dataset.tableAction = choice;
    const f = o.region;
    let ariaRole = 'menuitem';
    if (sub && choice.startsWith('align')) {
      ariaRole = 'menuitemradio';
      const expected =
        choice === 'alignLeft'
          ? 'left'
          : choice === 'alignCenter'
            ? 'center'
            : choice === 'alignRight'
              ? 'right'
              : null;
      b.setAttribute(
        'aria-checked',
        String(o.model.aligns.slice(f.left, f.right + 1).every((a) => a === expected)),
      );
    }
    if (choice === 'headingRow' || choice === 'headingColumn') {
      ariaRole = 'menuitemcheckbox';
      const region =
        choice === 'headingRow'
          ? { ...fullRow(o.model, f.top), bottom: f.bottom }
          : { ...fullColumn(o.model, f.left), right: f.right };
      b.setAttribute('aria-checked', String(headingApplied(o.model, region)));
    }
    b.setAttribute('role', ariaRole);
    if (choice === 'align') {
      this.alignTrigger = b;
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
      b.addEventListener('pointerenter', () => {
        this.align(false);
      });
      b.onclick = () => {
        this.align(true);
      };
    } else {
      if (
        choice in labels &&
        ![
          'copy',
          'copyMarkdown',
          'selectRow',
          'selectColumn',
          'selectTable',
          'resize',
          'source',
        ].includes(choice)
      )
        b.disabled = !editAllowed(o.model, f, choice as EditCommand);
      if (choice.startsWith('delete') || choice === 'clear') b.dataset.danger = 'true';
      b.onclick = () => {
        if (
          this.closed ||
          (!this.root.contains(b) && !this.child?.contains(b)) ||
          b.disabled ||
          !o.valid()
        )
          return;
        if (choice === 'resize') {
          this.sizePanel();
          return;
        }
        o.pick(choice, this.axis);
      };
      if (!sub)
        b.addEventListener('pointerenter', () => {
          this.clearChild();
        });
    }
    parent.append(b);
  }
  private render() {
    this.clearChild();
    this.root.replaceChildren();
    const tabs = this.doc.createElement('div');
    tabs.className = 'md-table-menu-tabs';
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', this.o.t('md.table.tableActions'));
    for (const axis of ['row', 'column', 'table'] as const) {
      const tab = this.doc.createElement('button');
      tab.type = 'button';
      tab.textContent = controlTitle(this.o.t, axis);
      tab.setAttribute('aria-pressed', String(this.axis === axis));
      tab.onclick = () => {
        this.switch(axis);
      };
      tabs.append(tab);
    }
    const menu = this.doc.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.tabIndex = -1;
    menu.setAttribute('aria-label', controlTitle(this.o.t, this.axis));
    for (const section of groups[this.axis]) {
      if (menu.childElementCount) {
        const sep = this.doc.createElement('hr');
        sep.setAttribute('role', 'separator');
        menu.append(sep);
      }
      for (const id of section) this.item(id, menu);
    }
    this.root.append(tabs, menu);
    this.root.onkeydown = (e) => {
      this.key(e, false);
    };
  }
  private switch(axis: Axis) {
    if (this.closed || !this.o.valid()) return;
    this.axis = axis;
    this.o.selectAxis(axis);
    this.render();
    this.place(this.root, this.o.point.x, this.o.point.y);
    this.first(this.root)?.focus();
  }
  private align(keyboard: boolean) {
    if (this.closed || !this.o.valid() || !this.alignTrigger) return;
    if (!this.child) {
      const child = this.doc.createElement('div');
      child.className = 'md-table-popover md-table-submenu';
      child.setAttribute('role', 'menu');
      child.setAttribute('aria-label', this.o.t('md.table.alignment'));
      for (const a of ['alignLeft', 'alignCenter', 'alignRight', 'alignDefault'] as const)
        this.item(a, child, true);
      this.child = child;
      this.mount(child);
      const outer = this.root.getBoundingClientRect(),
        anchor = this.alignTrigger.getBoundingClientRect(),
        w = child.getBoundingClientRect().width;
      const right = this.win.innerWidth - outer.right - 8,
        left = outer.left - 8;
      if (Math.max(right, left) < w) {
        this.root.hidden = true;
        child.dataset.stacked = 'true';
        const back = this.doc.createElement('button');
        back.type = 'button';
        back.className = 'md-table-menu-item';
        back.setAttribute('role', 'menuitem');
        back.textContent = this.o.t('nav.back');
        back.onclick = () => {
          this.root.hidden = false;
          this.clearChild();
          this.alignTrigger?.focus();
        };
        child.prepend(back);
        this.place(child, outer.left, outer.top);
      } else this.place(child, right >= w ? outer.right + 4 : outer.left - 4 - w, anchor.top);
      this.alignTrigger.setAttribute('aria-expanded', 'true');
      child.onkeydown = (e) => {
        this.key(e, true);
      };
    }
    if (keyboard) this.first(this.child)?.focus();
  }
  private key(e: KeyboardEvent, sub: boolean) {
    if (isImeComposing(e)) return;
    const origin = e.target as HTMLElement;
    const menu = sub ? this.child : this.root;
    if (!menu) return;
    const enabled = this.enabled(menu),
      index = enabled.indexOf(origin as HTMLButtonElement);
    if (e.key === 'Escape' || (sub && e.key === 'ArrowLeft')) {
      if (sub) {
        this.root.hidden = false;
        this.clearChild();
        this.alignTrigger?.focus();
      } else this.o.dismiss(true);
    } else if (e.key === 'ArrowRight' && origin === this.alignTrigger) {
      this.align(true);
    } else if (!sub && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const axes = ['row', 'column', 'table'] as const;
      this.switch(axes[(axes.indexOf(this.axis) + (e.key === 'ArrowLeft' ? 2 : 1)) % 3] ?? 'row');
    } else if (
      e.key === 'ArrowDown' ||
      e.key === 'ArrowUp' ||
      e.key === 'Home' ||
      e.key === 'End'
    ) {
      const target =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? enabled.length - 1
            : e.key === 'ArrowDown'
              ? index + 1
              : index < 0
                ? enabled.length - 1
                : index - 1;
      enabled[(target + enabled.length) % enabled.length]?.focus();
    } else if (e.key === 'Tab') {
      this.o.dismiss(true);
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (index < 0) return;
      enabled[index]?.click();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }
  private sizePanel() {
    const { o, doc } = this;
    this.clearChild();
    this.root.replaceChildren();
    const title = doc.createElement('strong');
    title.textContent = o.t('md.table.resize');
    const form = doc.createElement('form');
    form.className = 'md-table-size';
    form.setAttribute('aria-label', o.t('md.table.resize'));
    const integer = (key: 'rows' | 'columns', v: number, max: number) => {
      const label = doc.createElement('label');
      label.textContent = o.t(('md.table.' + key) as 'md.table.rows' | 'md.table.columns');
      const input = doc.createElement('input');
      input.value = String(v);
      input.type = 'number';
      input.min = '1';
      input.max = String(max);
      input.required = true;
      label.append(input);
      form.append(label);
      return input;
    };
    const rows = integer('rows', o.model.rows.length + 1, maxRows),
      cols = integer('columns', o.model.columns, maxColumns);
    const grid = doc.createElement('div');
    grid.className = 'md-table-size-grid';
    const show = (r: number, c: number) => {
      for (const [i, cell] of [...grid.children].entries())
        (cell as HTMLElement).dataset.fill = String(Math.floor(i / 6) < r && i % 6 < c);
    };
    for (let r = 1; r <= 10; r++)
      for (let c = 1; c <= 6; c++) {
        const dot = doc.createElement('button');
        dot.type = 'button';
        dot.tabIndex = -1;
        dot.setAttribute('aria-label', o.t('md.edit.tableCell', { row: r, col: c }));
        dot.onpointerenter = () => {
          rows.value = String(r);
          cols.value = String(c);
          show(r, c);
        };
        dot.onclick = () => {
          if (!this.closed && o.valid()) o.resize(r, c);
        };
        grid.append(dot);
      }
    show(rows.valueAsNumber, cols.valueAsNumber);
    grid.setAttribute('aria-hidden', 'true');
    const apply = doc.createElement('button');
    apply.type = 'submit';
    apply.textContent = o.t('md.table.apply');
    form.append(apply);
    form.onsubmit = (e) => {
      e.preventDefault();
      if (!this.closed && o.valid() && form.checkValidity())
        o.resize(rows.valueAsNumber, cols.valueAsNumber);
    };
    this.root.append(title, grid, form);
    this.root.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        this.o.dismiss(true);
      }
    };
    this.place(this.root, o.point.x, o.point.y);
    rows.focus();
    rows.select();
  }
  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.clearChild();
    this.root.remove();
    this.doc.removeEventListener('pointerdown', this.outside, true);
    this.win.removeEventListener('resize', this.resizeWindow);
  }
}
