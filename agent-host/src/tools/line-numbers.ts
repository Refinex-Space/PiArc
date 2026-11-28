// Line numbers for `Read` (architecture section 6.1.4): every line of the file gets its number,
// right-aligned in six columns and followed by a tab, as `cat -n` prints them. The numbering is
// a transform of the text stream Pi's read tool selects lines from, so Pi's line selection,
// truncation and notices stay as they are and count the same lines.
//
// A line is numbered when it has content or ends with a line break; the empty remainder after a
// final line break is not a line (as with `cat -n`). A byte order mark at the start of the file
// is dropped from the numbered text.

/** The prefix of line `n`. */
export function lineNumberPrefix(n: number): string {
  return `${String(n).padStart(6)}\t`;
}

/** Numbers the lines of a text that arrives in pieces. */
export class LineNumberer {
  #next = 1;
  #atLineStart = true;
  #first = true;

  /** The next piece of text with numbers inserted. */
  push(text: string): string {
    let piece = text;
    if (this.#first && piece.length > 0) {
      this.#first = false;
      if (piece.startsWith('﻿')) {
        piece = piece.slice(1);
      }
    }
    let out = '';
    let position = 0;
    while (position < piece.length) {
      if (this.#atLineStart) {
        out += lineNumberPrefix(this.#next);
        this.#atLineStart = false;
      }
      const lineFeed = piece.indexOf('\n', position);
      if (lineFeed === -1) {
        out += piece.slice(position);
        break;
      }
      out += piece.slice(position, lineFeed + 1);
      this.#next += 1;
      this.#atLineStart = true;
      position = lineFeed + 1;
    }
    return out;
  }
}

/** `chunks` (UTF-8 text) with every line numbered. */
export async function* numberedChunks(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const numberer = new LineNumberer();
  for await (const chunk of chunks) {
    const text = numberer.push(decoder.decode(chunk, { stream: true }));
    if (text.length > 0) {
      yield Buffer.from(text, 'utf8');
    }
  }
  const rest = numberer.push(decoder.decode());
  if (rest.length > 0) {
    yield Buffer.from(rest, 'utf8');
  }
}

/** A whole text with every line numbered. */
export function numberedText(text: string): string {
  return new LineNumberer().push(text);
}
