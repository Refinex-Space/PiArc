// `Edit` with `replaceAll`: every exact occurrence of each `oldText` is replaced (architecture
// section 6.1.2, "唯一匹配": unique, or replace-all when asked for explicitly). Pi's edit only
// replaces unique matches, so this path does the matching itself: exact matches on the text with
// line endings normalized to LF, spliced back into the original so untouched lines keep their
// line endings, the byte order mark kept.
//
// `applyToOriginal` and `lineEndingAt` are ported from Pi v1.5.2
// `packages/coding-agent/src/core/tools/edit-diff.ts` (`applyReplacementsToOriginal`,
// `getLineEndingAt`), MIT License, Copyright (c) 2025 Mario Zechner. Changed: types and names.

/** One replacement in the LF-normalized text. */
export interface Replacement {
  readonly matchIndex: number;
  readonly matchLength: number;
  readonly newText: string;
}

/** The text of a file after `edits`, each `oldText` replaced wherever it occurs. */
export function replaceAll(
  raw: string,
  edits: readonly { readonly oldText: string; readonly newText: string }[],
  path: string,
): { text: string; count: number } {
  const bom = raw.startsWith('﻿') ? '﻿' : '';
  const content = raw.slice(bom.length);
  const normalized = toLF(content);
  const replacements: (Replacement & { readonly edit: number })[] = [];
  edits.forEach((edit, index) => {
    const oldText = toLF(edit.oldText);
    const label = edits.length === 1 ? 'oldText' : `edits[${String(index)}].oldText`;
    if (oldText === '') {
      throw new Error(`${label} must not be empty in ${path}.`);
    }
    let from = 0;
    let found = 0;
    for (;;) {
      const at = normalized.indexOf(oldText, from);
      if (at === -1) {
        break;
      }
      replacements.push({
        matchIndex: at,
        matchLength: oldText.length,
        newText: toLF(edit.newText),
        edit: index,
      });
      found += 1;
      from = at + oldText.length;
    }
    if (found === 0) {
      throw new Error(
        `Could not find ${label} in ${path}. With replaceAll the text must still match exactly, ` +
          'including whitespace and line breaks.',
      );
    }
  });
  replacements.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < replacements.length; i++) {
    const previous = replacements[i - 1];
    const current = replacements[i];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.matchIndex + previous.matchLength > current.matchIndex
    ) {
      throw new Error(
        `edits[${String(previous.edit)}] and edits[${String(current.edit)}] overlap in ${path}. ` +
          'Merge them into one edit or target disjoint text.',
      );
    }
  }
  const replaced = applyInOrder(normalized, replacements);
  if (replaced === normalized) {
    throw new Error(`No changes made to ${path}: the replacements produce identical content.`);
  }
  const text = content === normalized ? replaced : applyToOriginal(content, replacements);
  return { text: bom + text, count: replacements.length };
}

function toLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function applyInOrder(content: string, replacements: readonly Replacement[]): string {
  let result = '';
  let position = 0;
  for (const replacement of replacements) {
    result += content.slice(position, replacement.matchIndex) + replacement.newText;
    position = replacement.matchIndex + replacement.matchLength;
  }
  return result + content.slice(position);
}

/**
 * Applies replacements matched in the LF-normalized form of `original` to `original` itself:
 * text outside the replaced ranges keeps its bytes and line endings, line breaks of the new text
 * get the line ending of the line where the replacement starts.
 */
export function applyToOriginal(original: string, replacements: readonly Replacement[]): string {
  // Only CRLF changes length when normalizing: the LF of the n-th CRLF (at original offset p) is
  // at p - n in the normalized text.
  let crlfBefore = 0;
  let nextCrlf = original.indexOf('\r\n');
  const toOriginal = (offset: number): number => {
    while (nextCrlf !== -1 && nextCrlf - crlfBefore < offset) {
      crlfBefore++;
      nextCrlf = original.indexOf('\r\n', nextCrlf + 2);
    }
    return offset + crlfBefore;
  };
  const parts: string[] = [];
  let endsWithCr = false;
  const push = (part: string): void => {
    if (part.length === 0) return;
    // A CR before a seam and an LF after it would merge into one CRLF line break.
    if (endsWithCr && part.startsWith('\n')) parts.push('\n');
    parts.push(part);
    endsWithCr = part.endsWith('\r');
  };
  let position = 0;
  for (const replacement of replacements) {
    const start = toOriginal(replacement.matchIndex);
    push(original.slice(position, start));
    const ending = lineEndingAt(original, start);
    push(ending === '\n' ? replacement.newText : replacement.newText.replaceAll('\n', ending));
    position = toOriginal(replacement.matchIndex + replacement.matchLength);
  }
  push(original.slice(position));
  return parts.join('');
}

/** Line ending of the line containing `offset` (its own, or the previous line's at the end). */
function lineEndingAt(content: string, offset: number): string {
  let lineFeed = content.indexOf('\n', offset);
  if (lineFeed === -1) lineFeed = content.lastIndexOf('\n', offset);
  if (lineFeed === -1) return content.includes('\r') ? '\r' : '\n';
  return content[lineFeed - 1] === '\r' ? '\r\n' : '\n';
}
