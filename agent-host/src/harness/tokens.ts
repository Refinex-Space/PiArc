// The one token estimate of the Harness Kit (T27, ADR-0043): context usage by category and
// the limits of what is given back after a compaction count with it. Same heuristic as Pi
// 1.5.2's `estimateTokens` (characters / 4 rounded up, an image as 4,800 characters), so the
// usage the client shows and Pi's compaction threshold agree.
import { isObject } from '../runtime/items.js';

/** Characters an image counts as. */
export const IMAGE_CHARS = 4800;

/** Tokens of `chars` characters. */
export function tokensOfChars(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Tokens of a text. */
export function estimateTokens(text: string): number {
  return tokensOfChars(text.length);
}

/** Characters of message content: text blocks, thinking, tool calls (name and arguments),
 * images. */
export function contentChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') chars += block.text.length;
    else if (block.type === 'thinking' && typeof block.thinking === 'string')
      chars += block.thinking.length;
    else if (block.type === 'image') chars += IMAGE_CHARS;
    else if (block.type === 'toolCall' && typeof block.name === 'string')
      chars += block.name.length + JSON.stringify(block.arguments ?? {}).length;
  }
  return chars;
}

/** `text` cut so that it and a note of what was left out stay within `maxTokens` tokens. */
export function truncateToTokens(
  text: string,
  maxTokens: number,
  note: (omittedTokens: number) => string,
): { readonly text: string; readonly truncated: boolean } {
  const total = estimateTokens(text);
  if (total <= maxTokens) return { text, truncated: false };
  // The note's length barely depends on the number in it: size it for the whole text.
  const room = Math.max(0, maxTokens * 4 - note(total).length - 1);
  let end = Math.min(room, text.length);
  // Never between the two halves of a surrogate pair.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  const kept = text.slice(0, end);
  return { text: `${kept}\n${note(total - estimateTokens(kept))}`, truncated: true };
}
