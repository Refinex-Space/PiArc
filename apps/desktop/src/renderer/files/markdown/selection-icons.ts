// Original line icons for the three groups of the Markdown Studio selection toolbar.
const shapes = {
  h1: 'M3 5v14m9-14v14M3 12h9m5-2 3-2v11',
  h2: 'M2 5v14m8-14v14m-8-7h8m4-2c1-4 7-4 7 0 0 3-6 5-7 9h8',
  h3: 'M2 5v14m8-14v14m-8-7h8m4-4c2-3 7-2 7 1 0 2-2 3-4 3 2 0 4 1 4 3 0 4-5 5-7 2',
  bold: 'M6 4h7a4 4 0 0 1 0 8H6zM6 12h8a4 4 0 0 1 0 8H6z',
  italic: 'M10 4h9M5 20h9M15 4 9 20',
  strike: 'M16 6c-1-2-7-2-8 0s0 4 4 5M4 12h16M8 17c2 3 8 3 9 0s-1-4-4-5',
  inlineCode: 'm8 7-5 5 5 5m8-10 5 5-5 5',
  inlineMath: 'M4 19h4l3-14h4m-9 6h8m1 1 5 7m0-7-5 7',
  link: 'M10 14a4 4 0 0 0 5 0l3-3a4 4 0 0 0-5-5l-2 2m3 2a4 4 0 0 0-5 0l-3 3a4 4 0 0 0 5 5l2-2',
  bullet: 'M3 6h1m-1 6h1m-1 6h1M9 6h12M9 12h12M9 18h12',
  ordered: 'M2 5l2-1v5M2 12c1-2 4-2 4 0 0 2-4 3-4 5h4M10 6h11M10 12h11M10 18h11',
  task: 'm2 6 2 2 4-5m-6 12 2 2 4-5M11 7h10M11 16h10',
  quote: 'M3 5h3v14H3zM10 7h10m-10 5h10m-10 5h7',
} as const;
export type SelectionAction = keyof typeof shapes;
export function selectionIcon(doc: Document, action: SelectionAction) {
  const ns = 'http://www.w3.org/2000/svg',
    icon = doc.createElementNS(ns, 'svg'),
    glyph = doc.createElementNS(ns, 'path');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  glyph.setAttribute('d', shapes[action]);
  icon.append(glyph);
  return icon;
}
