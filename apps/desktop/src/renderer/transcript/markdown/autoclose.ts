// Closing markup that is still open in the last block of a streaming message (architecture
// section 8.4): an unfinished code fence, code span, emphasis or link target would otherwise
// render as literal markers and flip to formatted text when the closer arrives. The parser
// applies this to the unstable tail only, and never to a finished message.

/** The tail with closers appended, and whether a code fence had to be closed. */
export interface ClosedMarkup {
  readonly text: string;
  readonly openFence: boolean;
}

/** A fence line, possibly inside block quotes or a list item. */
const FENCE_LINE = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?[ \t>]*(`{3,}|~{3,})(.*)$/;

/** The fence that would close the code block still open at the end of `text`, or `null`. */
export function openFence(text: string): string | null {
  let open: { readonly char: string; readonly length: number } | null = null;
  for (const line of text.split('\n')) {
    const match = FENCE_LINE.exec(line);
    const run = match?.[1];
    const rest = match?.[2] ?? '';
    if (run === undefined) {
      continue;
    }
    const char = run.charAt(0);
    if (open === null) {
      // A backtick fence's info string may not contain backticks (CommonMark 4.5).
      if (char === '`' && rest.includes('`')) {
        continue;
      }
      open = { char, length: run.length };
    } else if (char === open.char && run.length >= open.length && rest.trim() === '') {
      open = null;
    }
  }
  return open === null ? null : open.char.repeat(open.length);
}

const WHITESPACE = /\s/u;
const PUNCTUATION = /[\p{P}\p{S}]/u;

interface Delimiter {
  readonly char: string;
  readonly length: number;
  /** Index just past the run. */
  readonly end: number;
}

/** Left- and right-flanking per CommonMark 6.2, decided from the characters around the run. */
function flanking(before: string, after: string): { left: boolean; right: boolean } {
  const beforeSpace = before === '' || WHITESPACE.test(before);
  const afterSpace = after === '' || WHITESPACE.test(after);
  const beforePunct = PUNCTUATION.test(before);
  const afterPunct = PUNCTUATION.test(after);
  return {
    left: !afterSpace && (!afterPunct || beforeSpace || beforePunct),
    right: !beforeSpace && (!beforePunct || afterSpace || afterPunct),
  };
}

/**
 * Closers for the inline markup left open at the end of `segment` (one paragraph-like run):
 * an open code span first, then an unfinished link target, then emphasis, strong and
 * strikethrough, innermost first. An opener with nothing after it is left alone.
 */
export function inlineClosers(segment: string): string {
  const stack: Delimiter[] = [];
  let codeTicks = 0;
  let index = 0;
  while (index < segment.length) {
    const char = segment.charAt(index);
    if (codeTicks === 0 && char === '\\') {
      index += 2;
      continue;
    }
    if (char === '`') {
      let run = 1;
      while (segment.charAt(index + run) === '`') {
        run += 1;
      }
      if (codeTicks === 0) {
        codeTicks = run;
      } else if (run === codeTicks) {
        codeTicks = 0;
      }
      index += run;
      continue;
    }
    if (codeTicks !== 0 || (char !== '*' && char !== '_' && char !== '~')) {
      index += 1;
      continue;
    }
    let run = 1;
    while (segment.charAt(index + run) === char) {
      run += 1;
    }
    const before = segment.charAt(index - 1);
    const after = segment.charAt(index + run);
    const { left, right } = flanking(before, after);
    const canOpen = char === '_' ? left && (!right || PUNCTUATION.test(before)) : left;
    const canClose = char === '_' ? right && (!left || PUNCTUATION.test(after)) : right;
    // Three or more tildes are not strikethrough.
    const counts = char !== '~' || run <= 2;
    let closed = false;
    if (counts && canClose) {
      for (let position = stack.length - 1; position >= 0; position -= 1) {
        if (stack[position]?.char === char) {
          // Openers above the match stay literal, as in CommonMark's delimiter algorithm.
          stack.length = position;
          closed = true;
          break;
        }
      }
    }
    if (counts && !closed && canOpen) {
      stack.push({ char, length: run, end: index + run });
    }
    index += run;
  }

  let closers = '';
  if (codeTicks !== 0) {
    closers += '`'.repeat(codeTicks);
  } else if (/\[[^\]\n]*\]\([^)\s]*$/u.test(segment)) {
    closers += ')';
  }
  for (let position = stack.length - 1; position >= 0; position -= 1) {
    const opener = stack[position];
    if (opener !== undefined && segment.slice(opener.end).trim() !== '') {
      closers += opener.char.repeat(opener.length);
    }
  }
  return closers;
}

/**
 * Closes whatever markup is open at the end of `tail` (the unstable last block of a streaming
 * message). An open fence gets its closing fence and nothing else, since everything after it
 * is code; otherwise the last paragraph-like run gets its inline closers, inserted before any
 * trailing whitespace.
 */
export function closeOpenMarkup(tail: string): ClosedMarkup {
  const fence = openFence(tail);
  if (fence !== null) {
    return { text: `${tail}${tail.endsWith('\n') ? '' : '\n'}${fence}\n`, openFence: true };
  }
  const trimmed = tail.trimEnd();
  const lastBlank = trimmed.search(/\n[ \t]*\n(?![\s\S]*\n[ \t]*\n)/u);
  const segment = lastBlank === -1 ? trimmed : trimmed.slice(lastBlank);
  // An indented code block at the end takes no inline markup.
  const lines = segment.split('\n').filter((line) => line.trim() !== '');
  if (lines.length > 0 && lines.every((line) => /^(?: {4}|\t)/u.test(line))) {
    return { text: tail, openFence: false };
  }
  const closers = inlineClosers(segment);
  if (closers === '') {
    return { text: tail, openFence: false };
  }
  return { text: `${trimmed}${closers}${tail.slice(trimmed.length)}`, openFence: false };
}
