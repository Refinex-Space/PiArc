// Messages between the renderer and the Markdown worker (src/renderer/workers/markdown.worker.ts).
// A document is one transcript item, identified by its item id. Streaming items are appended
// to; finished items are parsed in one go, many per message.
import type { Block } from './ir.js';

export type MarkdownRequest =
  /** Appends to a streaming document (created on first use); `final` ends it. */
  | {
      readonly type: 'append';
      readonly docId: string;
      readonly chunk: string;
      readonly final: boolean;
    }
  /** Parses finished documents, in the given order. */
  | { readonly type: 'parse'; readonly docs: readonly { docId: string; text: string }[] }
  /** Forgets documents. */
  | { readonly type: 'drop'; readonly docIds: readonly string[] };

/** New blocks of one document: keep its first `keep` blocks, then `blocks`. */
export interface DocUpdate {
  readonly docId: string;
  readonly keep: number;
  readonly blocks: readonly Block[];
  /** The document will not change any more. */
  readonly final: boolean;
}

export type MarkdownResponse =
  | { readonly type: 'updates'; readonly updates: readonly DocUpdate[] }
  | { readonly type: 'error'; readonly docId: string; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Shape check for messages from the worker. The worker is part of this bundle, so the check
 * covers the envelope only; the blocks are the worker's own output.
 */
export function isMarkdownResponse(value: unknown): value is MarkdownResponse {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === 'updates') {
    return (
      Array.isArray(value.updates) &&
      value.updates.every(
        (update: unknown) =>
          isRecord(update) &&
          typeof update.docId === 'string' &&
          typeof update.keep === 'number' &&
          Array.isArray(update.blocks) &&
          typeof update.final === 'boolean',
      )
    );
  }
  return value.type === 'error' && typeof value.docId === 'string';
}

/** Shape check for messages to the worker. */
export function isMarkdownRequest(value: unknown): value is MarkdownRequest {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.type) {
    case 'append':
      return (
        typeof value.docId === 'string' &&
        typeof value.chunk === 'string' &&
        typeof value.final === 'boolean'
      );
    case 'parse':
      return (
        Array.isArray(value.docs) &&
        value.docs.every(
          (doc: unknown) =>
            isRecord(doc) && typeof doc.docId === 'string' && typeof doc.text === 'string',
        )
      );
    case 'drop':
      return (
        Array.isArray(value.docIds) &&
        value.docIds.every((docId: unknown) => typeof docId === 'string')
      );
    default:
      return false;
  }
}

/** Applies an update to the blocks a client holds; kept blocks stay the same objects. */
export function applyUpdate(blocks: readonly Block[], update: DocUpdate): readonly Block[] {
  if (update.keep === blocks.length && update.blocks.length === 0) {
    return blocks;
  }
  return [...blocks.slice(0, update.keep), ...update.blocks];
}
