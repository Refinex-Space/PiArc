// marked tokens → the block and span structure of ir.ts. Only the lexer of marked is used; its
// HTML renderer never runs. Raw HTML becomes `html` nodes shown as text, link targets go
// through `safeHref`, and character references are decoded here (marked leaves them as
// written because its own renderer outputs HTML).
import type { MarkedToken, Token, Tokens } from 'marked';

import type { Align, Block, ListItem, Span } from './ir.js';
import { decodeCharacterReferences, safeHref } from './text.js';

const MARKED_TYPES: ReadonlySet<string> = new Set<MarkedToken['type']>([
  'blockquote',
  'br',
  'checkbox',
  'code',
  'codespan',
  'def',
  'del',
  'em',
  'escape',
  'heading',
  'hr',
  'html',
  'image',
  'link',
  'list',
  'list_item',
  'paragraph',
  'space',
  'strong',
  'table',
  'text',
]);

/** Tokens of marked's own types (extensions, which PiArc does not register, are excluded). */
export function isMarkedToken(token: Token): token is MarkedToken {
  return MARKED_TYPES.has(token.type);
}

/** Converts tokens to blocks; `isIncomplete` names the code token whose fence is still open. */
export interface ConvertOptions {
  readonly isIncomplete?: (token: Tokens.Code) => boolean;
}

function spans(tokens: readonly Token[] | undefined): Span[] {
  const result: Span[] = [];
  const push = (span: Span): void => {
    // Merge neighbouring text so React renders fewer nodes.
    const last = result.at(-1);
    if (span.kind === 'text' && last?.kind === 'text') {
      result[result.length - 1] = { kind: 'text', text: last.text + span.text };
    } else {
      result.push(span);
    }
  };
  for (const token of tokens ?? []) {
    // A text token can wrap further inline tokens (marked does this in tight list items).
    if (token.type === 'text' && token.tokens !== undefined && token.tokens.length > 0) {
      spans(token.tokens).forEach(push);
      continue;
    }
    const span = toSpan(token);
    if (span !== null) {
      push(span);
    }
  }
  return result;
}

function toSpan(token: Token): Span | null {
  if (!isMarkedToken(token)) {
    return { kind: 'text', text: token.raw };
  }
  switch (token.type) {
    case 'text':
      return { kind: 'text', text: decodeCharacterReferences(token.text) };
    case 'escape':
      return { kind: 'text', text: token.text };
    case 'strong':
      return { kind: 'strong', children: spans(token.tokens) };
    case 'em':
      return { kind: 'emphasis', children: spans(token.tokens) };
    case 'del':
      return { kind: 'delete', children: spans(token.tokens) };
    case 'codespan':
      return { kind: 'code', text: token.text };
    case 'br':
      return { kind: 'break' };
    case 'link':
      return {
        kind: 'link',
        href: safeHref(token.href),
        title:
          token.title === undefined || token.title === null
            ? null
            : decodeCharacterReferences(token.title),
        children: spans(token.tokens),
      };
    case 'image':
      return {
        kind: 'image',
        href: safeHref(token.href),
        alt: decodeCharacterReferences(token.text),
        title: token.title === null ? null : decodeCharacterReferences(token.title),
      };
    case 'html':
      return { kind: 'html', text: token.text };
    case 'checkbox':
      return null;
    default:
      // A block token in inline position cannot come out of marked's inline lexer.
      return { kind: 'text', text: token.raw };
  }
}

function align(value: Tokens.TableCell['align']): Align {
  return value;
}

function listStart(start: number | ''): number {
  return start === '' ? 1 : start;
}

/** Converts block tokens; `space` and link definitions produce nothing. */
export function toBlocks(tokens: readonly Token[], options: ConvertOptions = {}): Block[] {
  const blocks: Block[] = [];
  for (const token of tokens) {
    const block = toBlock(token, options);
    if (block !== null) {
      blocks.push(block);
    }
  }
  return blocks;
}

function toBlock(token: Token, options: ConvertOptions): Block | null {
  if (!isMarkedToken(token)) {
    return { kind: 'paragraph', spans: [{ kind: 'text', text: token.raw }] };
  }
  switch (token.type) {
    // `checkbox` is the task marker of a list item; the item's `checked` carries it.
    case 'space':
    case 'def':
    case 'checkbox':
      return null;
    case 'paragraph':
      return { kind: 'paragraph', spans: spans(token.tokens) };
    case 'text':
      // Block-level text: the content of a tight list item.
      return {
        kind: 'paragraph',
        spans:
          token.tokens === undefined
            ? [{ kind: 'text', text: decodeCharacterReferences(token.text) }]
            : spans(token.tokens),
      };
    case 'heading':
      return { kind: 'heading', level: token.depth, spans: spans(token.tokens) };
    case 'code': {
      const info = token.lang?.trim().split(/\s+/u)[0] ?? '';
      return {
        kind: 'code',
        lang: info === '' ? null : decodeCharacterReferences(info),
        text: token.text,
        complete: !(options.isIncomplete?.(token) ?? false),
      };
    }
    case 'blockquote':
      return { kind: 'blockquote', blocks: toBlocks(token.tokens, options) };
    case 'list':
      return {
        kind: 'list',
        ordered: token.ordered,
        start: listStart(token.start),
        loose: token.loose,
        items: token.items.map((item): ListItem => ({
          checked: item.task ? (item.checked ?? false) : null,
          blocks: toBlocks(item.tokens, options),
        })),
      };
    case 'table':
      return {
        kind: 'table',
        align: token.align.map(align),
        header: token.header.map((cell) => spans(cell.tokens)),
        rows: token.rows.map((row) => row.map((cell) => spans(cell.tokens))),
      };
    case 'hr':
      return { kind: 'rule' };
    case 'html':
      return { kind: 'html', text: token.text.replace(/\n+$/u, '') };
    default:
      // Inline token types cannot appear at block level in marked's output.
      return { kind: 'paragraph', spans: [{ kind: 'text', text: token.raw }] };
  }
}
