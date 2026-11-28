// Adapted from Markdown Studio livePreview/codeBlocks.ts (e6ebd0c, Apache-2.0).
import { Prec, type EditorState } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';
import { fenceAt, shapeOf } from './code-card-model.js';

function enter(view: EditorView) {
  const { state } = view,
    line = state.doc.lineAt(state.selection.main.head);
  if (line.to !== state.selection.main.head) return false;
  const match = /^( {0,3})(`{3,}|~{3,})[^\r\n]*$/u.exec(line.text);
  const node = match && fenceAt(state, line.from + (match[1]?.length ?? 0) + 1);
  if (
    !node ||
    state.doc.lineAt(node.from).number !== line.number ||
    node.getChildren('CodeMark').length !== 1
  )
    return false;
  const indent = match[1] ?? '',
    fence = match[2] ?? '';
  view.dispatch({
    changes: { from: line.to, insert: '\n' + indent + '\n' + indent + fence },
    selection: { anchor: line.to + 1 + indent.length },
    scrollIntoView: true,
    userEvent: 'input.type',
  });
  return true;
}
function remove(view: EditorView, backward: boolean) {
  const { state } = view,
    at = state.selection.main.head,
    line = state.doc.lineAt(at);
  if (at !== (backward ? line.from : line.to)) return false;
  const node = fenceAt(state, at),
    shape = node && shapeOf(state, node);
  if (shape && at === (backward ? shape.open.to + 1 : shape.close.from - 1)) {
    if (backward && !line.text.trim() && shape.close.from - 1 === line.to)
      view.dispatch({
        changes: { from: shape.open.from, to: shape.close.to },
        userEvent: 'delete.backward',
      });
    return true;
  }
  const near = backward ? line.from - 1 : line.to + 2;
  if (near < 0 || near > state.doc.length) return false;
  const adjacent = fenceAt(state, near),
    card = adjacent && shapeOf(state, adjacent);
  if (!card || (backward ? card.close.to !== line.from - 1 : card.open.from !== line.to + 1))
    return false;
  if (!line.text.trim())
    view.dispatch({
      changes: backward
        ? { from: line.from - 1, to: line.to }
        : { from: line.from, to: line.to + 1 },
      userEvent: backward ? 'delete.backward' : 'delete.forward',
    });
  else
    view.dispatch({
      selection: { anchor: backward ? card.close.from - 1 : card.open.to + 1 },
      scrollIntoView: true,
    });
  return true;
}
export function codeCardKeys(live: (state: EditorState) => boolean) {
  const ready = (v: EditorView) =>
    live(v.state) &&
    !v.state.readOnly &&
    !v.composing &&
    v.state.selection.ranges.length === 1 &&
    v.state.selection.main.empty;
  return Prec.highest(
    keymap.of([
      { key: 'Enter', run: (v) => ready(v) && enter(v) },
      { key: 'Backspace', run: (v) => ready(v) && remove(v, true) },
      { key: 'Delete', run: (v) => ready(v) && remove(v, false) },
    ]),
  );
}
