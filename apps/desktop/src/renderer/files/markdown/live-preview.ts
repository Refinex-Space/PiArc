// Viewport decorations follow the reveal-on-selection approach of Markdown Studio's
// web/core/features/viewers/markdown/livePreview/inline.ts and blocks.ts (e6ebd0c,
// Apache-2.0). PiArc provides its own view, widget lifetime and bounded viewport pass.
import { syntaxTree } from '@codemirror/language';
import { Facet, StateEffect, StateField, type EditorState, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { RichWidget, type WidgetContent, hostOf } from './widget-host.js';
import { TableWidget, tableArrowKeys } from './live-table.js';
import { parseTable } from './table-model.js';

export const liveMode = Facet.define<boolean, boolean>({ combine: (values) => values[0] ?? false });
const focus = StateEffect.define<boolean>();
const focused = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => tr.effects.find((e) => e.is(focus))?.value ?? v,
});
const visible = StateEffect.define<{ from: number; to: number }>();
const viewport = StateField.define<{ from: number; to: number }>({
  create: (state) => ({ from: 0, to: Math.min(6000, state.doc.length) }),
  update: (range, tr) => {
    for (const e of tr.effects) if (e.is(visible)) return e.value;
    return { from: tr.changes.mapPos(range.from, -1), to: tr.changes.mapPos(range.to, 1) };
  },
});
function touches(state: EditorState, from: number, to: number, strict = false) {
  return (
    state.field(focused) &&
    state.selection.ranges.some((r) =>
      strict ? r.from > from && r.to < to : r.from <= to && r.to >= from,
    )
  );
}
class Marker extends WidgetType {
  constructor(
    readonly style: 'bullet' | 'rule' | 'task',
    readonly checked = false,
  ) {
    super();
  }
  override eq(other: Marker) {
    return this.style === other.style && this.checked === other.checked;
  }
  toDOM(view: EditorView) {
    const doc = view.dom.ownerDocument;
    if (this.style === 'task') {
      const el = doc.createElement('input');
      el.type = 'checkbox';
      el.className = 'md-task';
      el.checked = this.checked;
      el.disabled = view.state.readOnly;
      el.setAttribute('aria-label', hostOf(view.state).t('md.edit.task'));
      el.onmousedown = (e) => {
        e.preventDefault();
      };
      el.onchange = () => {
        const pos = view.posAtDOM(el),
          mark = view.state.sliceDoc(pos, pos + 3);
        if (/^\[[ xX]\]$/u.test(mark) && !view.state.readOnly)
          view.dispatch({
            changes: { from: pos + 1, to: pos + 2, insert: el.checked ? 'x' : ' ' },
            userEvent: 'input.task',
          });
      };
      return el;
    }
    const el = doc.createElement('span');
    el.className = 'md-' + this.style;
    el.setAttribute('aria-hidden', 'true');
    if (this.style === 'bullet') el.textContent = '•';
    return el;
  }
}
type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';
class CalloutTitle extends WidgetType {
  constructor(
    readonly kind: CalloutKind,
    readonly title: string,
  ) {
    super();
  }
  override eq(other: CalloutTitle) {
    return this.kind === other.kind && this.title === other.title;
  }
  toDOM(view: EditorView) {
    const label = view.dom.ownerDocument.createElement('strong');
    label.className = 'md-callout-title';
    label.textContent = this.title || hostOf(view.state).t(`files.md.callout.${this.kind}`);
    return label;
  }
}
const hide = Decoration.replace({});
function inlineDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  if (!state.facet(liveMode)) return Decoration.none;
  const out: Range<Decoration>[] = [],
    lines = new Map<number, Set<string>>();
  const line = (pos: number, cls: string) => {
    const at = state.doc.lineAt(pos).from;
    const names = lines.get(at) ?? new Set<string>();
    names.add(cls);
    lines.set(at, names);
  };
  const mark = (from: number, to: number, cls: string, attrs?: Record<string, string>) => {
    if (from < to)
      out.push(
        Decoration.mark({ class: cls, ...(attrs ? { attributes: attrs } : {}) }).range(from, to),
      );
  };
  const replace = (from: number, to: number, widget?: WidgetType) => {
    if (from < to && state.doc.lineAt(from).to >= to)
      out.push((widget ? Decoration.replace({ widget }) : hide).range(from, to));
  };
  for (const r of view.visibleRanges) {
    syntaxTree(state).iterate({
      from: r.from,
      to: r.to,
      enter(ref) {
        const { name, from, to } = ref,
          n = ref.node;
        const active = touches(state, from, to);
        const lineSelected = () =>
          touches(state, state.doc.lineAt(from).from, state.doc.lineAt(to).to);
        if (/^ATXHeading|^SetextHeading/u.test(name)) {
          const depth = name.slice(-1);
          line(from, 'md-heading');
          line(from, 'md-h' + depth);
          if (!lineSelected())
            for (const delimiter of n.getChildren('HeaderMark')) {
              const end = state.doc.lineAt(delimiter.to).to;
              let right = delimiter.to;
              while (right < end && state.sliceDoc(right, right + 1) === ' ') right++;
              replace(delimiter.from, right);
            }
          return;
        }
        if (
          [
            'StrongEmphasis',
            'Emphasis',
            'Strikethrough',
            'InlineCode',
            'Highlight',
            'Subscript',
            'Superscript',
            'Underline',
          ].includes(name)
        ) {
          mark(from, to, 'md-' + name);
          if (!active)
            for (let c = n.firstChild; c; c = c.nextSibling)
              if (c.name.endsWith('Mark')) replace(c.from, c.to);
          return;
        }
        if (name === 'InlineMath' && !active) {
          replace(
            from,
            to,
            new RichWidget({
              kind: 'math',
              inline: true,
              source: state.sliceDoc(from + 1, to - 1),
            }),
          );
          return false;
        }
        if (name === 'Escape' && !active) {
          replace(from, from + 1);
          return false;
        }
        if (name === 'ListMark' && n.parent?.parent?.name === 'BulletList') {
          if (n.parent.getChild('Task')) {
            if (!lineSelected()) replace(from, to + 1);
          } else if (!lineSelected()) replace(from, to, new Marker('bullet'));
        } else if (name === 'TaskMarker') {
          if (!active) replace(from, to, new Marker('task', /x/iu.test(state.sliceDoc(from, to))));
        } else if (
          name === 'Blockquote' ||
          name === 'FencedCode' ||
          name === 'CodeBlock' ||
          name === 'FrontMatter'
        ) {
          const firstLine = state.doc.lineAt(from);
          const callout =
            name === 'Blockquote' && n.parent?.name === 'Document'
              ? /^( {0,3}>[ \t]*)\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+(.*))?$/iu.exec(
                  firstLine.text,
                )
              : null;
          const kind = callout?.[2]?.toLowerCase() as CalloutKind | undefined;
          if (kind && callout && !touches(state, firstLine.from, firstLine.to)) {
            replace(
              firstLine.from + (callout[1]?.length ?? 0),
              firstLine.to,
              new CalloutTitle(kind, callout[3]?.trim() ?? ''),
            );
          }
          const start = state.doc.lineAt(Math.max(from, r.from)).number,
            end = state.doc.lineAt(Math.min(to, r.to)).number;
          for (let i = start; i <= end; i++)
            line(
              state.doc.line(i).from,
              kind
                ? 'md-callout md-callout-' + kind
                : name === 'Blockquote'
                  ? 'md-quote'
                  : name === 'FrontMatter'
                    ? 'md-frontmatter'
                    : 'md-code-block',
            );
        } else if (name === 'QuoteMark' && !lineSelected()) {
          replace(
            from,
            to + (state.sliceDoc(to, Math.min(to + 1, state.doc.length)) === ' ' ? 1 : 0),
          );
        } else if (name === 'HorizontalRule' && !lineSelected()) {
          replace(from, to, new Marker('rule'));
          return false;
        } else if (name === 'Image' || name === 'Link') {
          const marks = n.getChildren('LinkMark'),
            first = marks[0],
            second = marks[1],
            url = n.getChild('URL');
          if (!first || !second || !url) return;
          const href = state.sliceDoc(url.from, url.to);
          if (name === 'Image') {
            if (!active)
              replace(
                from,
                to,
                new RichWidget({
                  kind: 'image',
                  inline: true,
                  source: href,
                  alt: state.sliceDoc(first.to, second.from),
                }),
              );
            return false;
          }
          mark(first.to, second.from, 'md-live-link', { title: href, 'data-href': href });
          if (!active) {
            replace(from, first.to);
            replace(second.from, to);
          }
          return;
        }
        return undefined;
      },
    });
  }
  for (const [from, classes] of lines)
    out.push(Decoration.line({ class: [...classes].join(' ') }).range(from));
  return Decoration.set(out, true);
}
function blockWidgets(state: EditorState): DecorationSet {
  if (!state.facet(liveMode)) return Decoration.none;
  const range = state.field(viewport);
  const out: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    from: range.from,
    to: range.to,
    enter(ref) {
      const n = ref.node;
      if (ref.name === 'Table') {
        if (ref.to - ref.from < 65536 && !touches(state, ref.from, ref.to, true)) {
          const source = state.sliceDoc(ref.from, ref.to),
            model = parseTable(source, 0);
          if (model && model.columns <= 32 && model.rows.length < 128)
            out.push(
              Decoration.replace({
                widget: new TableWidget(source, state.readOnly),
                block: true,
              }).range(ref.from, ref.to),
            );
        }
        return false;
      }
      if (ref.name === 'FencedCode' || ref.name === 'BlockMath') {
        if (ref.to - ref.from > 65536) return false;
        const child = (name: string, node: SyntaxNode = n) => {
          const c = node.getChild(name);
          return c ? state.sliceDoc(c.from, c.to) : '';
        };
        const lang = child('CodeInfo').trim().toLowerCase();
        let content: WidgetContent | undefined;
        if (ref.name === 'BlockMath') {
          const src = state.sliceDoc(ref.from, ref.to);
          if (src.endsWith('$$') && src.length > 4)
            content = { kind: 'math', source: src.slice(2, -2).trim(), inline: false };
        } else if (lang === 'mermaid' || ['latex', 'tex', 'math', 'katex'].includes(lang)) {
          if (n.getChildren('CodeMark').length >= 2)
            content = {
              kind: lang === 'mermaid' ? 'mermaid' : 'math',
              source: child('CodeText'),
              inline: false,
            };
        }
        if (content) {
          const widget = new RichWidget(content);
          const editing = touches(state, ref.from, ref.to);
          out.push(
            editing
              ? Decoration.widget({ widget, block: true, side: 1 }).range(ref.to)
              : Decoration.replace({ widget, block: true }).range(ref.from, ref.to),
          );
        }
        return false;
      }
      return !['Paragraph', 'FrontMatter', 'HTMLBlock'].includes(ref.name);
    },
  });
  return Decoration.set(out, true);
}
const blocks = StateField.define<DecorationSet>({
  create: (state) => blockWidgets(state),
  update: (deco, tr) =>
    tr.docChanged ||
    tr.selection ||
    tr.reconfigured ||
    tr.effects.some((e) => e.is(visible) || e.is(focus)) ||
    syntaxTree(tr.startState) !== syntaxTree(tr.state)
      ? blockWidgets(tr.state)
      : deco,
  provide: (field) => EditorView.decorations.from(field),
});
const liveViewport = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private frame = 0;
    private readonly window: Window | null;
    constructor(view: EditorView) {
      this.window = view.dom.ownerDocument.defaultView;
      this.decorations = inlineDecorations(view);
      this.measure(view);
    }
    measure(view: EditorView) {
      const win = view.dom.ownerDocument.defaultView;
      if (!win || this.frame || !view.state.facet(liveMode)) return;
      this.frame = win.requestAnimationFrame(() => {
        this.frame = 0;
        const next = view.viewport,
          old = view.state.field(viewport);
        if (next.from !== old.from || next.to !== old.to)
          view.dispatch({ effects: visible.of(next) });
      });
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        u.focusChanged ||
        u.startState.facet(liveMode) !== u.state.facet(liveMode) ||
        syntaxTree(u.startState) !== syntaxTree(u.state) ||
        u.startState.field(focused) !== u.state.field(focused)
      )
        this.decorations = inlineDecorations(u.view);
      if (u.viewportChanged || u.startState.facet(liveMode) !== u.state.facet(liveMode))
        this.measure(u.view);
    }
    destroy() {
      this.window?.cancelAnimationFrame(this.frame);
    }
  },
  { decorations: (v) => v.decorations },
);
export const liveExtensions = [
  tableArrowKeys,
  focused,
  viewport,
  blocks,
  liveViewport,
  EditorView.focusChangeEffect.of((_state, f) => focus.of(f)),
];
