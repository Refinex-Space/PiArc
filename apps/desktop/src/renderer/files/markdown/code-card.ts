// The live card (Markdown Studio e6ebd0c, Apache-2.0) keeps every editable line in
// CodeMirror. Only its boundaries become widgets; all events use the owning document.
import { StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, type EditorView, WidgetType } from '@codemirror/view';
import { fenceAt, shapeOf, type CodeCardShape } from './code-card-model.js';
import { languageField } from './fence-language.js';
import { hostOf } from './widget-host.js';

export const focusCard = StateEffect.define<number | null>();
export const focusedCard = StateField.define<number | null>({
  create: () => null,
  update(current, tr) {
    for (const e of tr.effects) if (e.is(focusCard)) return e.value;
    return current === null || tr.selection ? null : tr.changes.mapPos(current);
  },
});
class Top extends WidgetType {
  override eq() {
    return true;
  }
  toDOM(view: EditorView) {
    const top = view.dom.ownerDocument.createElement('div');
    top.className = 'md-code-top';
    top.setAttribute('aria-hidden', 'true');
    return top;
  }
  override ignoreEvent() {
    return false;
  }
}
function copyIcon(doc: Document, complete: boolean) {
  const ns = 'http://www.w3.org/2000/svg',
    svg = doc.createElementNS(ns, 'svg'),
    path = doc.createElementNS(ns, 'path');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  path.setAttribute(
    'd',
    complete
      ? 'm4 12 5 5L20 6'
      : 'M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3M5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z',
  );
  svg.append(path);
  return svg;
}
class Footer extends WidgetType {
  constructor(
    readonly language: string,
    readonly editable: boolean,
  ) {
    super();
  }
  override eq(other: Footer) {
    return this.language === other.language && this.editable === other.editable;
  }
  toDOM(view: EditorView) {
    const doc = view.dom.ownerDocument,
      win = doc.defaultView,
      foot = doc.createElement('div'),
      copy = doc.createElement('button'),
      status = doc.createElement('span');
    const t = hostOf(view.state).t;
    foot.className = 'md-code-footer';
    status.className = 'md-code-feedback';
    status.setAttribute('role', 'status');
    if (this.editable) foot.append(languageField(view, this.language, foot));
    else {
      const name = doc.createElement('span');
      name.className = 'md-code-label';
      name.textContent = this.language || t('md.edit.plainText');
      foot.append(name);
    }
    foot.addEventListener('focusin', () => {
      const at = view.posAtDOM(foot);
      if (view.state.field(focusedCard) !== at) view.dispatch({ effects: focusCard.of(at) });
    });
    foot.addEventListener('focusout', (e) => {
      if (!foot.contains(e.relatedTarget as Node | null))
        queueMicrotask(() => {
          if (view.dom.contains(foot) && view.state.field(focusedCard) === view.posAtDOM(foot))
            view.dispatch({ effects: focusCard.of(null) });
        });
    });
    const feedback = (done: boolean) => {
      const label = t(done ? 'transcript.copied' : 'md.selection.copyCode');
      copy.replaceChildren(copyIcon(doc, done));
      copy.dataset.done = String(done);
      copy.setAttribute('aria-label', label);
      copy.title = label;
      delete status.dataset.error;
      status.textContent = done ? label : '';
    };
    feedback(false);
    copy.type = 'button';
    copy.className = 'md-code-copy';
    copy.onmousedown = (e) => {
      e.preventDefault();
    };
    let reset: number | undefined,
      attempt = 0;
    copy.onclick = () => {
      const n = fenceAt(view.state, view.posAtDOM(foot));
      const shape = n && shapeOf(view.state, n);
      if (!shape || !win) return;
      const current = ++attempt;
      win.clearTimeout(reset);
      feedback(false);
      const text = view.state.sliceDoc(shape.open.to + 1, shape.close.from - 1);
      void (async () => {
        try {
          await win.navigator.clipboard.writeText(text);
          if (current !== attempt || !view.dom.contains(copy)) return;
          feedback(true);
          reset = win.setTimeout(() => {
            feedback(false);
          }, 1400);
        } catch (e) {
          if (current === attempt && view.dom.contains(copy)) {
            status.dataset.error = 'true';
            status.textContent = t('files.viewer.copyError', { reason: String(e) });
          }
        }
      })();
    };
    foot.append(copy, status);
    cleanups.set(foot, () => win?.clearTimeout(reset));
    return foot;
  }
  override destroy(dom: HTMLElement) {
    cleanups.get(dom)?.();
    cleanups.delete(dom);
  }
}
const cleanups = new WeakMap<HTMLElement, () => void>();
const atomic = Decoration.mark({});
export function decorateCodeCard(
  shape: CodeCardShape,
  readOnly: boolean,
  length: number,
  out: Range<Decoration>[],
  fences: Range<Decoration>[],
) {
  const { open, close } = shape;
  out.push(
    Decoration.replace({ widget: new Top(), block: true }).range(open.from, open.to),
    Decoration.replace({
      widget: new Footer(shape.language, !shape.math && !readOnly),
      block: true,
    }).range(close.from, close.to),
  );
  fences.push(
    atomic.range(Math.max(0, open.from - 1), open.to + 1),
    atomic.range(close.from - 1, Math.min(length, close.to + 1)),
  );
}
