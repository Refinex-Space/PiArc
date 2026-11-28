// A05: only the unfinished tail is parsed again, open markup is closed while streaming, and the
// finished message equals a one-shot parse.
import { Lexer } from 'marked';
import { describe, expect, it } from 'vitest';

import { CORPUS, mixedReply } from '../../lab/fixtures/corpus.js';
import { approximateTokens, seededRandom } from '../../lab/fixtures/synthesizer.js';
import { IncrementalMarkdown, hasClosingFence, parseMarkdown } from './incremental.js';
import type { Block } from './ir.js';

/** Documents with constructs that interact across block boundaries. */
const EDGE_CASES: readonly string[] = [
  'Text with a [reference][ref] used before it is defined.\n\n[ref]: https://example.com/ "Ref"\n',
  'Title\n=====\n\nPara\n---\n\n- a\n\n- b\n\n  continued\n\nafter\n',
  'intro\n| a | b |\n|---|:-:|\n| 1 | 2 |\n\ntext\n',
  '> quote\nlazy continuation\n\n# heading\n#hashtag is text\n',
  '- item\n\n      indented code in item\n\n    paragraph in item\n',
  '<div>\nraw html block\n</div>\n\n<script>\n\nalert(1)\n\n</script>\n\nend\n',
  '```\nnever closed\n\nstill code',
  'Mixed line endings\r\nwith CRLF\r\n\r\nand a lone\rCR\n',
  '1. one\n2. two\n10. ten\n\n* star\n+ plus\n',
  'para\n    not code (lazy)\n\n    real code\n',
];

const DOCUMENTS: readonly string[] = [
  ...CORPUS.map((document) => document.markdown),
  ...EDGE_CASES,
];

/** Splits `text` into chunks: approximate tokens, fixed sizes, or random sizes. */
function chunkings(text: string): string[][] {
  const fixed = (size: number): string[] => {
    const chunks: string[] = [];
    for (let index = 0; index < text.length; index += size) {
      chunks.push(text.slice(index, index + size));
    }
    return chunks;
  };
  const random = seededRandom(text.length);
  const randomChunks: string[] = [];
  for (let index = 0; index < text.length;) {
    const size = 1 + Math.floor(random() * 40);
    randomChunks.push(text.slice(index, index + size));
    index += size;
  }
  // A long document is lexed again for every chunk while its last block grows, so it gets
  // only the coarser splits to keep the test fast.
  return text.length > 5_000
    ? [fixed(64), fixed(997), randomChunks]
    : [approximateTokens(text), fixed(1), fixed(7), fixed(64), randomChunks];
}

function stream(chunks: readonly string[], finalSeparately: boolean): IncrementalMarkdown {
  const parser = new IncrementalMarkdown();
  chunks.forEach((chunk, index) => {
    parser.append(chunk, !finalSeparately && index === chunks.length - 1);
  });
  if (finalSeparately) {
    parser.append('', true);
  }
  return parser;
}

describe('IncrementalMarkdown', () => {
  it('ends with the same blocks as a one-shot parse, however the text was split', () => {
    for (const document of DOCUMENTS) {
      const expected = parseMarkdown(document);
      for (const chunks of chunkings(document)) {
        expect(stream(chunks, false).blocks()).toEqual(expected);
        expect(stream(chunks, true).blocks()).toEqual(expected);
      }
    }
  });

  it('lexes at most the last two blocks on each update', () => {
    const text = Array.from(
      { length: 120 },
      (_, index) => `Paragraph ${String(index)} with **bold** and \`code\`.`,
    ).join('\n\n');
    const parser = new IncrementalMarkdown();
    let lexed = 0;
    for (const chunk of approximateTokens(text)) {
      parser.append(chunk);
      lexed += parser.stats.lexedChars;
      const tail = text.slice(parser.stats.lexedFrom, parser.length);
      const blocks = Lexer.lex(tail).filter((token) => token.type !== 'space');
      expect(blocks.length).toBeLessThanOrEqual(2);
    }
    // Re-lexing only the tail keeps the total linear in the message length.
    expect(lexed).toBeLessThan(text.length * 40);
    expect(parser.stats.lexedFrom).toBeGreaterThan(text.length - 200);
  });

  it('keeps the objects of stable blocks across updates', () => {
    const parser = new IncrementalMarkdown();
    parser.append('First paragraph.\n\nSecond paragraph.\n\nThird');
    const first = parser.blocks()[0];
    const update = parser.append(' paragraph grows.');
    expect(update.keep).toBeGreaterThanOrEqual(1);
    expect(parser.blocks()[0]).toBe(first);
  });

  it('reports the unchanged prefix so a client can rebuild the block list', () => {
    const text = mixedReply();
    const parser = new IncrementalMarkdown();
    let client: Block[] = [];
    for (const chunk of approximateTokens(text)) {
      const update = parser.append(chunk);
      client = [...client.slice(0, update.keep), ...update.blocks];
      expect(client).toEqual(parser.blocks());
    }
    const last = parser.append('', true);
    client = [...client.slice(0, last.keep), ...last.blocks];
    expect(client).toEqual(parseMarkdown(text));
  });

  it('closes open emphasis, code spans and fences while streaming', () => {
    const parser = new IncrementalMarkdown();
    parser.append('Some **bold and `code');
    expect(parser.blocks()).toEqual([
      {
        kind: 'paragraph',
        spans: [
          { kind: 'text', text: 'Some ' },
          {
            kind: 'strong',
            children: [
              { kind: 'text', text: 'bold and ' },
              { kind: 'code', text: 'code' },
            ],
          },
        ],
      },
    ]);
    parser.append('`** done.\n\n```python\nprint("hi")');
    expect(parser.blocks().at(-1)).toEqual({
      kind: 'code',
      lang: 'python',
      text: 'print("hi")',
      complete: false,
    });
    parser.append('\n```\n');
    expect(parser.blocks().at(-1)).toMatchObject({ kind: 'code', complete: true });
  });

  it('treats a fence still open when the message ends as complete code', () => {
    const parser = new IncrementalMarkdown();
    parser.append('```ts\nconst a = 1;');
    expect(parser.blocks()[0]).toMatchObject({ kind: 'code', complete: false });
    parser.append('', true);
    expect(parser.blocks()).toEqual([
      { kind: 'code', lang: 'ts', text: 'const a = 1;', complete: true },
    ]);
  });

  it('refuses text after the final update', () => {
    const parser = new IncrementalMarkdown();
    parser.append('done', true);
    expect(() => parser.append('more')).toThrow('already final');
  });
});

describe('hasClosingFence', () => {
  it('recognizes closing fences of the same kind and at least the same length', () => {
    expect(hasClosingFence('```js\ncode\n```\n')).toBe(true);
    expect(hasClosingFence('````\ncode\n`````')).toBe(true);
    expect(hasClosingFence('~~~\ncode\n~~~')).toBe(true);
    expect(hasClosingFence('```\ncode')).toBe(false);
    expect(hasClosingFence('````\ncode\n```')).toBe(false);
    expect(hasClosingFence('~~~\ncode\n```')).toBe(false);
    expect(hasClosingFence('```')).toBe(false);
  });
});

describe('marked lexer invariant used for offsets', () => {
  it('top-level raw strings add up to the input', () => {
    for (const document of DOCUMENTS) {
      const normalized = document.replace(/\r\n?/gu, '\n');
      const tokens = Lexer.lex(normalized, { gfm: true });
      expect(tokens.map((token) => token.raw).join('')).toBe(normalized);
    }
  });
});
