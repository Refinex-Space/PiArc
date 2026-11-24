// Source and split views work on the same table model as the live grid. The clicked
// cell owns the command even if the text selection spans several rows or columns.
import { isolateHistory } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import type { AppContextValue } from '../../app/app-context.js';
import type { MenuItem } from '../../shell/Menu.js';
import { parseTable } from './table-model.js';
import { area, editAllowed, editRegion } from './table-operations.js';

const actions = [
  'addRow',
  'addColumn',
  'deleteRow',
  'deleteColumn',
  'alignLeft',
  'alignCenter',
  'alignRight',
  'moveLeft',
  'moveRight',
  'moveUp',
  'moveDown',
] as const;
function tableAt(state: EditorState, pos: number): SyntaxNode | null {
  for (const bias of [1, -1] as const)
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, bias); n; n = n.parent)
      if (n.name === 'Table') return n;
  return null;
}
export function sourceTableMenu(
  state: EditorState,
  pos: number,
  t: AppContextValue['t'],
  edit: (command: (view: EditorView) => void) => () => void,
): MenuItem | undefined {
  const node = tableAt(state, pos);
  if (!node || state.readOnly) return;
  const model = parseTable(state.sliceDoc(node.from, node.to), node.from);
  if (!model) return;
  const delta = state.doc.lineAt(pos).number - state.doc.lineAt(node.from).number;
  const row = Math.max(0, Math.min(model.rows.length, delta - 1));
  const line = delta === 1 ? model.delimiter : row === 0 ? model.header : model.rows[row - 1];
  const col = Math.max(
    0,
    Math.min(model.columns - 1, (line?.starts.filter((start) => start <= pos).length ?? 1) - 1),
  );
  const target = area({ row, col }, { row, col });
  return {
    id: 'md-table-actions',
    label: t('md.edit.tableActions'),
    submenu: actions.map((action) => ({
      id: 'md-table-' + action,
      label: t(`md.edit.${action}`),
      disabled: !editAllowed(model, target, action),
      run: edit((view) => {
        const changes = editRegion(model, target, action);
        if (changes.length)
          view.dispatch({
            changes,
            annotations: isolateHistory.of('full'),
            userEvent: 'input.table',
            scrollIntoView: true,
          });
      }),
    })),
  };
}
