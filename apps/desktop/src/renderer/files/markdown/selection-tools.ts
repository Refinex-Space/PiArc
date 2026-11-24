// Adapted from Markdown Studio's livePreview/toolbar.ts (e6ebd0c, Apache-2.0).
// Keep the original document selection while a pointer or keyboard operates the toolbar.
import { syntaxTree } from '@codemirror/language';
import { Prec, StateEffect, StateField, EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, showTooltip } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { applyFormat } from './formatting.js';
import { hostOf } from './widget-host.js';
const shapes = {
  bold: 'M6 4h7a4 4 0 0 1 0 8H6zM6 12h8a4 4 0 0 1 0 8H6z',
  italic: 'M10 4h9M5 20h9M15 4 9 20',
  strike: 'M16 6c-1-2-7-2-8 0s0 4 4 5M5 12h14M8 17c2 3 8 3 9 0s-1-4-4-5',
  inlineCode: 'm8 7-5 5 5 5m8-10 5 5-5 5',
  link: 'M10 14a4 4 0 0 0 5 0l3-3a4 4 0 0 0-5-5l-2 2m3 2a4 4 0 0 0-5 0l-3 3a4 4 0 0 0 5 5l2-2',
  quote: 'M4 5h16M8 10h12M8 15h10M4 9v10',
} as const;
const commands = ['bold', 'italic', 'strike', 'inlineCode', 'link', 'quote'] as const;
const skip = new Set(['FencedCode', 'CodeBlock', 'FrontMatter', 'BlockMath', 'Table', 'HTMLBlock']);
const selectDrag = StateEffect.define<boolean>(),
  dismiss = StateEffect.define();
const toolbarState = StateField.define<{ drag: boolean; hidden: boolean }>({
  create: () => ({ drag: false, hidden: false }),
  update(value, tr) {
    let drag = value.drag,
      hidden = tr.selection || tr.docChanged ? false : value.hidden;
    for (const e of tr.effects) {
      if (e.is(selectDrag)) drag = e.value;
      if (e.is(dismiss)) hidden = true;
    }
    return value.drag === drag && value.hidden === hidden ? value : { drag, hidden };
  },
});
export function mayFormatSelection(state: EditorState) {
  const r = state.selection.main;
  if (state.readOnly || r.empty || state.selection.ranges.length !== 1 || r.to - r.from > 4096)
    return false;
  for (const [pos, bias] of [
    [r.from, 1],
    [r.to, -1],
  ] as const)
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, bias); n; n = n.parent)
      if (skip.has(n.name)) return false;
  return true;
}
function toolbar(view: EditorView) {
  const doc = view.dom.ownerDocument,
    dom = doc.createElement('div'),
    t = hostOf(view.state).t;
  dom.className = 'md-selection-tools';
  dom.setAttribute('role', 'toolbar');
  dom.setAttribute('aria-label', t('md.edit.selectionTools'));
  for (const command of commands) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.dataset.command = command;
    button.setAttribute(
      'aria-label',
      t('md.edit.selectionAction', { action: t(`md.edit.${command}`) }),
    );
    button.title = t(`md.edit.${command}`);
    const ns = 'http://www.w3.org/2000/svg',
      icon = doc.createElementNS(ns, 'svg'),
      glyph = doc.createElementNS(ns, 'path');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    glyph.setAttribute('d', shapes[command]);
    icon.append(glyph);
    button.append(icon);
    button.onmousedown = (e) => {
      e.preventDefault();
    };
    button.onclick = () => {
      applyFormat(view, command, (n) => t('md.edit.column', { n }));
    };
    dom.append(button);
  }
  dom.onkeydown = (e) => {
    const buttons = Array.from(dom.querySelectorAll('button')),
      index = buttons.indexOf(e.target as HTMLButtonElement);
    if (index < 0) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      view.focus();
      view.dispatch({ effects: dismiss.of(null) });
      return;
    }
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? buttons.length - 1
          : e.key === 'ArrowRight'
            ? index + 1
            : e.key === 'ArrowLeft'
              ? index - 1
              : undefined;
    if (next !== undefined) {
      e.preventDefault();
      e.stopPropagation();
      buttons[(next + buttons.length) % buttons.length]?.focus();
    }
  };
  return { dom, offset: { x: 0, y: 5 } };
}
const dragging = ViewPlugin.fromClass(
  class {
    private end: (() => void) | null = null;
    private readonly down: (e: PointerEvent) => void;
    constructor(private readonly view: EditorView) {
      this.down = (e) => {
        if (e.button !== 0 || this.end) return;
        const owner = view.dom.ownerDocument;
        const up = () => {
          this.clear();
          view.dispatch({ effects: selectDrag.of(false) });
        };
        this.end = () => {
          owner.removeEventListener('pointerup', up, true);
          owner.removeEventListener('pointercancel', up, true);
        };
        owner.addEventListener('pointerup', up, true);
        owner.addEventListener('pointercancel', up, true);
        view.dispatch({ effects: selectDrag.of(true) });
      };
      view.contentDOM.addEventListener('pointerdown', this.down);
    }
    clear() {
      this.end?.();
      this.end = null;
    }
    destroy() {
      this.clear();
      this.view.contentDOM.removeEventListener('pointerdown', this.down);
    }
  },
);
export const selectionTools = [
  toolbarState,
  dragging,
  showTooltip.compute([toolbarState, 'selection', 'doc', EditorState.readOnly], (state) => {
    const s = state.field(toolbarState),
      r = state.selection.main;
    return !s.drag && !s.hidden && mayFormatSelection(state)
      ? { pos: r.from, end: r.to, above: true, create: toolbar }
      : null;
  }),
  Prec.high(
    keymap.of([
      {
        key: 'Alt-F10',
        run: (v) => {
          const button = v.dom.querySelector<HTMLButtonElement>('.md-selection-tools button');
          if (!button) return false;
          button.focus();
          return true;
        },
      },
    ]),
  ),
  EditorView.domEventHandlers({
    blur: (e, v) => {
      const target = e.relatedTarget as Element | null;
      if (typeof target?.closest === 'function' && target.closest('.md-selection-tools'))
        return false;
      if (!v.state.selection.main.empty) v.dispatch({ effects: dismiss.of(null) });
      return false;
    },
  }),
];
