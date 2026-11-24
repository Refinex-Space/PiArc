import { it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { parseTable } from './table-model.js';
import {
  editRegion,
  fullColumn,
  fullRow,
  rangeText,
  pasteRectangle,
  resizeTable,
} from './table-operations.js';
const raw =
  '| Key  | Name |\n> | :----- | ---:   |\n> | A\\|B | `a\\|b` |\n> | C    | **old** and new |';
function apply(source: string, edits: ReturnType<typeof editRegion>) {
  return EditorState.create({ doc: source }).update({ changes: edits }).newDoc.toString();
}
it('preserves container prefixes, delimiters, escaped cell bytes and unrelated whitespace when moving or duplicating', () => {
  const t = parseTable(raw, 0);
  expect(t).not.toBeNull();
  if (!t) throw Error('missing quoted table');
  expect(apply(raw, editRegion(t, fullRow(t, 1), 'duplicateRow'))).toBe(
    raw.replace('> | C', '> | A\\|B | `a\\|b` |\n> | C'),
  );
  expect(apply(raw, editRegion(t, fullColumn(t, 1), 'duplicateColumn'))).toBe(
    raw
      .replace(' Name |', ' Name | Name |')
      .replace(' ---:   |', ' ---:   | ---:   |')
      .replace(' `a\\|b` |', ' `a\\|b` | `a\\|b` |')
      .replace(' **old** and new |', ' **old** and new | **old** and new |'),
  );
  expect(apply(raw, editRegion(t, fullRow(t, 1), 'moveDown'))).toContain(
    '> | C    | **old** and new |\n> | A\\|B | `a\\|b` |',
  );
  expect(apply(raw, editRegion(t, fullRow(t, 2), 'addRow'))).toMatch(/\n> \| {2}\| {2}\|$/u);
});
it('formats heading cells without corrupting code spans or link destinations, and preserves alignment padding', () => {
  const source =
    '| A | B | C | D |\n| --- |----:|:---|---|\n| **old** and new | [show](https://example.org/a_**b**) | `x**y**` | *word* |';
  const t = parseTable(source, 0);
  if (!t) throw Error('no table');
  expect(apply(source, editRegion(t, fullRow(t, 1), 'headingRow'))).toContain(
    '| **old and new** | __[show](https://example.org/a_**b**)__ | __`x**y**`__ | __*word*__ |',
  );
  expect(apply(source, editRegion(t, fullColumn(t, 1), 'alignCenter'))).toContain(
    '| --- |:----:|:---|---|',
  );
});
it('copies and pastes a rectangle as TSV and resizes the table in a single document patch', () => {
  const source = '| A | B |\n| --- | --- |\n| 1 | 2 |',
    t = parseTable(source, 0);
  if (!t) throw Error('no table');
  expect(rangeText(t, { top: 0, bottom: 1, left: 0, right: 1 }, false)).toBe('A\tB\n1\t2');
  const pasted = apply(source, pasteRectangle(t, { row: 1, col: 1 }, 'x\ty\r\nz\tw'));
  expect(pasted).toBe('| A | B |  |\n| --- | --- | --- |\n| 1 | x | y |\n|  | z | w |');
  expect(apply(source, resizeTable(t, 1, 1))).toBe('| A |\n| --- |');
});
