import type { FileSelection } from '../viewer-model.js';
const elementOf = (node: Node) => (node.nodeType === 1 ? (node as Element) : node.parentElement);

// The reader annotates each rendered block with its original source lines. When the
// selected text is literal, even repeated words can be located inside that block.
export function readerRange(range: Range, lines: readonly string[]): FileSelection | undefined {
  const start = elementOf(range.startContainer)?.closest<HTMLElement>('[data-doc-line]');
  const end = elementOf(range.endContainer)?.closest<HTMLElement>('[data-end-line]');
  const text = range.toString();
  if (!start || !end || !text.trim()) return;
  const startLine = Number(start.dataset.docLine),
    endLine = Number(end.dataset.endLine);
  if (start === end) {
    const raw = lines.slice(startLine - 1, endLine).join('\n');
    const before = range.cloneRange();
    before.selectNodeContents(start);
    before.setEnd(range.startContainer, range.startOffset);
    const prefix = before.toString();
    let ordinal = 0,
      from = 0;
    while ((from = prefix.indexOf(text, from)) !== -1) {
      ordinal++;
      from += text.length;
    }
    let at = -text.length;
    for (let i = 0; i <= ordinal; i++) {
      at = raw.indexOf(text, at + text.length);
      if (at < 0) break;
    }
    if (at >= 0) {
      const first = startLine + raw.slice(0, at).split('\n').length - 1;
      return { text, startLine: first, endLine: first + text.split('\n').length - 1 };
    }
  }
  return { text, startLine, endLine };
}
