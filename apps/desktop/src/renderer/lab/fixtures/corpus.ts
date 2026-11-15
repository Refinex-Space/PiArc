// Markdown a model produces, used by the stream synthesizer, the history generator and the
// parser tests: paragraphs, lists, tables, code in several languages, a very long code block,
// unclosed markup, Chinese and Japanese text, and the XSS payloads.
import { xssMessage } from './xss-payloads.js';

/** One fixture document. */
export interface CorpusDocument {
  readonly id: string;
  readonly markdown: string;
}

const PARAGRAPHS = `## Streaming output

PiArc renders **model output** as it arrives, with \`inline code\`, _emphasis_, ***both***,
~~struck text~~ and [a link](https://example.com/docs "Docs"). A bare URL such as
https://example.com/path?query=1 becomes a link too, and so does www.example.org.

中文段落：模型的输出会被逐字渲染，**加粗**、*斜体*与\`行内代码\`都要正确显示。标点符号「引号」、
（括号）和——破折号不应打断排版。

日本語の段落です。ストリーミング中でも**強調**や\`コード\`が崩れないことを確認します。絵文字 🚀✨ も含みます。

A hard line break follows this line\\
and this sentence continues on the next line.

Escaped markup stays literal: \\*not emphasis\\*, \\\`not code\\\`, &lt;not a tag&gt; &amp; &copy; 2026.
`;

const LISTS = `### Lists

- First item with **bold** text
- Second item
  - Nested item with \`code\`
  - Another nested item
    1. Deeply nested ordered item
    2. And another
- Third item

3. Ordered list starting at three
4. Next item
5. Last item

- [x] Write the parser
- [ ] Measure the scroll frame rate
- [ ] Check input methods on Windows
`;

const TABLE = `### Table

| Metric | Budget | Measured | Note |
|:-------|-------:|:--------:|------|
| Long tasks | 0 | 0 | over 50 ms |
| Frame time p99 | 16 ms | 9.8 ms | streaming at 100 token/s |
| Cold load | 300 ms | 142 ms | 1,000 items |
| Pipe \\| inside | \`a \\| b\` | — | escaped |
`;

const CODE = `### Code in several languages

\`\`\`ts
export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
\`\`\`

\`\`\`rust
fn main() {
    let names = vec!["alpha", "beta"];
    for name in &names {
        println!("hello, {name}");
    }
}
\`\`\`

\`\`\`python
def fib(n: int) -> int:
    return n if n < 2 else fib(n - 1) + fib(n - 2)
\`\`\`

\`\`\`bash
npm run verify && echo "all green"
\`\`\`

\`\`\`json
{ "name": "piarc", "private": true, "workspaces": ["apps/*"] }
\`\`\`

\`\`\`diff
- const limit = 10;
+ const limit = 20;
\`\`\`

\`\`\`made-up-language
this language is unknown, so it stays plain text
\`\`\`

    indented code block
    without a language
`;

const QUOTE = `> A blockquote with **markup**
> spanning two lines.

---

#### An image is shown as a link

![architecture diagram](https://example.com/diagram.png "Diagram")
`;

const UNCLOSED = `Some **bold text that is never closed and a \`code span that is not closed either

\`\`\`python
def unfinished():
    return "the closing fence never arrives"
`;

/** A TypeScript block of `lines` lines, for the very long code block. */
export function longCodeBlock(lines: number): string {
  const body: string[] = [];
  for (let line = 0; line < lines; line += 1) {
    switch (line % 4) {
      case 0:
        body.push(`export function handler${String(line)}(input: string): number {`);
        break;
      case 1:
        body.push(`  // Line ${String(line)}: parse the input and return its length.`);
        break;
      case 2:
        body.push(`  return input.trim().length + ${String(line)};`);
        break;
      default:
        body.push('}');
    }
  }
  return `Here is a long file:\n\n\`\`\`typescript\n${body.join('\n')}\n\`\`\`\n`;
}

/** The fixture documents, each a complete agent message. */
export const CORPUS: readonly CorpusDocument[] = [
  { id: 'paragraphs', markdown: PARAGRAPHS },
  { id: 'lists', markdown: LISTS },
  { id: 'table', markdown: TABLE },
  { id: 'code', markdown: CODE },
  { id: 'quote', markdown: QUOTE },
  { id: 'unclosed', markdown: UNCLOSED },
  { id: 'long-code', markdown: longCodeBlock(1200) },
  { id: 'xss', markdown: xssMessage() },
];

/** The document with `id`; throws for an unknown id. */
export function corpusDocument(id: string): CorpusDocument {
  const document = CORPUS.find((entry) => entry.id === id);
  if (document === undefined) {
    throw new Error(`Unknown corpus document: ${id}`);
  }
  return document;
}

/** A realistic mixed reply: everything except the long block and the payloads. */
export function mixedReply(): string {
  return [PARAGRAPHS, LISTS, TABLE, CODE, QUOTE].join('\n');
}
