import { Decoration, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  highlightWhitespace,
  keymap,
  lineNumbers,
  scrollPastEnd,
} from '@codemirror/view';
import type { AppContextValue } from '../../app/app-context.js';
import type { ViewerSettings } from '../viewer-model.js';
import { applyFormat } from './formatting.js';
import { liveMode } from './live-preview.js';

const guides = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    build(view: EditorView) {
      const deco = Decoration.mark({ class: 'md-indent-guide' });
      const marks = [];
      for (const r of view.visibleRanges) {
        for (
          let i = view.state.doc.lineAt(r.from).number, last = view.state.doc.lineAt(r.to).number;
          i <= last;
          i++
        ) {
          const line = view.state.doc.line(i),
            len = /^[ \t]+/u.exec(line.text)?.[0].length ?? 0;
          if (len) marks.push(deco.range(line.from, line.from + len));
        }
      }
      return Decoration.set(marks, true);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
  },
  { decorations: (p) => p.decorations },
);
export function editSettings(
  mode: 'source' | 'live',
  settings: ViewerSettings,
  editable: boolean,
  t: AppContextValue['t'],
): Extension {
  const live = mode === 'live';
  const commands = [...historyKeymap, ...defaultKeymap];
  const fmt = (format: 'bold' | 'italic') => (v: EditorView) =>
    applyFormat(v, format, (n) => t('md.edit.column', { n }));
  return [
    liveMode.of(live),
    ...(!live && settings.indentGuides
      ? [guides, EditorView.theme({ '&': { '--md-tab-width': String(settings.tabSize) + 'ch' } })]
      : []),
    EditorView.editorAttributes.of({ class: live ? 'md-live' : 'md-source' }),
    EditorState.readOnly.of(!editable),
    EditorView.editable.of(editable),
    EditorView.contentAttributes.of({
      'aria-label': t(live ? 'md.edit.liveAria' : 'md.edit.sourceAria'),
      'aria-readonly': String(!editable),
      tabindex: '0',
      'data-testid': 'markdown-editor-input',
      spellcheck: 'false',
      autocapitalize: 'off',
      autocorrect: 'off',
    }),
    EditorState.tabSize.of(settings.tabSize),
    indentUnit.of(' '.repeat(settings.tabSize)),
    live || settings.wordWrap ? EditorView.lineWrapping : [],
    live ? [] : lineNumbers(),
    settings.showWhitespace ? highlightWhitespace() : [],
    settings.scrollPastEnd ? scrollPastEnd() : [],
    keymap.of([
      { key: 'Mod-b', run: fmt('bold') },
      { key: 'Mod-i', run: fmt('italic') },
      ...(settings.tabIndents && editable ? [indentWithTab] : []),
      ...commands,
    ]),
    EditorState.phrases.of({
      Find: t('md.edit.find'),
      Replace: t('md.edit.replace'),
      'show replace': t('md.edit.showReplace'),
      'hide replace': t('md.edit.hideReplace'),
      next: t('md.edit.next'),
      previous: t('md.edit.previous'),
      all: t('md.edit.all'),
      'match case': t('files.viewer.matchCase'),
      regexp: t('files.viewer.regexp'),
      'by word': t('files.viewer.wholeWord'),
      replace: t('md.edit.replace'),
      'replace all': t('md.edit.replaceAll'),
      close: t('md.edit.close'),
      'current match': t('md.edit.currentMatch'),
      'on line': t('md.edit.onLine'),
    }),
  ];
}
