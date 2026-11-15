// Incremental Markdown parsing for streaming messages (architecture section 8.4). The text is
// split into a stable prefix of top-level blocks that later text can no longer change, and an
// unstable tail that is lexed again on every update. Only the tail is re-parsed; while the
// message streams, markup left open in the tail is closed first (autoclose.ts).
//
// Where the tail starts: a top-level block becomes stable once a later block has started and
// that later block's first line is complete. A block's extent only depends on the lines up to
// the first line of the next block, so appending text cannot change it any more. The one
// non-local construct is a link reference definition, which can turn text in an earlier block
// into a link; when the message had any, the final update parses the whole text once more so
// the finished message always equals a one-shot parse.
import { Lexer, type Links, type Token, type Tokens } from 'marked';

import { closeOpenMarkup } from './autoclose.js';
import type { Block } from './ir.js';
import { isMarkedToken, toBlocks } from './to-ir.js';

/** Lexer options: GitHub Flavored Markdown, no soft-break-to-<br> conversion. */
const LEXER_OPTIONS = { gfm: true, breaks: false } as const;

/** What changed since the previous update: keep the first `keep` blocks, then `blocks`. */
export interface ParseUpdate {
  readonly keep: number;
  readonly blocks: readonly Block[];
}

/** How much text the last update lexed, for tests and measurements. */
export interface ParseStats {
  /** Offset in the message where lexing started. */
  readonly lexedFrom: number;
  /** Characters lexed, including closers added by autoclose. */
  readonly lexedChars: number;
}

/** Parses `text` in one go, the way a finished message is parsed. */
export function parseMarkdown(text: string): Block[] {
  return toBlocks(Lexer.lex(normalizeLineEndings(text), LEXER_OPTIONS));
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/gu, '\n');
}

function lex(text: string, links: Links): Token[] {
  const lexer = new Lexer(LEXER_OPTIONS);
  Object.assign(lexer.tokens.links, links);
  return lexer.lex(text);
}

/** The code block a token ends with, searched through block quotes and list items. */
function lastFencedCode(token: Token): Tokens.Code | null {
  if (!isMarkedToken(token)) {
    return null;
  }
  switch (token.type) {
    case 'code':
      return token.codeBlockStyle === 'indented' ? null : token;
    case 'blockquote':
      return lastFencedCodeOf(token.tokens);
    case 'list':
      return lastFencedCodeOf(token.items.at(-1)?.tokens ?? []);
    default:
      return null;
  }
}

function lastFencedCodeOf(tokens: readonly Token[]): Tokens.Code | null {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token !== undefined && token.type !== 'space') {
      return lastFencedCode(token);
    }
  }
  return null;
}

/** True when a fenced code token's raw text ends with its closing fence. */
export function hasClosingFence(raw: string): boolean {
  const lines = raw.replace(/\n+$/u, '').split('\n');
  const opening = /^[ \t>]*(`{3,}|~{3,})/u.exec(lines[0] ?? '')?.[1];
  const last = lines.at(-1);
  if (opening === undefined || lines.length < 2 || last === undefined) {
    return false;
  }
  const closing = last.replace(/^[ \t>]*/u, '').trimEnd();
  const char = opening.charAt(0);
  return closing.length >= opening.length && closing === char.repeat(closing.length);
}

export class IncrementalMarkdown {
  private text = '';
  private pendingCarriageReturn = false;
  private finished = false;
  /** Offset where the unstable tail starts. */
  private stableEnd = 0;
  private stableBlocks: Block[] = [];
  private tailBlocks: Block[] = [];
  /** Reference definitions found in the stable prefix. */
  private readonly links: Links = {};
  private sawDefinition = false;
  private lastStats: ParseStats = { lexedFrom: 0, lexedChars: 0 };

  /** Appends `chunk`; `final` marks the end of the message (no more appends). */
  append(chunk: string, final = false): ParseUpdate {
    if (this.finished) {
      throw new Error('The message is already final');
    }
    let added = (this.pendingCarriageReturn ? '\r' : '') + chunk;
    this.pendingCarriageReturn = !final && added.endsWith('\r');
    if (this.pendingCarriageReturn) {
      added = added.slice(0, -1);
    }
    this.text += normalizeLineEndings(added);
    this.finished = final;
    return this.update();
  }

  /** All blocks of the message as of the last update. */
  blocks(): Block[] {
    return [...this.stableBlocks, ...this.tailBlocks];
  }

  get stats(): ParseStats {
    return this.lastStats;
  }

  get length(): number {
    return this.text.length;
  }

  private update(): ParseUpdate {
    const keep = this.stableBlocks.length;
    const tail = this.text.slice(this.stableEnd);
    const closed = this.finished ? { text: tail, openFence: false } : closeOpenMarkup(tail);
    const tokens = lex(closed.text, this.links);
    this.lastStats = { lexedFrom: this.stableEnd, lexedChars: closed.text.length };
    if (tokens.some((token) => token.type === 'def')) {
      this.sawDefinition = true;
    }

    if (this.finished) {
      if (this.sawDefinition && this.stableEnd > 0) {
        // A definition may resolve references in blocks that became stable before it arrived.
        this.stableBlocks = [];
        this.stableEnd = 0;
        this.tailBlocks = parseMarkdown(this.text);
        this.lastStats = { lexedFrom: 0, lexedChars: this.text.length };
        return { keep: 0, blocks: this.tailBlocks };
      }
      this.tailBlocks = toBlocks(tokens);
      return { keep, blocks: this.tailBlocks };
    }

    const boundary = this.stableBoundary(tokens, tail, closed.text);
    let offset = 0;
    for (const token of tokens.slice(0, boundary)) {
      offset += token.raw.length;
      if (isMarkedToken(token) && token.type === 'def') {
        this.links[token.tag] ??= { href: token.href, title: token.title };
      }
    }
    this.stableBlocks.push(...toBlocks(tokens.slice(0, boundary)));
    this.stableEnd += offset;

    const unstable = tokens.slice(boundary);
    const lastCode = lastFencedCodeOf(unstable);
    const open =
      lastCode !== null && (closed.openFence || !hasClosingFence(lastCode.raw)) ? lastCode : null;
    this.tailBlocks = toBlocks(unstable, { isIncomplete: (token) => token === open });
    return { keep, blocks: [...this.stableBlocks.slice(keep), ...this.tailBlocks] };
  }

  /**
   * How many leading tokens of the tail are stable: everything before the last block that has
   * started, or before the one ahead of it while the last block's first line is incomplete.
   */
  private stableBoundary(tokens: readonly Token[], tail: string, lexed: string): number {
    const starts: number[] = [];
    let offset = 0;
    for (const token of tokens) {
      starts.push(offset);
      offset += token.raw.length;
    }
    const blockIndexes = tokens.flatMap((token, index) => (token.type === 'space' ? [] : [index]));
    let candidate = blockIndexes.length - 1;
    const lastIndex = blockIndexes[candidate];
    if (lastIndex === undefined) {
      return 0;
    }
    if (!tail.includes('\n', starts[lastIndex])) {
      candidate -= 1;
    }
    const boundary = blockIndexes[candidate];
    if (boundary === undefined) {
      return 0;
    }
    const start = starts[boundary] ?? 0;
    // Autoclose only appends at the end; the stable part must be the received text verbatim.
    return lexed.slice(0, start) === tail.slice(0, start) ? boundary : 0;
  }
}
