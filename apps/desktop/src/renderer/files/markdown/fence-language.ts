// Adapted selection behavior from Markdown Studio's livePreview/codeBlocks.ts
// (e6ebd0c, Apache-2.0). The control changes only the language token of the opening fence.
import { isolateHistory } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { EditorState, Range } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { Decoration, ViewPlugin, WidgetType, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { hostOf } from './widget-host.js';

const valid = /^[a-z0-9][a-z\d_+#.-]{0,47}$/iu;
const options = [
  ...new Set([
    'javascript',
    'typescript',
    'python',
    'rust',
    'go',
    'shell',
    'json',
    'yaml',
    'html',
    'css',
    'sql',
    'mermaid',
    'math',
    ...languages.flatMap((l) =>
      [l.name, ...l.alias].map((n) => n.toLowerCase()).filter((n) => valid.test(n)),
    ),
  ]),
];
function languageToken(state: EditorState, node: SyntaxNode) {
  const start = node.getChild('CodeMark')?.to;
  if (start === undefined) return null;
  const end = state.doc.lineAt(start).to;
  const info = state.sliceDoc(start, end);
  const space = info.length - info.trimStart().length;
  const lang = /^[a-z0-9][a-z\d_+#.-]*(?=\s|\{|$)/iu.exec(info.slice(space))?.[0] ?? '';
  return {
    from: start + space,
    to: start + space + lang.length,
    lang,
    suffix: !lang && info.trim().length > 0,
  };
}
export function setFenceLanguage(view: EditorView, at: number, language: string) {
  if (view.state.readOnly || view.composing || (language && !valid.test(language))) return false;
  let n: SyntaxNode | null = syntaxTree(view.state).resolveInner(at, -1);
  while (n && n.name !== 'FencedCode') n = n.parent;
  if (!n) return false;
  const token = languageToken(view.state, n);
  if (!token || token.lang === language) return false;
  view.dispatch({
    changes: {
      from: token.from,
      to: token.to,
      insert: language + (language && token.suffix ? ' ' : ''),
    },
    annotations: isolateHistory.of('full'),
    userEvent: 'input.language',
  });
  return true;
}
class LanguageChoice extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }
  override eq(other: LanguageChoice) {
    return this.lang === other.lang;
  }
  toDOM(view: EditorView) {
    const doc = view.dom.ownerDocument,
      select = doc.createElement('select'),
      t = hostOf(view.state).t;
    select.className = 'md-fence-lang';
    const label = t('md.edit.fenceLanguage');
    select.setAttribute('aria-label', label);
    select.title = label;
    const add = (value: string, name: string) => {
      const opt = doc.createElement('option');
      opt.value = value;
      opt.textContent = name;
      select.append(opt);
    };
    add('', t('md.edit.plainText'));
    if (this.lang) add(this.lang, this.lang);
    select.value = this.lang;
    let populated = false;
    const populate = () => {
      if (populated) return;
      populated = true;
      for (const lang of options) if (lang !== this.lang) add(lang, lang);
    };
    select.addEventListener('focus', populate);
    select.addEventListener('pointerdown', populate);
    select.onchange = () => {
      const pos = view.posAtDOM(select);
      if (setFenceLanguage(view, pos, select.value)) view.focus();
    };
    return select;
  }
}
export const fenceLanguages = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view: EditorView) {
      this.decorations = this.collect(view);
    }
    collect(view: EditorView) {
      if (view.state.readOnly) return Decoration.none;
      const out: Range<Decoration>[] = [];
      for (const range of view.visibleRanges)
        syntaxTree(view.state).iterate({
          from: range.from,
          to: range.to,
          enter(ref) {
            if (ref.name !== 'FencedCode') return;
            const pos = view.state.doc.lineAt(ref.from).to;
            if (pos >= range.from && pos <= range.to) {
              const token = languageToken(view.state, ref.node);
              if (token)
                out.push(
                  Decoration.widget({ side: 1, widget: new LanguageChoice(token.lang) }).range(pos),
                );
            }
            return false;
          },
        });
      return Decoration.set(out, true);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.startState.readOnly !== u.state.readOnly ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      )
        this.decorations = this.collect(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
