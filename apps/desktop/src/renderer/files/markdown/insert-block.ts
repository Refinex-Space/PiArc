// Markdown Studio e6ebd0c, livePreview/commands.ts, Apache-2.0. PiArc builds a
// single CodeMirror transaction for the template and the user's slash query.
import type { EditorState } from '@codemirror/state';

const diagrams = {
  flowchart: 'flowchart LR\n    A[Start] --> B{Ready?}\n    B -->|Yes| C[Finish]\n    B -->|No| A',
  sequence:
    'sequenceDiagram\n    participant C as Client\n    participant S as Server\n    C->>S: Request\n    S-->>C: Response',
  class:
    'classDiagram\n    class Order {\n        +String id\n        +submit()\n    }\n    Order "1" --> "*" Item',
  state:
    'stateDiagram-v2\n    [*] --> Draft\n    Draft --> Review\n    Review --> Published\n    Published --> [*]',
  er: 'erDiagram\n    CUSTOMER ||--o{ ORDER : places\n    ORDER ||--|{ ITEM : contains',
  gantt:
    'gantt\n    dateFormat YYYY-MM-DD\n    section Project\n    Design :a1, 2026-01-01, 5d\n    Build :after a1, 10d',
  pie: 'pie title Share\n    "A" : 40\n    "B" : 35\n    "C" : 25',
  mindmap: 'mindmap\n  root((Topic))\n    Idea\n      Detail\n    Question',
};
export type DiagramKind = keyof typeof diagrams;
export type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';
export type Template =
  `diagram-${DiagramKind}` | `callout-${CalloutKind}` | 'footnote' | 'frontMatter';

export function insertTemplate(state: EditorState, kind: Template) {
  const range = state.selection.main;
  if (kind === 'frontMatter') {
    const exists = /^(---|\+\+\+)\s*$/u.test(state.doc.line(1).text);
    return state.update({
      changes: exists ? [] : { from: 0, insert: '---\ntitle: \n---\n\n' },
      selection: { anchor: exists ? 0 : '---\ntitle: '.length },
      userEvent: 'input.format',
      scrollIntoView: true,
    });
  }
  if (kind === 'footnote') {
    const used = new Set(Array.from(state.doc.toString().matchAll(/\[\^(\d+)\]/gu), (m) => m[1]));
    let n = 1;
    while (used.has(String(n))) n++;
    const marker = '[^' + String(n) + ']';
    const end = state.doc.length;
    const middle = state.sliceDoc(range.from, range.to);
    const separator =
      range.to === end
        ? '\n\n'
        : state.sliceDoc(Math.max(0, end - 2)).endsWith('\n\n')
          ? ''
          : state.sliceDoc(end - 1).endsWith('\n')
            ? '\n'
            : '\n\n';
    const def = separator + marker + ': ' + middle;
    const changes = state.changes([
      { from: range.from, to: range.to, insert: marker },
      { from: end, insert: def },
    ]);
    return state.update({
      changes,
      selection: { anchor: changes.newLength },
      userEvent: 'input.format',
      scrollIntoView: true,
    });
  }
  const line = state.doc.lineAt(range.from),
    last = state.doc.lineAt(range.to);
  const selected = state.sliceDoc(range.from, range.to);
  const diagram = kind.startsWith('diagram-');
  const body = diagram
    ? selected || diagrams[kind.slice(8) as DiagramKind]
    : '> [!' + kind.slice(8).toUpperCase() + ']\n> ' + selected.replaceAll('\n', '\n> ');
  const ticks = String.fromCharCode(96).repeat(3);
  const value = diagram ? ticks + 'mermaid\n' + body + '\n' + ticks : body;
  const before =
    range.from > line.from
      ? '\n\n'
      : line.number > 1 && state.doc.line(line.number - 1).length
        ? '\n'
        : '';
  const tail = range.to < last.to ? '\n\n' : '\n';
  const anchor =
    range.from +
    before.length +
    (diagram
      ? ticks.length + 'mermaid\n'.length + (body.split('\n')[0]?.length ?? 0)
      : value.length);
  return state.update({
    changes: { from: range.from, to: range.to, insert: before + value + tail },
    selection: { anchor },
    userEvent: 'input.format',
    scrollIntoView: true,
  });
}
