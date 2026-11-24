// Adapted from Markdown Studio's livePreview/slash.ts (e6ebd0c, Apache-2.0).
// Track a user-typed line-leading slash in one editor. Paste, restore and IME composition
// cannot start it, and an ordinary path continues through CodeMirror's default key handling.
import { isImeComposing } from '../../composer/ime-guard.js';
import { syntaxTree } from '@codemirror/language';
import {
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Transaction,
} from '@codemirror/state';
import { EditorView, showTooltip, type TooltipView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { applyFormat, type FormatCommand } from './formatting.js';
import { insertImages, imagePort } from './image-import.js';
import { hostOf } from './widget-host.js';

type Item = FormatCommand | 'image';
const catalog: readonly Item[] = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'paragraph',
  'bullet',
  'ordered',
  'task',
  'quote',
  'table',
  'fence',
  'formula',
  'diagram',
  'rule',
  'image',
  'link',
  'bold',
  'italic',
  'strike',
  'inlineCode',
];
const aliases: Partial<Record<Item, string>> = {
  bullet: 'unordered list',
  ordered: 'numbered list',
  quote: 'blockquote',
  task: 'checkbox checklist',
  fence: 'code block',
  formula: 'math latex',
  diagram: 'mermaid',
  rule: 'divider horizontal',
  image: 'insert picture',
  strike: 'strikethrough',
};
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
  active: number;
  id: string;
  paused: boolean;
}
const close = StateEffect.define(),
  select = StateEffect.define<number>(),
  pause = StateEffect.define<boolean>();
function label(state: EditorState, id: Item) {
  return hostOf(state).t(id === 'image' ? 'md.edit.insertImage' : `md.edit.${id}`);
}
function choices(state: EditorState, query: string) {
  const find = query.toLowerCase().trim();
  return catalog.filter((k) => {
    if (k === 'image' && !state.facet(imagePort)[0]?.().chooseImage) return false;
    if (!find) return true;
    return [
      k,
      ...(aliases[k] ?? '').split(' '),
      /^h\d$/u.test(k) ? 'heading ' + k.slice(1) : '',
      label(state, k),
    ].some((text) => text.toLowerCase().includes(find));
  });
}
function nextMenu(old: Slash | null, tr: Transaction): Slash | null {
  if (
    !old &&
    (!tr.docChanged || !tr.isUserEvent('input.type') || tr.isUserEvent('input.type.compose'))
  )
    return null;
  const { state } = tr,
    r = state.selection.main,
    line = state.doc.lineAt(r.head);
  if (
    state.readOnly ||
    !r.empty ||
    state.selection.ranges.length !== 1 ||
    r.head !== line.to ||
    tr.effects.some((e) => e.is(close))
  )
    return null;
  const match = /^( {0,3})\/([\p{L}\p{N}_ -]{0,48})$/u.exec(line.text);
  if (!match) return null;
  const from = line.from + (match[1]?.length ?? 0),
    query = match[2] ?? '';
  if (!old) {
    if (query || !permitsSlash(state, from + 1)) return null;
    return { from, query, active: 0, id: 'md-slash-' + String(++sequence), paused: false };
  }
  if (tr.changes.mapPos(old.from, 1) !== from || !permitsSlash(state, from + 1)) return null;
  let { active, paused } = old;
  for (const effect of tr.effects) {
    if (effect.is(select)) active = effect.value;
    else if (effect.is(pause)) paused = effect.value;
  }
  if (query !== old.query) active = 0;
  return old.from === from && old.query === query && old.active === active && old.paused === paused
    ? old
    : { ...old, from, query, active, paused };
}
export const slashState = StateField.define<Slash | null>({ create: () => null, update: nextMenu });
function accept(view: EditorView, id: Item) {
  const s = view.state.field(slashState);
  if (!s || s.paused || view.composing) return false;
  const range = { from: s.from, to: view.state.selection.main.head };
  if (id === 'image') {
    view.dispatch({ effects: close.of(null) });
    void insertImages(view, undefined, range);
    return true;
  }
  return applyFormat(view, id, (n) => hostOf(view.state).t('md.edit.column', { n }), range);
}
function popup(view: EditorView): TooltipView {
  const dom = view.dom.ownerDocument.createElement('div');
  dom.className = 'md-slash-list';
  dom.setAttribute('role', 'listbox');
  dom.setAttribute('aria-label', hostOf(view.state).t('md.edit.slashMenu'));
  dom.onmousedown = (e) => {
    e.preventDefault();
  };
  let oldQuery: string | undefined;
  function render() {
    const s = view.state.field(slashState);
    if (!s) return;
    dom.id = s.id;
    if (oldQuery !== s.query) {
      oldQuery = s.query;
      dom.replaceChildren();
      for (const [i, item] of choices(view.state, s.query).entries()) {
        const row = dom.ownerDocument.createElement('div');
        row.setAttribute('role', 'option');
        row.id = s.id + '-' + String(i);
        row.textContent = label(view.state, item);
        row.dataset.command = item;
        row.onpointermove = () => {
          if (view.state.field(slashState)?.active !== i) view.dispatch({ effects: select.of(i) });
        };
        row.onclick = () => {
          accept(view, item);
        };
        dom.append(row);
      }
    }
    for (const [i, row] of [...dom.children].entries())
      row.setAttribute('aria-selected', String(i === s.active));
    const current = dom.children[s.active] as HTMLElement | undefined;
    if (current) {
      const y = current.offsetTop;
      if (y < dom.scrollTop) dom.scrollTop = y;
      else if (y + current.offsetHeight > dom.scrollTop + dom.clientHeight)
        dom.scrollTop = y + current.offsetHeight - dom.clientHeight;
    }
  }
  render();
  return {
    dom,
    offset: { x: 0, y: 4 },
    update: (u) => {
      if (u.startState.field(slashState) !== u.state.field(slashState)) render();
    },
  };
}
export const slashMenu = [
  slashState,
  showTooltip.compute([slashState], (state) => {
    const s = state.field(slashState);
    return s && !s.paused && choices(state, s.query).length ? { pos: s.from, create: popup } : null;
  }),
  EditorView.contentAttributes.compute([slashState], (state) => {
    const s = state.field(slashState);
    const attrs: Record<string, string> = {};
    if (s && !s.paused && choices(state, s.query).length) {
      attrs['aria-autocomplete'] = 'list';
      attrs['aria-controls'] = s.id;
      attrs['aria-activedescendant'] = s.id + '-' + String(s.active);
    }
    return attrs;
  }),
  Prec.highest(
    EditorView.domEventHandlers({
      keydown: (event, v) => {
        const s = v.state.field(slashState);
        if (
          !s ||
          s.paused ||
          isImeComposing(event, v.composing) ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey
        )
          return false;
        if (event.key === 'Escape') {
          v.dispatch({ effects: close.of(null) });
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
        const items = choices(v.state, s.query);
        if (!items.length) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          v.dispatch({
            effects: select.of(
              (s.active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length,
            ),
          });
          event.preventDefault();
          return true;
        }
        const item = items[s.active];
        if (item && !event.shiftKey && (event.key === 'Enter' || event.key === 'Tab')) {
          event.preventDefault();
          event.stopPropagation();
          return accept(v, item);
        }
        return false;
      },
      blur: (_event, v) => {
        if (v.state.field(slashState)) v.dispatch({ effects: close.of(null) });
        return false;
      },
      compositionstart: (_event, v) => {
        if (v.state.field(slashState)) v.dispatch({ effects: pause.of(true) });
        return false;
      },
      compositionend: (_event, v) => {
        if (v.state.field(slashState)) v.dispatch({ effects: pause.of(false) });
        return false;
      },
    }),
  ),
];
