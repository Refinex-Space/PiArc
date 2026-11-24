// File-only grammar adapted from Markdown Studio e6ebd0c, web/core/features/viewers/markdown/render.ts
// (Apache-2.0, third-party/licenses/markdown-studio.LICENSE). Emit typed nodes instead of HTML.
import { Marked, type Token, type TokenizerAndRendererExtension } from 'marked';
import { inlineStyles, inlineStyleTokens } from './inline-styles.js';
import { spans, toBlocks, type ConvertOptions } from '../../transcript/markdown/to-ir.js';
import { taskMarker } from './task-marker.js';
import type { Block, ListItem, Span } from '../../transcript/markdown/ir.js';

export interface DocumentBlock {
  block: Block;
  line: number;
  end: number;
  anchor?: string;
  callout?: Callout;
  calloutTitle?: string;
}
export interface Heading {
  title: string;
  line: number;
  level: number;
  slug: string;
}
export type Callout = 'note' | 'tip' | 'important' | 'warning' | 'caution';
export interface MarkdownDocument {
  blocks: DocumentBlock[];
  headings: Heading[];
  notes: { label: string; number: number; blocks: Block[] }[];
  fields: [string, string][];
  plain: boolean;
}
const definition =
  /^\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n(?:[ \t]*\n)*(?: {2,}|\t)[^\n]*)*)(?:\n|$)/u;
const blockMath =
  /^ {0,3}\$\$(?:[ \t]*\n([\s\S]*?)\n {0,3}\$\$|((?:\\[\s\S]|[^\n$\\])+?)\$\$)[ \t]*(?:\n|$)/u;
const inlineMath = /^\$(?!\$)((?:\\[\s\S]|[^\\$\n])+?)\$(?!\d)/u;

function lineBreaks(raw: string) {
  let count = 0;
  for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) count++;
  return count;
}
export function headingSlug(title: string) {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\s-]/gu, '')
      .replace(/\s+/gu, '-') || 'section'
  );
}
function headingTitle(spans: readonly Span[]): string {
  return spans
    .map((span) => {
      if ('children' in span) return headingTitle(span.children);
      if ('text' in span) return span.text;
      if (span.kind === 'image') return span.alt;
      return span.kind === 'note' ? String(span.number) : ' ';
    })
    .join('')
    .trim();
}
export function parseDocument(raw: string): MarkdownDocument {
  let source = raw.replace(/\r\n?/gu, '\n');
  const doc: MarkdownDocument = { blocks: [], headings: [], notes: [], fields: [], plain: false };
  if (
    source.length > 512 * 1024 ||
    source.split('\n').some((l) => l.length > 32768) ||
    (source.match(/\|/gu)?.length ?? 0) > 8000
  ) {
    doc.plain = true;
    return doc;
  }
  let line = 1;
  const front = /^(---|\+\+\+)[ \t]*\n([\s\S]{0,8192}?)\n(\1|\.\.\.)[ \t]*(?:\n|$)/u.exec(source);
  if (front && (front[1] === '---' || front[1] === front[3])) {
    const metadata = front[2] ?? '';
    const yaml = front[1] === '---';
    const pattern = yaml ? /^([\w.-]+):[ \t]*(.*)$/u : /^([\w.-]+)[ \t]*=[ \t]*(.*)$/u;
    const entries = metadata
      .split('\n')
      .filter((s) => s.trim() && !s.startsWith('#'))
      .map((s) => pattern.exec(s));
    line += lineBreaks(front[0]);
    source = source.slice(front[0].length);
    if (entries.every((m) => m !== null)) doc.fields = entries.map((m) => [m[1] ?? '', m[2] ?? '']);
    else
      doc.blocks.push({
        line: 1,
        end: line - 1,
        block: { kind: 'code', lang: yaml ? 'yaml' : 'toml', text: metadata, complete: true },
      });
  }
  const definitions = new Map<string, Token[]>(),
    numbers = new Map<string, number>();
  const extensions: TokenizerAndRendererExtension[] = [
    ...inlineStyleTokens,
    {
      name: 'fileFormula',
      level: 'block',
      start: (src) => /^ {0,3}\$\$/mu.exec(src)?.index,
      tokenizer(src) {
        const m = blockMath.exec(src);
        if (m) return { type: 'code', lang: 'math', text: (m[1] ?? m[2] ?? '').trim(), raw: m[0] };
        return undefined;
      },
    },
    {
      name: 'fileInlineMath',
      level: 'inline',
      start: (src) => {
        const i = src.indexOf('$');
        return i < 0 ? undefined : i;
      },
      tokenizer(src) {
        const m = inlineMath.exec(src);
        if (m?.[1]?.trim() && m[1].trim() === m[1])
          return { type: 'fileInlineMath', text: m[1], raw: m[0] };
        return undefined;
      },
    },
    {
      name: 'fileNoteDefinition',
      level: 'block',
      start: (src) => /^\[\^[^\]\s]+\]:/mu.exec(src)?.index,
      tokenizer(src) {
        const match = definition.exec(src);
        if (!match?.[1]) return;
        const label = match[1].toLowerCase();
        if (!definitions.has(label))
          definitions.set(
            label,
            this.lexer.blockTokens((match[2] ?? '').replace(/\n(?: {1,4}|\t)/gu, '\n'), []),
          );
        return { type: 'fileNoteDefinition', raw: match[0] };
      },
    },
    {
      name: 'fileNote',
      level: 'inline',
      start: (src) => {
        const i = src.indexOf('[^');
        return i < 0 ? undefined : i;
      },
      tokenizer(src) {
        const m = /^\[\^([^\]\s]+)\]/u.exec(src);
        const label = m?.[1]?.toLowerCase();
        if (m && label && definitions.has(label)) return { type: 'fileNote', raw: m[0], label };
        return undefined;
      },
    },
  ];
  const lexer = new Marked({ gfm: true }, { extensions });
  const tokens = lexer.lexer(source);
  const options: ConvertOptions = {
    documentSpan(token) {
      if (token.type.startsWith('fileStyle-')) {
        const kind = inlineStyles.find((k) => token.type === 'fileStyle-' + k);
        if (kind && 'tokens' in token) return { kind, children: spans(token.tokens, options) };
      }
      if (token.type === 'fileInlineMath' && typeof token.text === 'string')
        return { kind: 'math', text: token.text };
      if (token.type === 'fileNote' && typeof token.label === 'string') {
        const number = numbers.get(token.label) ?? numbers.size + 1;
        numbers.set(token.label, number);
        return { kind: 'note', label: token.label, number };
      }
      return undefined;
    },
  };
  const ids = new Set<string>();
  for (const token of tokens) {
    const start = line;
    line += lineBreaks(token.raw);
    if (token.type === 'fileNoteDefinition') continue;
    const block = toBlocks([token], options)[0];
    if (!block) continue;
    const entry: DocumentBlock = {
      block,
      line: start,
      end: Math.max(start, line - (token.raw.endsWith('\n') ? 1 : 0)),
    };
    if (block.kind === 'heading') {
      const title = headingTitle(block.spans),
        base = headingSlug(title);
      let slug = base,
        n = 0;
      while (ids.has(slug)) slug = base + '-' + String(++n);
      ids.add(slug);
      entry.anchor = slug;
      doc.headings.push({ title, line: start, level: block.level, slug });
    } else if (block.kind === 'blockquote') {
      const first = block.blocks[0],
        span = first?.kind === 'paragraph' ? first.spans[0] : undefined;
      if (first?.kind === 'paragraph' && span?.kind === 'text') {
        const m =
          /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+([^\n]*))?[ \t]*(?:\n|$)/iu.exec(
            span.text,
          );
        if (m) {
          entry.callout = m[1]?.toLowerCase() as Callout;
          if (m[2]?.trim()) entry.calloutTitle = m[2].trim();
          const rest = span.text.slice(m[0].length);
          const lead = first.spans.slice(1);
          if (rest) lead.unshift({ kind: 'text', text: rest });
          entry.block = {
            kind: 'blockquote',
            blocks: [
              ...(lead.length ? [{ kind: 'paragraph' as const, spans: lead }] : []),
              ...block.blocks.slice(1),
            ],
          };
        }
      }
    }
    if (block.kind === 'list' || block.kind === 'blockquote') indexTasks(token.raw, block, start);
    doc.blocks.push(entry);
  }
  for (const [label, number] of numbers) {
    doc.notes.push({ label, number, blocks: toBlocks(definitions.get(label) ?? [], options) });
  }
  return doc;
}
// Markdown Studio's source-line mapping: never edit a fenced example or an ambiguous marker.
function indexTasks(raw: string, block: Block, start: number) {
  const items: ListItem[] = [];
  function collect(node: Block) {
    if (node.kind === 'blockquote') node.blocks.forEach(collect);
    if (node.kind === 'list')
      for (const item of node.items) {
        if (item.checked !== null) items.push(item);
        item.blocks.forEach(collect);
      }
  }
  collect(block);
  if (!items.length) return;
  const marks: { line: number; checked: boolean }[] = [];
  let fence = '';
  raw.split('\n').forEach((line, i) => {
    const body = line.replace(/^(?:\s*>\s?)+/u, '');
    const match = /^\s*(`{3,}|~{3,})(.*)$/u.exec(body);
    if (match?.[1]) {
      if (!fence) fence = match[1];
      else if (match[1].startsWith(fence) && !match[2]?.trim()) fence = '';
      return;
    }
    const marker = !fence && taskMarker.exec(line);
    if (marker) marks.push({ line: start + i, checked: marker[2] !== ' ' });
  });
  if (
    items.length === marks.length &&
    items.every((item, i) => item.checked === marks[i]?.checked)
  ) {
    for (const [i, item] of items.entries()) {
      const mark = marks[i];
      if (mark) item.sourceLine = mark.line;
    }
  }
}
