import { parseDocument } from './document-model.js';
import type { Heading, MarkdownDocument } from './document-model.js';
export interface ParseReply {
  sequence: number;
  document?: MarkdownDocument;
  headings?: readonly Heading[];
  error?: string;
}
let cached: { text: string; document: MarkdownDocument } | undefined;
self.onmessage = (e: MessageEvent<{ sequence: number; text: string; outlineOnly?: boolean }>) => {
  const { sequence, text, outlineOnly } = e.data;
  try {
    if (cached?.text !== text) cached = { text, document: parseDocument(text) };
    const document = cached.document;
    self.postMessage(
      outlineOnly
        ? ({ sequence, headings: document.headings } satisfies ParseReply)
        : ({ sequence, document } satisfies ParseReply),
    );
  } catch (error) {
    self.postMessage({
      sequence,
      error: error instanceof Error ? error.message : String(error),
    } satisfies ParseReply);
  }
};
