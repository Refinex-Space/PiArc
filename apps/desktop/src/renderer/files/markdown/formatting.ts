// Adapted from Markdown Studio (Refinex), web/core/features/viewers/markdown/livePreview/commands.ts,
// revision e6ebd0c, Apache-2.0. Modified for PiArc. See third-party/licenses/markdown-studio.LICENSE.
import { isolateHistory } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Transaction,
} from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { newTable } from './table-model.js';
export type InlineFormat = 'bold' | 'italic' | 'strikethrough' | 'code' | 'math' | 'highlight';

const FORMATS: Record<InlineFormat, { node: string | null; mark: string; marks: string | null }> = {
  bold: { node: 'StrongEmphasis', mark: '**', marks: 'EmphasisMark' },
  italic: { node: 'Emphasis', mark: '*', marks: 'EmphasisMark' },
  strikethrough: { node: 'Strikethrough', mark: '~~', marks: 'StrikethroughMark' },
  code: { node: 'InlineCode', mark: '`', marks: 'CodeMark' },
  math: { node: 'InlineMath', mark: '$', marks: 'InlineMathMark' },
  highlight: { node: null, mark: '==', marks: null },
};

/** The innermost `name` node around `[from, to]`. */
function around(state: EditorState, from: number, to: number, name: string): SyntaxNode | null {
  for (
    let n: SyntaxNode | null = syntaxTree(state).resolveInner(from, from === to ? 0 : 1);
    n;
    n = n.parent
  )
    if (n.name === name && n.from <= from && n.to >= to) return n;
  return null;
}

const WORD = /[\p{L}\p{N}_]/u;

function wordAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(pos);
  let a = pos - line.from;
  let b = a;
  while (a > 0 && WORD.test(line.text.charAt(a - 1))) a--;
  while (b < line.text.length && WORD.test(line.text.charAt(b))) b++;
  return a < b ? { from: line.from + a, to: line.from + b } : null;
}

/** Toggles `format` on each selection range: unwraps a range already formatted, else wraps it. */
function toggleInline(state: EditorState, format: InlineFormat) {
  const f = FORMATS[format];
  const tr = state.changeByRange((range) => {
    const node = f.node ? around(state, range.from, range.to, f.node) : null;
    if (node && f.marks) {
      const marks = node.getChildren(f.marks);
      const open = marks[0];
      const close = marks.at(-1);
      if (open && close && open !== close) {
        const changes = [
          { from: open.from, to: open.to },
          { from: close.from, to: close.to },
        ];
        const shift = open.to - open.from;
        return {
          changes,
          range: EditorSelection.range(
            Math.max(open.from, range.anchor - shift),
            Math.max(open.from, Math.min(close.from - shift, range.head - shift)),
          ),
        };
      }
    }
    const m = f.mark;
    // Already wrapped just outside the selection: unwrap.
    if (
      !range.empty &&
      range.from >= m.length &&
      range.to + m.length <= state.doc.length &&
      state.sliceDoc(range.from - m.length, range.from) === m &&
      state.sliceDoc(range.to, range.to + m.length) === m
    )
      return {
        changes: [
          { from: range.from - m.length, to: range.from },
          { from: range.to, to: range.to + m.length },
        ],
        range: EditorSelection.range(range.from - m.length, range.to - m.length),
      };
    const target = range.empty ? wordAt(state, range.from) : range;
    if (!target) {
      return {
        changes: { from: range.from, insert: m + m },
        range: EditorSelection.cursor(range.from + m.length),
      };
    }
    return {
      changes: [
        { from: target.from, insert: m },
        { from: target.to, insert: m },
      ],
      range: range.empty
        ? EditorSelection.cursor(range.from + m.length)
        : EditorSelection.range(target.from + m.length, target.to + m.length),
    };
  });
  return state.update(tr, { userEvent: 'input.format', scrollIntoView: true });
}

/** Wraps the selection in a link (`[text](url)`), the caret in the URL, or opens one at the caret. */
function insertLink(state: EditorState) {
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    if (/^(https?:\/\/|www\.)\S+$/i.test(text)) {
      const insert = `[](${text})`;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    const insert = `[${text}]()`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + (text ? insert.length - 1 : 1)),
    };
  });
  return state.update(tr, { userEvent: 'input.format', scrollIntoView: true });
}

// ---------------------------------------------------------------------------
// Line blocks

export type BlockKind =
  'paragraph' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'bullet' | 'ordered' | 'task' | 'quote';

interface LineShape {
  indent: string;
  quote: string;
  heading: number;
  list: 'bullet' | 'ordered' | null;
  task: string | null;
  /** Where the line's content starts (after all markers). */
  content: number;
}

const SHAPE = /^(\s*)((?:>\s?)*)(?:(#{1,6})\s+|([-*+])\s+|(\d{1,9})[.)]\s+)?(\[[ xX]\]\s+)?/;

function lineShape(text: string): LineShape {
  const m = SHAPE.exec(text) ?? [''];
  const list = m[4] ? 'bullet' : m[5] ? 'ordered' : null;
  return {
    indent: m[1] ?? '',
    quote: m[2] ?? '',
    heading: m[3]?.length ?? 0,
    list,
    task: list && m[6] ? m[6] : null,
    content: m[0].length,
  };
}

const kindOf = (s: LineShape): BlockKind =>
  s.heading
    ? (`h${String(s.heading)}` as BlockKind)
    : s.task
      ? 'task'
      : s.list === 'bullet'
        ? 'bullet'
        : s.list === 'ordered'
          ? 'ordered'
          : 'paragraph';

/** Turns the selected lines into `kind` (back into paragraphs when they all are `kind` already). */
function setBlock(state: EditorState, kind: BlockKind) {
  const lines = new Map<number, { from: number; text: string }>();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      const l = state.doc.line(n);
      lines.set(l.from, { from: l.from, text: l.text });
    }
  }
  const all = [...lines.values()].sort((a, b) => a.from - b.from);
  // Blank lines stay blank unless the caret is on one.
  const targets = all.length > 1 ? all.filter((l) => l.text.trim()) : all;
  if (!targets.length) return null;
  const shapes = targets.map((l) => lineShape(l.text));
  const changes: ChangeSpec[] = [];
  if (kind === 'quote') {
    const quoted = shapes.every((s) => s.quote);
    targets.forEach((l) => {
      const s = lineShape(l.text);
      if (quoted) {
        const quoteMark = /^>\s?/u.exec(s.quote)?.[0] ?? '';
        changes.push({
          from: l.from + s.indent.length,
          to: l.from + s.indent.length + quoteMark.length,
        });
      } else changes.push({ from: l.from + s.indent.length, insert: '> ' });
    });
  } else {
    const same = shapes.every((s) => kindOf(s) === kind);
    const to: BlockKind = same ? 'paragraph' : kind;
    targets.forEach((l, i) => {
      const s = lineShape(l.text);
      const heading = /^h(\d)$/.exec(to);
      let prefix: string;
      if (heading) prefix = `${s.quote}${'#'.repeat(Number(heading[1]))} `;
      else if (to === 'bullet') prefix = `${s.indent}${s.quote}- `;
      else if (to === 'ordered') prefix = `${s.indent}${s.quote}${String(i + 1)}. `;
      else if (to === 'task') prefix = `${s.indent}${s.quote}- ${s.task ?? '[ ] '}`;
      else prefix = `${s.heading ? '' : s.indent}${s.quote}`;
      changes.push({ from: l.from, to: l.from + s.content, insert: prefix });
    });
  }
  const set = state.changes(changes);
  // A caret at a line's start follows the markers inserted there.
  return state.update({
    changes: set,
    selection: state.selection.map(set, 1),
    userEvent: 'input.format',
    scrollIntoView: true,
  });
}

const inline = {
  bold: (state: EditorState) => toggleInline(state, 'bold'),
  italic: (state: EditorState) => toggleInline(state, 'italic'),
  strike: (state: EditorState) => toggleInline(state, 'strikethrough'),
  inlineCode: (state: EditorState) => toggleInline(state, 'code'),
  link: insertLink,
};
export type FormatCommand =
  keyof typeof inline | BlockKind | 'table' | 'fence' | 'formula' | 'diagram' | 'rule';

function formatChange(
  state: EditorState,
  command: FormatCommand,
  columnName: (n: number) => string,
): Transaction | null {
  if (command in inline) return inline[command as keyof typeof inline](state);
  if (
    command === 'paragraph' ||
    /^h[1-6]$/u.test(command) ||
    ['bullet', 'ordered', 'task', 'quote'].includes(command)
  )
    return setBlock(state, command as BlockKind);
  const range = state.selection.main,
    selected = state.sliceDoc(range.from, range.to);
  const row = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(range.to);
  const before =
    range.from > row.from
      ? '\n\n'
      : row.number > 1 && state.doc.line(row.number - 1).length
        ? '\n'
        : '';
  const after = range.to < last.to ? '\n\n' : '\n';
  const fence = String.fromCharCode(96).repeat(3);
  const blocks = {
    table: () => newTable(3, 2, (i) => columnName(i + 1)),
    fence: () => fence + '\n' + selected + '\n' + fence,
    formula: () => '$$\n' + selected + '\n$$',
    diagram: () => fence + 'mermaid\n' + (selected || 'flowchart LR\n  A --> B') + '\n' + fence,
    rule: () => '---',
  };
  const value = blocks[command as keyof typeof blocks]();
  const anchor = range.from + before.length + (command === 'table' ? 0 : value.indexOf('\n') + 1);
  return state.update({
    changes: { from: range.from, to: range.to, insert: before + value + after },
    selection: { anchor },
    userEvent: 'input.format',
    scrollIntoView: true,
  });
}

export function applyFormat(
  view: EditorView,
  command: FormatCommand,
  columnName: (n: number) => string,
  prefix?: { from: number; to: number },
) {
  if (view.composing || view.state.readOnly) return false;
  const before = prefix
    ? view.state.update({ changes: { ...prefix, insert: '' }, selection: { anchor: prefix.from } })
    : null;
  const edit = formatChange(before?.state ?? view.state, command, columnName);
  if (!edit) return false;
  if (before) {
    view.dispatch({
      changes: before.changes.compose(edit.changes),
      selection: edit.newSelection,
      userEvent: 'input.format',
      annotations: isolateHistory.of('full'),
      scrollIntoView: true,
    });
  } else view.dispatch(edit);
  view.focus();
  return true;
}
