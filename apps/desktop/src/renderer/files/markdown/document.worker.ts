import { parseDocument } from './document-model.js';
import type { MarkdownDocument } from './document-model.js';
export interface ParseReply {
  sequence: number;
  document?: MarkdownDocument;
  error?: string;
}
self.onmessage = (e: MessageEvent<{ sequence: number; text: string }>) => {
  const { sequence, text } = e.data;
  try {
    self.postMessage({ sequence, document: parseDocument(text) } satisfies ParseReply);
  } catch (error) {
    self.postMessage({
      sequence,
      error: error instanceof Error ? error.message : String(error),
    } satisfies ParseReply);
  }
};
