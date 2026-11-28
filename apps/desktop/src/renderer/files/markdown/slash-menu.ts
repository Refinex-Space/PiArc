// Adapted from Markdown Studio e6ebd0c (Apache-2.0). The query and keyboard focus
// belong to one editor, including when the files tile has its own Electron window.
import { isImeComposing } from '../../composer/ime-guard.js';
import type { SyntaxNode } from '@lezer/common';
import { syntaxTree } from '@codemirror/language';
import {
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Transaction,
} from '@codemirror/state';
import { EditorView, showTooltip } from '@codemirror/view';
import { applyFormat } from './formatting.js';
import { insertImages } from './image-import.js';
import { slashGroups, type Entry, type Item } from './slash-catalog.js';
import { slashPopup } from './slash-popup.js';
import { hostOf } from './widget-host.js';

const skip = new Set([
  'FencedCode',
  'CodeBlock',
  'InlineCode',
  'Table',
  'FrontMatter',
  'HTMLBlock',
  'BlockMath',
  'InlineMath',
]);
export function permitsSlash(state: EditorState, pos: number) {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent)
    if (skip.has(n.name)) return false;
  return true;
}

let sequence = 0;
interface Slash {
  from: number;
  query: string;
  id: string;
  active: number;
  /** The current child index, or null when navigating the root list. */
  child: number | null;
  paused: boolean;
}
const close = StateEffect.define();
const select = StateEffect.define<Pick<Slash, 'active' | 'child'>>();
const pause = StateEffect.define<boolean>();
function nextMenu(old: Slash | null, tr: Transaction): Slash | null {
  const state = tr.state,
    r = state.selection.main;
  if (
    state.readOnly ||
    !r.empty ||
    state.selection.ranges.length !== 1 ||
    tr.effects.some((e) => e.is(close))
  )
    return null;
  const line = state.doc.lineAt(r.head);
  if (!old) {
    if (!tr.docChanged || !tr.isUserEvent('input.type') || tr.isUserEvent('input.type.compose'))
      return null;
    const from = r.head - 1;
    if (from < line.from || !['/', '、'].includes(state.sliceDoc(from, r.head))) return null;
    const inserted: number[] = [];
    tr.changes.iterChanges((_a, _b, start, end) => {
      if (start === from && end === r.head) inserted.push(start);
    });
    const before = state.sliceDoc(line.from, from);
    if (
      !inserted.length ||
      (before && !/\s$/u.test(before)) ||
      /^ {4,}$/u.test(before) ||
      !permitsSlash(state, r.head)
    )
      return null;
    return {
      from,
      query: '',
      active: 0,
      child: null,
      id: 'md-slash-' + String(++sequence),
      paused: false,
    };
  }
  const from = tr.changes.mapPos(old.from, 1);
  if (from < line.from || from >= r.head || !['/', '、'].includes(state.sliceDoc(from, from + 1)))
    return null;
  const query = state.sliceDoc(from + 1, r.head);
  if (query.length > 24 || /[/、\\]|^\s|\s{2}/u.test(query)) return null;
  let { active, child, paused } = old;
  for (const e of tr.effects) {
    if (e.is(select)) ({ active, child } = e.value);
    if (e.is(pause)) paused = e.value;
  }
  if (query !== old.query) {
    active = 0;
    child = null;
  }
  if (
    from === old.from &&
    query === old.query &&
    active === old.active &&
    child === old.child &&
    paused === old.paused
  )
    return old;
  return { ...old, from, query, active, child, paused };
}
export const slashState = StateField.define<Slash | null>({ create: () => null, update: nextMenu });
export function runSlashItem(view: EditorView, id: Item, range?: { from: number; to: number }) {
  if (view.composing || view.state.readOnly) return false;
  if (id === 'image') {
    view.dispatch({ effects: close.of(null) });
    void insertImages(view, undefined, range);
    return true;
  }
  return applyFormat(view, id, (n) => hostOf(view.state).t('md.edit.column', { n }), range);
}
function accept(view: EditorView, item: Entry, index: number) {
  const s = view.state.field(slashState);
  if (!s || s.paused || view.composing) return false;
  if ('folderId' in item) {
    move(view, index, 0);
    return true;
  }
  return runSlashItem(view, item.id, { from: s.from, to: view.state.selection.main.head });
}
function move(view: EditorView, active: number, child: number | null) {
  const s = view.state.field(slashState);
  if (s && (s.active !== active || s.child !== child))
    view.dispatch({ effects: select.of({ active, child }) });
}
const popup = (view: EditorView) =>
  slashPopup(view, () => view.state.field(slashState), move, accept);
export const slashMenu = [
  slashState,
  showTooltip.compute([slashState], (state) => {
    const s = state.field(slashState);
    return s && !s.paused && slashGroups(state, s.query).length
      ? { pos: s.from, create: popup }
      : null;
  }),
  EditorView.contentAttributes.compute([slashState], (state) => {
    const s = state.field(slashState);
    const attrs: Record<string, string> = {};
    if (s && !s.paused && slashGroups(state, s.query).length) {
      attrs['aria-autocomplete'] = 'list';
      attrs['aria-controls'] = s.id + (s.child === null ? '' : '-child');
      attrs['aria-activedescendant'] = attrs['aria-controls'] + '-' + String(s.child ?? s.active);
    }
    return attrs;
  }),
  Prec.highest(
    EditorView.domEventHandlers({
      keydown(event, view) {
        const s = view.state.field(slashState);
        if (
          !s ||
          s.paused ||
          isImeComposing(event, view.composing) ||
          event.metaKey ||
          event.altKey ||
          event.shiftKey
        )
          return false;
        const vim = event.ctrlKey && ['n', 'p'].includes(event.key);
        if (event.ctrlKey && !vim) return false;
        const items = slashGroups(view.state, s.query).flatMap((g) => g.items);
        const selected = items[s.active];
        const children = selected && 'folderId' in selected ? selected.children : null;
        const open = s.child !== null && children;
        if (event.key === 'Escape' || (open && event.key === 'ArrowLeft')) {
          if (open) move(view, s.active, null);
          else view.dispatch({ effects: close.of(null) });
        } else if (!selected) return false;
        else if (vim || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const n = open ? open.length : items.length;
          const idx =
            ((s.child ?? s.active) + (['ArrowDown', 'n'].includes(event.key) ? 1 : -1) + n) % n;
          move(view, open ? s.active : idx, open ? idx : null);
        } else if (event.key === 'ArrowRight' && children && !open) move(view, s.active, 0);
        else if (event.key === 'Enter' || event.key === 'Tab') {
          const item = open ? open[s.child ?? 0] : selected;
          if (!item || !accept(view, item, s.active)) return false;
        } else return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
      },
      blur: (_e, v) => {
        if (v.state.field(slashState)) v.dispatch({ effects: close.of(null) });
        return false;
      },
      compositionstart: (_e, v) => {
        if (v.state.field(slashState)) v.dispatch({ effects: pause.of(true) });
        return false;
      },
      compositionend: (_e, v) => {
        if (v.state.field(slashState)) v.dispatch({ effects: pause.of(false) });
        return false;
      },
    }),
  ),
];
