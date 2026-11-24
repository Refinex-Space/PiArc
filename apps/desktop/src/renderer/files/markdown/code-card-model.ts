// Adapted from Markdown Studio livePreview/codeBlocks.ts (e6ebd0c, Apache-2.0).
// The underlying source remains authoritative, including indents, fence length and metadata.
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Line } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

export const validLanguage = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}_+#.-]{0,63}$/u;
export function languageSlot(state: EditorState, node: SyntaxNode) {
  const mark = node.getChild('CodeMark');
  if (!mark) return null;
  const rest = state.sliceDoc(mark.to, state.doc.lineAt(mark.to).to);
  const prefix = /^\s*/u.exec(rest)?.[0] ?? '';
  const from = mark.to + prefix.length;
  const info = rest.slice(prefix.length);
  const lang = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}_+#.-]*(?=\s|\{|$)/u.exec(info)?.[0] ?? '';
  return { from, to: from + lang.length, lang, separate: !lang && !!info };
}
export interface CodeCardShape {
  open: Line;
  close: Line;
  language: string;
  math: boolean;
}
export function shapeOf(state: EditorState, node: SyntaxNode): CodeCardShape | null {
  const open = state.doc.lineAt(node.from),
    close = state.doc.lineAt(node.to);
  if (close.number < open.number + 2) return null;
  if (node.name === 'BlockMath')
    return open.text.trim() === '$$' && close.text.trim() === '$$'
      ? { open, close, language: 'LaTeX', math: true }
      : null;
  const [first, last] = node.getChildren('CodeMark');
  if (
    !first ||
    !last ||
    last.from < close.from ||
    /\S/u.test(state.sliceDoc(open.from, first.from)) ||
    /\S/u.test(state.sliceDoc(close.from, last.from))
  )
    return null;
  return { open, close, language: languageSlot(state, node)?.lang ?? '', math: false };
}
export function fenceAt(state: EditorState, pos: number) {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = tree.resolve(pos, side); n; n = n.parent)
      if (n.name === 'FencedCode' || n.name === 'BlockMath') return n;
  }
  return null;
}
