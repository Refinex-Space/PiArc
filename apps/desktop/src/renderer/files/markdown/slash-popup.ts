// Menu appearance and grouped navigation adapted from Markdown Studio's SlashMenu,
// e6ebd0c, Apache-2.0. Keep focus in CodeMirror while the pointer traverses either panel.
import type { EditorView, Rect, TooltipView } from '@codemirror/view';
import { slashGroups, type Entry } from './slash-catalog.js';
import { hostOf } from './widget-host.js';

const paths: Record<string, string> = {
  '¶': 'M18 4H9a4 4 0 1 0 0 8h2M11 4v16m4-16v16',
  '☷': 'M9 6h11M9 12h11M9 18h11M4 6h1m-1 6h1m-1 6h1',
  '1.': 'M10 6h10M10 12h10M10 18h10M4 4h1v5M3 9h4m-4 5c3-3 6 0 3 2l-3 3h4',
  '☑': 'M4 4h16v16H4z M7 12l3 3 7-7',
  '❝': 'M5 7h5v6H5zm0 6c0 3 1 4 3 4m5-10h5v6h-5zm0 6c0 3 1 4 3 4',
  '▦': 'M3 5h18v14H3z M3 10h18m-12 0v9m6-9v9',
  '‹›': 'm8 6-6 6 6 6m8-12 6 6-6 6',
  ƒ: 'M17 5c-4-3-6-1-7 4l-2 9c-.5 2-2 3-5 2m4-10h9',
  '!': 'M12 3 2 20h20L12 3zm0 6v5m0 2v1',
  '◇': 'M3 3h6v5H3zm12 12h6v5h-6zM6 8v9h9m-4-12h6v6',
  '―': 'M3 12h18',
  '↗': 'M10 7 7 10a4 4 0 0 0 6 6l3-3m-2-5 1-1a4 4 0 1 1 5 6l-2 2M9 15l6-6',
  '▧': 'M3 4h18v16H3zm1 12 5-6 4 5 3-3 5 6M15 8h1',
  '≡': 'M4 4h16v16H4zm4 5h8m-8 5h6',
};
function drawIcon(el: HTMLElement, glyph: string) {
  const d = paths[glyph];
  if (!d) {
    el.dataset.glyph = glyph;
    return;
  }
  const ns = 'http://www.w3.org/2000/svg';
  const svg = el.ownerDocument.createElementNS(ns, 'svg'),
    path = el.ownerDocument.createElementNS(ns, 'path');
  svg.setAttribute('viewBox', '0 0 24 24');
  path.setAttribute('d', d);
  svg.append(path);
  el.append(svg);
}

interface MenuState {
  query: string;
  id: string;
  active: number;
  child: number | null;
}
export function slashPopup(
  view: EditorView,
  state: () => MenuState | null,
  move: (v: EditorView, index: number, child: number | null) => void,
  accept: (v: EditorView, item: Entry, index: number) => boolean,
): TooltipView {
  const doc = view.dom.ownerDocument,
    t = hostOf(view.state).t;
  const dom = doc.createElement('div');
  dom.className = 'md-slash-popup';
  const root = doc.createElement('div');
  root.className = 'md-slash-list';
  root.setAttribute('role', 'listbox');
  root.setAttribute('aria-label', t('md.edit.slashMenu'));
  dom.append(root);
  let child: HTMLElement | null = null;
  let previous: MenuState | null = null;
  let rows: HTMLElement[] = [];
  let items: Entry[] = [];
  let buttons: HTMLElement[] = [];
  let host: HTMLElement | undefined;
  let space: Rect | null = null;
  dom.onmousedown = (e) => {
    e.preventDefault();
  };
  function row(item: Entry, index: number, nested: boolean, s: MenuState) {
    const el = doc.createElement('div');
    el.className = 'md-slash-option';
    el.setAttribute('role', 'option');
    el.id = (nested ? s.id + '-child' : s.id) + '-' + String(index);
    const label = t(item.label);
    el.setAttribute('aria-label', label);
    const icon = doc.createElement('span');
    icon.className = 'md-slash-icon';
    drawIcon(icon, item.icon);
    icon.setAttribute('aria-hidden', 'true');
    const title = doc.createElement('span');
    title.className = 'md-slash-label';
    title.textContent = label;
    const hint = doc.createElement('span');
    hint.className = 'md-slash-hint';
    hint.setAttribute('aria-hidden', 'true');
    if ('folderId' in item) {
      el.dataset.folder = item.folderId;
      el.setAttribute('aria-haspopup', 'listbox');
      hint.dataset.hint = '›';
    } else {
      el.dataset.command = item.id;
      hint.dataset.hint = nested && item.folder === 'diagram' ? '' : item.hint;
    }
    el.append(icon, title, hint);
    el.onpointermove = () => {
      const owner = state();
      if (owner)
        move(
          view,
          nested ? owner.active : index,
          nested
            ? index
            : 'folderId' in item
              ? owner.active === index
                ? (owner.child ?? 0)
                : 0
              : null,
        );
    };
    el.onclick = () => {
      const owner = state();
      if (owner) accept(view, item, nested ? owner.active : index);
    };
    return el;
  }
  function position() {
    if (!host || !child || !space) return;
    const b = dom.getBoundingClientRect(),
      a = host.getBoundingClientRect();
    const width = Math.min(236, b.width),
      gap = 4,
      margin = 4;
    const direction =
      space.right - b.right >= width + gap + margin
        ? 'right'
        : b.left - space.left >= width + gap + margin
          ? 'left'
          : 'inside';
    dom.dataset.cascade = direction;
    if (direction === 'inside') {
      child.style.top = '0px';
      child.style.left = '0px';
      child.style.width = '100%';
      return;
    }
    child.style.width = String(width) + 'px';
    child.style.left = String(direction === 'right' ? b.width + gap : -width - gap) + 'px';
    const top = Math.max(
      space.top + margin,
      Math.min(a.top - 4, space.bottom - margin - child.offsetHeight),
    );
    child.style.top = String(top - b.top) + 'px';
  }
  function reveal(list: HTMLElement, el: HTMLElement | undefined) {
    if (!el) return;
    const a = el.getBoundingClientRect(),
      b = list.getBoundingClientRect();
    if (a.top < b.top) list.scrollTop -= b.top - a.top;
    else if (a.bottom > b.bottom) list.scrollTop += a.bottom - b.bottom;
  }
  function render() {
    const s = state();
    if (!s || s === previous) return;
    if (previous?.id !== s.id || previous.query !== s.query) {
      items = [];
      rows = [];
      root.id = s.id;
      root.replaceChildren();
      root.scrollTop = 0;
      for (const g of slashGroups(view.state, s.query)) {
        const group = doc.createElement('div');
        group.setAttribute('role', 'group');
        if (g.section) {
          const label = t(`md.slash.${g.section}`);
          const heading = doc.createElement('div');
          heading.className = 'md-slash-group';
          heading.textContent = label;
          group.setAttribute('aria-label', label);
          group.append(heading);
        }
        for (const item of g.items) {
          const el = row(item, items.length, false, s);
          rows.push(el);
          items.push(item);
          group.append(el);
        }
        root.append(group);
      }
    }
    const selected = items[s.active];
    rows.forEach((el, i) => {
      el.setAttribute('aria-selected', String(i === s.active));
      if (el.hasAttribute('aria-haspopup'))
        el.setAttribute('aria-expanded', String(i === s.active && s.child !== null));
    });
    if (previous?.active !== s.active || previous.query !== s.query) reveal(root, rows[s.active]);
    if (s.child !== null && selected && 'folderId' in selected) {
      if (!child || host !== rows[s.active]) {
        child?.remove();
        child = doc.createElement('div');
        child.setAttribute('role', 'listbox');
        child.id = s.id + '-child';
        child.className = 'md-slash-list md-slash-child';
        child.setAttribute('aria-label', t(selected.label));
        const back = doc.createElement('button');
        back.className = 'md-slash-back';
        back.type = 'button';
        back.tabIndex = -1;
        back.textContent = '‹ ' + t('md.slash.back');
        back.onclick = () => {
          move(view, s.active, null);
        };
        buttons = selected.children.map((item, i) => row(item, i, true, s));
        child.append(back, ...buttons);
        dom.append(child);
        host = rows[s.active];
        position();
      }
      buttons.forEach((el, i) => {
        el.setAttribute('aria-selected', String(i === s.child));
      });
      reveal(child, buttons[s.child]);
    } else {
      child?.remove();
      child = null;
      host = undefined;
      delete dom.dataset.cascade;
    }
    previous = s;
  }
  root.onscroll = () => {
    position();
  };
  render();
  return {
    dom,
    offset: { x: 0, y: 6 },
    update: render,
    positioned(next) {
      space = next;
      position();
    },
  };
}
