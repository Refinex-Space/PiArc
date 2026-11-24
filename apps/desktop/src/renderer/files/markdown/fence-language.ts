// Adapted from Markdown Studio livePreview/codeBlocks.ts (e6ebd0c, Apache-2.0).
import { isolateHistory } from '@codemirror/commands';
import { languages } from '@codemirror/language-data';
import type { EditorView } from '@codemirror/view';
import { fenceAt, languageSlot, shapeOf, validLanguage } from './code-card-model.js';
import { hostOf } from './widget-host.js';

const choices = [
  ...new Set([
    'javascript',
    'typescript',
    'python',
    'java',
    'rust',
    'go',
    'bash',
    'shell',
    'json',
    'yaml',
    'html',
    'css',
    'sql',
    'mermaid',
    'math',
    ...languages.flatMap((language) =>
      [language.name, ...language.alias]
        .map((name) => name.toLowerCase())
        .filter((name) => validLanguage.test(name)),
    ),
  ]),
];
let nextListId = 0;

export function languageSuggestions(value: string): string[] {
  const q = value.trim().toLowerCase();
  return [
    ...choices.filter((name) => name.startsWith(q)),
    ...choices.filter((name) => !name.startsWith(q) && name.includes(q)),
  ].slice(0, 8);
}

export function languageField(view: EditorView, original: string, foot: HTMLElement): HTMLElement {
  const doc = foot.ownerDocument,
    wrap = doc.createElement('span'),
    input = doc.createElement('input'),
    list = doc.createElement('div');
  const t = hostOf(view.state).t;
  const label = t('md.edit.fenceLanguage');
  wrap.className = 'md-code-language';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.enterKeyHint = 'done';
  input.maxLength = 64;
  input.value = original;
  input.placeholder = t('md.edit.plainText');
  input.setAttribute('aria-label', label);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', label);
  list.id = 'md-code-languages-' + String(++nextListId);
  list.className = 'md-code-languages';
  input.setAttribute('aria-controls', list.id);
  wrap.append(input, list);
  let items: string[] = [],
    active = -1,
    composing = false,
    finished = false;
  const size = () => {
    input.size = Math.max(3, Math.min(20, (input.value || input.placeholder).length + 1));
  };
  size();
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  close();
  const choose = (focusEditor: boolean, cancel = false) => {
    if (finished || composing) return;
    finished = true;
    close();
    if (!view.dom.contains(foot)) return;
    const node = fenceAt(view.state, view.posAtDOM(foot));
    const shape = node && shapeOf(view.state, node),
      slot = node && languageSlot(view.state, node);
    if (!shape || !slot) return;
    const value = cancel ? slot.lang : input.value.trim();
    const change =
      !view.state.readOnly && value !== slot.lang && (!value || validLanguage.test(value));
    const insert = value + (value && slot.separate ? ' ' : '');
    const changes = view.state.changes(change ? { from: slot.from, to: slot.to, insert } : []);
    input.value = change ? value : slot.lang;
    size();
    if (change || focusEditor)
      view.dispatch({
        changes,
        ...(focusEditor
          ? { selection: { anchor: changes.mapPos(shape.close.from - 1) }, scrollIntoView: true }
          : {}),
        ...(change ? { annotations: isolateHistory.of('full'), userEvent: 'input.language' } : {}),
      });
    if (focusEditor) view.focus();
  };
  const show = () => {
    list.replaceChildren(
      ...items.map((name, i) => {
        const option = doc.createElement('div');
        option.id = list.id + '-' + String(i);
        option.textContent = name;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(i === active));
        option.onmousedown = (event) => {
          event.preventDefault();
        };
        option.onclick = () => {
          input.value = name;
          choose(true);
        };
        return option;
      }),
    );
    const id = list.children[active]?.id;
    if (id) input.setAttribute('aria-activedescendant', id);
    else input.removeAttribute('aria-activedescendant');
    list.hidden = !items.length;
    input.setAttribute('aria-expanded', String(!!items.length));
    if (items.length) {
      const bounds = view.scrollDOM.getBoundingClientRect(),
        at = input.getBoundingClientRect();
      list.dataset.above = String(
        bounds.bottom - at.bottom < list.offsetHeight + 4 &&
          at.top - bounds.top > bounds.bottom - at.bottom,
      );
    }
  };
  const refresh = (typing: boolean) => {
    size();
    items = languageSuggestions(input.value);
    active = typing && items.length ? 0 : -1;
    show();
  };
  input.onfocus = () => {
    finished = false;
    input.select();
    refresh(false);
  };
  input.oninput = () => {
    if (!composing) refresh(true);
  };
  input.addEventListener('compositionstart', () => {
    composing = true;
    close();
  });
  input.addEventListener('compositionend', () => {
    composing = false;
    refresh(true);
  });
  input.onblur = () => {
    choose(false);
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (composing || e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      active =
        active < 0
          ? step > 0
            ? 0
            : items.length - 1
          : (active + step + items.length) % items.length;
      show();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const selected = items[active];
      if (selected) input.value = selected;
      choose(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      choose(true, true);
    }
  };
  return wrap;
}
