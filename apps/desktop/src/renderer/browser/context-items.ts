// The numbered items the preview panel hands to the composer (B3.5): an element card's page
// data, an annotation's markers and boxes, a screenshot. Numbers follow the cards' and markers'
// order and match what the images show.
import type { BrowserElementContext, BrowserPick } from '../../shared/browser.js';
import type { BrowserContextItem } from '../composer/browser-context.js';

/** `path:line:column`, or just the path. */
export function sourceText(context: BrowserElementContext): string | undefined {
  const source = context.source;
  if (source === undefined) return undefined;
  const line = source.line === undefined ? '' : `:${String(source.line)}`;
  const column =
    source.line === undefined || source.column === undefined ? '' : `:${String(source.column)}`;
  return `${source.path}${line}${column}`;
}

/** What an element card is called: `<button> "Save"`, or its selector. */
export function elementTitle(context: BrowserElementContext): string {
  const name = context.name !== '' ? context.name : context.text;
  return name === '' ? `<${context.tag}>` : `<${context.tag}> "${name}"`;
}

/** An element card as a context item. */
export function elementItem(n: number, pick: BrowserPick, comment: string): BrowserContextItem {
  const context = pick.context;
  const data: [string, string][] = [
    ['selector', context.selector],
    ['xpath', context.xpath],
  ];
  if (context.role !== '') data.push(['role', context.role]);
  if (context.components.length > 0) {
    data.push(['components (innermost first)', context.components.join(', ')]);
  }
  const source = sourceText(context);
  if (source !== undefined) data.push(['source', source]);
  if (context.text !== '') data.push(['text', context.text]);
  const attributes = Object.entries(context.attributes);
  if (attributes.length > 0) {
    data.push(['attributes', attributes.map(([name, value]) => `${name}="${value}"`).join(' ')]);
  }
  const styles = Object.entries(context.styles);
  if (styles.length > 0) {
    data.push(['styles', styles.map(([name, value]) => `${name}: ${value}`).join('; ')]);
  }
  const box = context.box;
  data.push([
    'box',
    `x ${String(box.x)}, y ${String(box.y)}, ${String(box.width)} × ${String(box.height)} (CSS px)`,
  ]);
  if (context.html !== '') data.push(['html', context.html]);
  return { n, kind: 'element', title: elementTitle(context), data, comment };
}

/** The image name of a card or an annotation (`element-1.png`). */
export function imageName(kind: string, n: number, extension = 'png'): string {
  return `${kind}-${String(n)}.${extension}`;
}
