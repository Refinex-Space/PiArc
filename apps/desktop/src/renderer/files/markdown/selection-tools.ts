// Adapted from Markdown Studio's livePreview/toolbar.ts (e6ebd0c, Apache-2.0).
// Keep the original document selection while a pointer or keyboard operates the toolbar.
import { syntaxTree } from '@codemirror/language';
import { Prec, StateEffect, StateField, EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, showTooltip } from '@codemirror/view';
import { selectionIcon, type SelectionAction } from './selection-icons.js';
import { applyFormat, formatActive } from './formatting.js';
import { hostOf } from './widget-host.js';
const groups: readonly (readonly SelectionAction[])[] = [
  ['h1', 'h2', 'h3'],
  ['bold', 'italic', 'strike', 'inlineCode', 'inlineMath', 'link'],
  ['bullet', 'ordered', 'task', 'quote'],
];
export const selectionBindings = {
  bold: 'Mod-b',
  italic: 'Mod-i',
  underline: 'Mod-u',
  strike: 'Mod-Shift-x',
  link: 'Mod-Alt-k',
} as const;
export function commandShortcut(view: EditorView, command: string) {
  if (!Object.hasOwn(selectionBindings, command)) return '';
  const mac = /Mac|iPhone|iPad/u.test(view.dom.ownerDocument.defaultView?.navigator.platform ?? '');
  return selectionBindings[command as keyof typeof selectionBindings]
    .replace('Mod-', mac ? '⌘' : 'Ctrl+')
    .replace('Shift-', mac ? '⇧' : 'Shift+')
    .replace('Alt-', mac ? '⌥' : 'Alt+')
    .replace(/[a-z]$/u, (c) => c.toUpperCase());
}
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
  let allowed = true;
  syntaxTree(state).iterate({
    from: r.from,
    to: r.to,
    enter(node) {
      if (skip.has(node.name) && node.from < r.to && node.to > r.from) {
        allowed = false;
        return false;
      }
      return allowed;
    },
  });
  return allowed;
}
function toolbar(view: EditorView) {
  const doc = view.dom.ownerDocument,
    dom = doc.createElement('div'),
    t = hostOf(view.state).t;
  dom.className = 'md-selection-tools';
  dom.setAttribute('role', 'toolbar');
  dom.setAttribute('aria-label', t('md.edit.selectionTools'));
  const buttons = new Map<SelectionAction, HTMLButtonElement>();
  for (const [index, actions] of groups.entries()) {
    if (index > 0) {
      const separator = doc.createElement('span');
      separator.setAttribute('role', 'separator');
      separator.setAttribute('aria-orientation', 'vertical');
      dom.append(separator);
    }
    for (const command of actions) {
      const button = doc.createElement('button'),
        label = t(`md.edit.${command}`),
        shortcut = commandShortcut(view, command);
      button.type = 'button';
      button.tabIndex = -1;
      button.dataset.command = command;
      button.title = shortcut ? label + ' (' + shortcut + ')' : label;
      button.setAttribute('aria-label', t('md.edit.selectionAction', { action: label }));
      button.append(selectionIcon(doc, command));
      buttons.set(command, button);
      button.onmousedown = (e) => {
        e.preventDefault();
      };
      button.onclick = () => {
        applyFormat(view, command, (n) => t('md.edit.column', { n }));
      };
      dom.append(button);
    }
  }
  const update = () => {
    for (const [action, button] of buttons)
      button.setAttribute('aria-pressed', String(formatActive(view.state, action)));
  };
  update();
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
  // CodeMirror clamps and flips within the owning editor, including split panes and detached windows.
  const offset = { x: 0, y: 6 };
  return {
    dom,
    offset,
    update,
    getCoords: () => {
      const r = view.state.selection.main,
        first = view.coordsAtPos(r.from),
        last = view.coordsAtPos(r.to),
        viewport = view.scrollDOM.getBoundingClientRect();
      const a = first ?? last,
        b = last ?? first;
      if (!a || !b)
        return {
          left: viewport.left,
          right: viewport.left,
          top: viewport.top - 1,
          bottom: viewport.top - 1,
        };
      const width = dom.getBoundingClientRect().width;
      offset.x = -width / 2;
      const x = Math.max(viewport.left, Math.min(viewport.right, (a.left + b.right) / 2));
      return {
        left: x,
        right: x,
        top: Math.max(a.top, viewport.top),
        bottom: Math.min(b.bottom, viewport.bottom),
      };
    },
  };
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
const toolbarStyle = EditorView.baseTheme({
  '.cm-tooltip.md-selection-tools': {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '2px',
    padding: '3px',
    boxSizing: 'border-box',
    border: '1px solid var(--piarc-border-subtle)',
    borderRadius: 'var(--piarc-radius-button)',
    background: 'var(--piarc-surface-raised)',
    color: 'var(--piarc-text-secondary)',
    boxShadow: 'var(--piarc-shadow-overlay)',
    fontFamily: 'var(--piarc-font-ui)',
    maxWidth: '100%',
  },
  '.md-selection-tools button': {
    display: 'inline-grid',
    placeItems: 'center',
    width: '26px',
    height: '26px',
    padding: '0',
    border: '0',
    borderRadius: 'var(--piarc-radius-sm)',
    color: 'inherit',
    background: 'transparent',
    cursor: 'pointer',
  },
  '.md-selection-tools button:hover,.md-selection-tools button:focus-visible': {
    color: 'var(--piarc-text-primary)',
    background: 'var(--piarc-surface-hover)',
  },
  '.md-selection-tools button[aria-pressed=true]': {
    color: 'var(--piarc-text-primary)',
    background: 'var(--piarc-surface-active)',
  },
  '.md-selection-tools [role=separator]': {
    width: '1px',
    height: '16px',
    margin: '0 3px',
    background: 'var(--piarc-border-subtle)',
  },
  '.md-selection-tools svg': {
    width: '16px',
    height: '16px',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.8',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  },
});
export const selectionTools = [
  toolbarStyle,
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
      ...Object.entries(selectionBindings).map(([command, key]) => ({
        key,
        run: (v: EditorView) =>
          applyFormat(v, command as keyof typeof selectionBindings, (n) =>
            hostOf(v.state).t('md.edit.column', { n }),
          ),
      })),
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
