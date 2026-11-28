// Clipboard "Copy as" writes text in the selected representation. It never exposes
// the HTML of CodeMirror widgets, app controls, or their associated document data.
import { Marked, Renderer } from 'marked';
import { safeHref } from '../../transcript/markdown/text.js';
const escaped = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
function link(value: string) {
  const uri = safeHref(value);
  if (uri) return uri;
  return value &&
    !/^(?:[\w+.-]+:|[/\\]{2})/u.test(value) &&
    !Array.from(value).some((c) => c.charCodeAt(0) < 32)
    ? value
    : undefined;
}
const renderer = new Renderer();
renderer.html = ({ text }) => escaped(text);
renderer.link = function ({ href, tokens }) {
  const url = link(href),
    body = this.parser.parseInline(tokens);
  return url ? '<a href="' + escaped(url) + '">' + body + '</a>' : body;
};
renderer.image = function ({ href, text }) {
  const url = link(href);
  return url ? '<img src="' + escaped(url) + '" alt="' + escaped(text) + '">' : escaped(text);
};
const parser = new Marked({ gfm: true, renderer });
export function markdownToHtml(text: string) {
  return parser.parse(text, { async: false });
}

const tags = new Set(
  'p h1 h2 h3 h4 h5 h6 strong b em i del s u mark sub sup pre code br li ul ol blockquote table td th tr thead tbody hr a'.split(
    ' ',
  ),
);
function render(node: Node, format: 'markdown' | 'html'): string {
  if (node.nodeType === 3)
    return format === 'html' ? escaped(node.textContent ?? '') : (node.textContent ?? '');
  const el = node.nodeType === 1 ? (node as Element) : undefined;
  if (el?.matches('button:not(.file-document-link),[aria-hidden=true],input,svg,.code-controls'))
    return '';
  const children = Array.from(node.childNodes)
    .map((n) => render(n, format))
    .join('');
  if (!el) return children;
  const tag = el.classList.contains('file-document-link') ? 'a' : el.tagName.toLowerCase();
  const href = link(el.getAttribute('href') ?? el.getAttribute('data-file-path') ?? '');
  if (format === 'html')
    return !tags.has(tag)
      ? children
      : tag === 'br' || tag === 'hr'
        ? '<' + tag + '>'
        : '<' +
          tag +
          (tag === 'a' && href ? ' href="' + escaped(href) + '"' : '') +
          '>' +
          children +
          '</' +
          tag +
          '>';
  switch (tag) {
    case 'b':
    case 'strong':
      return '**' + children + '**';
    case 'i':
    case 'em':
      return '*' + children + '*';
    case 'del':
    case 's':
      return '~~' + children + '~~';
    case 'u':
      return '<u>' + children + '</u>';
    case 'sup':
      return '^' + children + '^';
    case 'sub':
      return '~' + children + '~';
    case 'mark':
      return '==' + children + '==';
    case 'a':
      return href ? '[' + children + '](' + href + ')' : children;
    case 'code':
      return el.parentElement?.tagName === 'PRE' ? children : '`' + children + '`';
    case 'pre':
      return '\n```\n' + children + '\n```\n';
    case 'p':
      return children + '\n\n';
    case 'br':
      return '\n';
    case 'li':
      return (
        (el.parentElement?.tagName === 'OL'
          ? String(Array.from(el.parentElement.children).indexOf(el) + 1) + '. '
          : '- ') +
        children.trimEnd() +
        '\n'
      );
    case 'blockquote':
      return (
        children
          .trimEnd()
          .split('\n')
          .map((l) => '> ' + l)
          .join('\n') + '\n'
      );
    case 'th':
    case 'td':
      return '| ' + children.replaceAll('|', '\\|') + ' ';
    case 'tr':
      return children + '|\n';
    case 'thead':
      return (
        children +
        '|' +
        Array.from(el.querySelectorAll('th'))
          .map(() => ' --- |')
          .join('') +
        '\n'
      );
    default:
      return /^h[1-6]$/u.test(tag)
        ? '#'.repeat(Number(tag[1])) + ' ' + children + '\n\n'
        : children;
  }
}
export function selectionMarkup(range: Range, format: 'markdown' | 'html') {
  let node: Node = range.cloneContents();
  // cloneContents omits the common ancestor (e.g. selecting just the label inside <strong>).
  let ancestor =
    range.commonAncestorContainer.nodeType === 1
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;
  while (ancestor && !ancestor.matches('.markdown-section,article,.markdown-reader')) {
    if (tags.has(ancestor.tagName.toLowerCase())) {
      const wrapper = ancestor.cloneNode(false);
      wrapper.appendChild(node);
      node = wrapper;
    }
    ancestor = ancestor.parentElement;
  }
  return render(node, format).trimEnd();
}
