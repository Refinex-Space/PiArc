// Messages between the renderer and the highlight worker (src/renderer/workers/highlight.worker.ts).
// Results are structured tokens, never HTML.

/** One run of code with its colors in the light and dark themes. */
export interface HighlightToken {
  readonly text: string;
  readonly light: string | null;
  readonly dark: string | null;
  /** shiki's FontStyle bits: 1 italic, 2 bold, 4 underline, 8 strikethrough. */
  readonly fontStyle: number;
}

/** The highlighted lines of a code block, in order. */
export type HighlightLines = readonly (readonly HighlightToken[])[];

export interface HighlightRequest {
  readonly type: 'highlight';
  readonly id: number;
  /** A shiki language id from languages.ts. */
  readonly language: string;
  readonly code: string;
}

export type HighlightResponse =
  | { readonly type: 'highlighted'; readonly id: number; readonly lines: HighlightLines }
  | { readonly type: 'failed'; readonly id: number; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isHighlightRequest(value: unknown): value is HighlightRequest {
  return (
    isRecord(value) &&
    value.type === 'highlight' &&
    typeof value.id === 'number' &&
    typeof value.language === 'string' &&
    typeof value.code === 'string'
  );
}

/** Envelope check; the lines are the worker's own output. */
export function isHighlightResponse(value: unknown): value is HighlightResponse {
  if (!isRecord(value) || typeof value.id !== 'number') {
    return false;
  }
  return (
    (value.type === 'highlighted' && Array.isArray(value.lines)) ||
    (value.type === 'failed' && typeof value.message === 'string')
  );
}
