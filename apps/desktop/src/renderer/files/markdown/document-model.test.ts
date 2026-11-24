import { expect, it } from 'vitest';
import { parseDocument } from './document-model.js';

it('indexes headings, task locations and footnotes in the original text without parsing fenced examples', () => {
  const source =
    '---\ntitle: Book\n---\n# Start\n\n- [ ] one\n\n~~~md\n# literal\n- [ ] literal\n~~~\n\n> [!TIP]\n> Keep going\n\nEquation $x^2$ and [^note].\n\n[^note]: A reference.\n';
  const doc = parseDocument(source);
  expect(doc.headings.map((h) => [h.title, h.line])).toEqual([['Start', 4]]);
  expect(doc.blocks.find((b) => b.block.kind === 'list')?.line).toBe(6);
  expect(doc.blocks.find((b) => b.callout)?.callout).toBe('tip');
  expect(doc.notes.map((n) => n.label)).toEqual(['note']);
  expect(
    doc.blocks.flatMap((b) => (b.block.kind === 'paragraph' ? b.block.spans : [])),
  ).toContainEqual({ kind: 'math', text: 'x^2' });
});
it('retains full document parsing for references, local images, duplicate headings, and an unfinished front matter delimiter', () => {
  const doc = parseDocument('# One\n# One\n\n![map][asset]\n\n[asset]: ../maps/view.png\n');
  expect(doc.headings.map((h) => h.slug)).toEqual(['one', 'one-1']);
  expect(JSON.stringify(doc.blocks)).toContain('../maps/view.png');
  expect(parseDocument('---\n## Still visible\n').headings).toHaveLength(1);
});

it('uses original lines for tasks nested in a quote or list and skips checklist examples in fences', () => {
  const source = '> - [ ] outer\n>   - [x] inner\n>\n> ```md\n> - [ ] example\n> ```\n';
  const model = parseDocument(source);
  const items: number[] = [];
  function visit(b: (typeof model.blocks)[number]['block']) {
    if (b.kind === 'list')
      for (const row of b.items) {
        if (row.sourceLine) items.push(row.sourceLine);
        row.blocks.forEach(visit);
      }
    else if (b.kind === 'blockquote') b.blocks.forEach(visit);
  }
  model.blocks.forEach((entry) => {
    visit(entry.block);
  });
  expect(items).toEqual([1, 2]);
});

it('keeps compound front matter intact and indexes the following heading at its original line', () => {
  const doc = parseDocument('---\ntags:\n  - release\n---\n# Ready\n');
  expect(doc.blocks[0]?.block).toEqual({
    kind: 'code',
    lang: 'yaml',
    text: 'tags:\n  - release',
    complete: true,
  });
  expect(doc.headings[0]?.line).toBe(5);
  expect(parseDocument('+++\ntitle = "Release"\n+++\n').fields).toEqual([['title', '"Release"']]);
});

it('renders authored inline formats as semantic nodes, including nested emphasis, with arbitrary HTML inert', () => {
  const doc = parseDocument(
    '==**marked**== H~2~O x^2^ <u>under</u> ~~gone~~ `==literal==` <u class=x>plain</u>',
  );
  const block = doc.blocks[0]?.block;
  expect(block?.kind).toBe('paragraph');
  if (block?.kind !== 'paragraph') throw new Error('Expected paragraph');
  expect(block.spans).toEqual(
    expect.arrayContaining([
      {
        kind: 'mark',
        children: [{ kind: 'strong', children: [{ kind: 'text', text: 'marked' }] }],
      },
      { kind: 'sub', children: [{ kind: 'text', text: '2' }] },
      { kind: 'sup', children: [{ kind: 'text', text: '2' }] },
      { kind: 'u', children: [{ kind: 'text', text: 'under' }] },
      { kind: 'delete', children: [{ kind: 'text', text: 'gone' }] },
      { kind: 'code', text: '==literal==' },
      { kind: 'html', text: '<u class=x>' },
    ]),
  );
});
