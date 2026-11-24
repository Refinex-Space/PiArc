// Find bar for the Markdown editor. Replace stays closed until the leading chevron opens it,
// and every action is an icon with a tooltip instead of a text button.
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  selectMatches,
  setSearchQuery,
} from '@codemirror/search';
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view';

type Shape =
  | { kind: 'path'; d: string }
  | { kind: 'circle'; cx: string; cy: string; r: string }
  | { kind: 'rect'; x: string; y: string; width: string; height: string; rx?: string };

function glyph(shapes: readonly Shape[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const shape of shapes) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', shape.kind);
    if (shape.kind === 'path') node.setAttribute('d', shape.d);
    else if (shape.kind === 'circle') {
      node.setAttribute('cx', shape.cx);
      node.setAttribute('cy', shape.cy);
      node.setAttribute('r', shape.r);
    } else {
      node.setAttribute('x', shape.x);
      node.setAttribute('y', shape.y);
      node.setAttribute('width', shape.width);
      node.setAttribute('height', shape.height);
      if (shape.rx) node.setAttribute('rx', shape.rx);
    }
    svg.append(node);
  }
  return svg;
}

const icons = {
  chevron: [path('m6 9 6 6 6-6')],
  caseSensitive: [
    path('m2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16'),
    path('M3.304 13h6.392'),
    path('M22 9v7'),
    circle('18.5', '12.5', '3.5'),
  ],
  wholeWord: [
    circle('7', '12', '3'),
    path('M10 9v6'),
    circle('17', '12', '3'),
    path('M14 7v8'),
    path('M22 17v1c0 .5-.5 1-1 1H3c-.5 0-1-.5-1-1v-1'),
  ],
  regex: [
    path('M17 3v10'),
    path('m12.67 5.5 8.66 5'),
    path('m12.67 10.5 8.66-5'),
    path('M9 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2z'),
  ],
  up: [path('m5 12 7-7 7 7'), path('M12 19V5')],
  down: [path('M12 5v14'), path('m19 12-7 7-7-7')],
  replace: [
    path('M14 4a1 1 0 0 1 1-1'),
    path('M15 10a1 1 0 0 1-1-1'),
    path('M21 4a1 1 0 0 0-1-1'),
    path('M21 9a1 1 0 0 1-1 1'),
    path('m3 7 3 3 3-3'),
    path('M6 10V5a2 2 0 0 1 2-2h2'),
    rect('3', '14', '7', '7', '1'),
  ],
  replaceAll: [
    path('M14 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1'),
    path('M14 4a1 1 0 0 1 1-1'),
    path('M15 10a1 1 0 0 1-1-1'),
    path('M19 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1'),
    path('M21 4a1 1 0 0 0-1-1'),
    path('M21 9a1 1 0 0 1-1 1'),
    path('m3 7 3 3 3-3'),
    path('M6 10V5a2 2 0 0 1 2-2h2'),
    rect('3', '14', '7', '7', '1'),
  ],
  close: [path('M18 6 6 18'), path('M6 6l12 12')],
} satisfies Record<string, readonly Shape[]>;

function path(d: string): Shape {
  return { kind: 'path', d };
}
function circle(cx: string, cy: string, r: string): Shape {
  return { kind: 'circle', cx, cy, r };
}
function rect(x: string, y: string, width: string, height: string, rx: string): Shape {
  return { kind: 'rect', x, y, width, height, rx };
}

function field(view: EditorView, name: string, placeholder: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cm-textfield';
  input.name = name;
  input.placeholder = placeholder;
  input.setAttribute('aria-label', placeholder);
  input.autocomplete = 'off';
  input.spellcheck = false;
  return input;
}

function iconButton(label: string, icon: readonly Shape[], name: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'md-find-icon';
  button.name = name;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(glyph(icon));
  return button;
}

/** VS Code style find bar: replace is a second row opened from the leading chevron. */
export function createMarkdownSearchPanel(view: EditorView): Panel {
  const say = (text: string) => view.state.phrase(text);
  const readOnly = view.state.readOnly;
  let query = getSearchQuery(view.state);
  let replaceOpen = query.replace.length > 0 && !readOnly;

  const searchField = field(view, 'search', say('Find'));
  searchField.value = query.search;
  searchField.setAttribute('main-field', 'true');
  const replaceField = field(view, 'replace', say('Replace'));
  replaceField.value = query.replace;

  const toggle = iconButton(say('show replace'), icons.chevron, 'toggle-replace');
  toggle.classList.add('md-find-toggle');
  toggle.setAttribute('aria-expanded', String(replaceOpen));
  if (readOnly) toggle.hidden = true;

  const caseButton = iconButton(say('match case'), icons.caseSensitive, 'case');
  const wordButton = iconButton(say('by word'), icons.wholeWord, 'word');
  const reButton = iconButton(say('regexp'), icons.regex, 're');
  const previous = iconButton(say('previous'), icons.up, 'prev');
  const next = iconButton(say('next'), icons.down, 'next');
  const select = iconButton(say('all'), icons.wholeWord, 'select');
  // Select-all uses a dedicated mark so it is not confused with whole-word.
  select.replaceChildren(
    glyph([
      path('M8 6h13'),
      path('M8 12h13'),
      path('M8 18h13'),
      path('M3 6h.01'),
      path('M3 12h.01'),
      path('M3 18h.01'),
    ]),
  );
  const close = iconButton(say('close'), icons.close, 'close');
  const replace = iconButton(say('replace'), icons.replace, 'replace');
  const replaceEvery = iconButton(say('replace all'), icons.replaceAll, 'replaceAll');

  const pressed = (button: HTMLButtonElement, on: boolean) => {
    button.setAttribute('aria-pressed', String(on));
  };
  pressed(caseButton, query.caseSensitive);
  pressed(wordButton, query.wholeWord);
  pressed(reButton, query.regexp);

  const findRow = document.createElement('div');
  findRow.className = 'md-find-row';
  findRow.append(
    toggle,
    searchField,
    caseButton,
    wordButton,
    reButton,
    previous,
    next,
    select,
    close,
  );

  const replaceRow = document.createElement('div');
  replaceRow.className = 'md-find-row md-find-replace';
  replaceRow.append(replaceField, replace, replaceEvery);
  replaceRow.hidden = !replaceOpen;

  const dom = document.createElement('div');
  dom.className = 'cm-search md-find';
  dom.append(findRow);
  if (!readOnly) dom.append(replaceRow);

  const commit = () => {
    const nextQuery = new SearchQuery({
      search: searchField.value,
      caseSensitive: caseButton.getAttribute('aria-pressed') === 'true',
      regexp: reButton.getAttribute('aria-pressed') === 'true',
      wholeWord: wordButton.getAttribute('aria-pressed') === 'true',
      replace: replaceField.value,
    });
    if (!nextQuery.eq(query)) {
      query = nextQuery;
      view.dispatch({ effects: setSearchQuery.of(nextQuery) });
    }
  };
  const flip = (button: HTMLButtonElement) => {
    pressed(button, button.getAttribute('aria-pressed') !== 'true');
    commit();
  };

  searchField.addEventListener('input', commit);
  replaceField.addEventListener('input', commit);
  caseButton.addEventListener('click', () => {
    flip(caseButton);
  });
  wordButton.addEventListener('click', () => {
    flip(wordButton);
  });
  reButton.addEventListener('click', () => {
    flip(reButton);
  });
  previous.addEventListener('click', () => {
    findPrevious(view);
  });
  next.addEventListener('click', () => {
    findNext(view);
  });
  select.addEventListener('click', () => {
    selectMatches(view);
  });
  close.addEventListener('click', () => {
    closeSearchPanel(view);
  });
  replace.addEventListener('click', () => {
    replaceNext(view);
  });
  replaceEvery.addEventListener('click', () => {
    replaceAll(view);
  });
  toggle.addEventListener('click', () => {
    replaceOpen = !replaceOpen;
    replaceRow.hidden = !replaceOpen;
    toggle.setAttribute('aria-expanded', String(replaceOpen));
    toggle.title = say(replaceOpen ? 'hide replace' : 'show replace');
    toggle.setAttribute('aria-label', toggle.title);
    if (replaceOpen) replaceField.focus();
    else searchField.focus();
  });

  dom.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSearchPanel(view);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (event.target === replaceField) replaceNext(view);
    else if (event.shiftKey) findPrevious(view);
    else findNext(view);
  });

  return {
    dom,
    top: true,
    mount() {
      searchField.select();
    },
    update(update: ViewUpdate) {
      for (const transaction of update.transactions) {
        for (const effect of transaction.effects) {
          if (effect.is(setSearchQuery) && !effect.value.eq(query)) {
            query = effect.value;
            searchField.value = query.search;
            replaceField.value = query.replace;
            pressed(caseButton, query.caseSensitive);
            pressed(wordButton, query.wholeWord);
            pressed(reButton, query.regexp);
          }
        }
      }
    },
  };
}
