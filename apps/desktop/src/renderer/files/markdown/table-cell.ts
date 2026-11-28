import { markdownLanguage } from '@codemirror/lang-markdown';
import type { SyntaxNode } from '@lezer/common';
const styles: Readonly<Record<string, string>> = {
  StrongEmphasis: 'md-StrongEmphasis',
  Emphasis: 'md-Emphasis',
  InlineCode: 'md-InlineCode',
  Strikethrough: 'md-Strikethrough',
  Link: 'md-live-link',
};
/** Paint the inline syntax of an inactive cell without installing links or HTML from the document. */
export function paintCell(element: HTMLElement, source: string) {
  if (!/[[\]*_`~]/u.test(source) || source.length > 2048) {
    element.textContent = source;
    return;
  }
  const doc = element.ownerDocument;
  const fragment = doc.createDocumentFragment();
  const render = (node: SyntaxNode, parent: DocumentFragment | HTMLElement, depth: number) => {
    if (depth > 24 || !node.firstChild) {
      parent.append(doc.createTextNode(source.slice(node.from, node.to)));
      return;
    }
    const cls = styles[node.name];
    const target = cls ? doc.createElement('span') : parent;
    if (cls && target.nodeType === 1) {
      (target as HTMLElement).className = cls;
      parent.append(target);
    }
    let at = node.from;
    for (let child: SyntaxNode | null = node.firstChild; child; child = child.nextSibling) {
      if (at < child.from) target.append(doc.createTextNode(source.slice(at, child.from)));
      // A link destination, title and all punctuation after the closing label stay in the source input.
      if (node.name === 'Link' && child.name === 'LinkMark' && source[child.from] === ']') return;
      if (!child.name.endsWith('Mark') || !cls) render(child, target, depth + 1);
      at = child.to;
    }
    if (at < node.to) target.append(doc.createTextNode(source.slice(at, node.to)));
  };
  render(markdownLanguage.parser.parse(source).topNode, fragment, 0);
  element.replaceChildren(fragment);
}
