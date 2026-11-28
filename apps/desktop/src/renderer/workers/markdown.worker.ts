// Markdown worker (architecture section 8.4): parses transcript items off the main thread.
// Streaming items are parsed incrementally on every append and answered at once; finished
// items queue up and are parsed in slices of `SLICE_MS`, so appends are never stuck behind a
// long history.
import { IncrementalMarkdown, parseMarkdown } from '../transcript/markdown/incremental.js';
import {
  isMarkdownRequest,
  type DocUpdate,
  type MarkdownResponse,
} from '../transcript/markdown/protocol.js';

/** Longest stretch of history parsing before the worker yields to queued messages. */
const SLICE_MS = 8;

const streaming = new Map<string, IncrementalMarkdown>();
const queue: { docId: string; text: string }[] = [];
let draining = false;

function post(message: MarkdownResponse): void {
  self.postMessage(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function append(docId: string, chunk: string, final: boolean): void {
  let document = streaming.get(docId);
  if (document === undefined) {
    document = new IncrementalMarkdown();
    streaming.set(docId, document);
  }
  try {
    const { keep, blocks } = document.append(chunk, final);
    post({ type: 'updates', updates: [{ docId, keep, blocks, final }] });
  } catch (error) {
    post({ type: 'error', docId, message: errorMessage(error) });
  }
  if (final) {
    streaming.delete(docId);
  }
}

function drain(): void {
  const started = performance.now();
  const updates: DocUpdate[] = [];
  while (queue.length > 0 && performance.now() - started < SLICE_MS) {
    const next = queue.shift();
    if (next === undefined) {
      break;
    }
    try {
      updates.push({ docId: next.docId, keep: 0, blocks: parseMarkdown(next.text), final: true });
    } catch (error) {
      post({ type: 'error', docId: next.docId, message: errorMessage(error) });
    }
  }
  if (updates.length > 0) {
    post({ type: 'updates', updates });
  }
  if (queue.length > 0) {
    setTimeout(drain, 0);
  } else {
    draining = false;
  }
}

self.addEventListener('message', (event: MessageEvent) => {
  const request: unknown = event.data;
  if (!isMarkdownRequest(request)) {
    console.error('[markdown worker] ignored a malformed request');
    return;
  }
  switch (request.type) {
    case 'append':
      append(request.docId, request.chunk, request.final);
      break;
    case 'parse':
      queue.push(...request.docs);
      if (!draining) {
        draining = true;
        setTimeout(drain, 0);
      }
      break;
    case 'drop': {
      const dropped = new Set(request.docIds);
      for (const docId of dropped) {
        streaming.delete(docId);
      }
      const remaining = queue.filter((doc) => !dropped.has(doc.docId));
      queue.splice(0, queue.length, ...remaining);
      break;
    }
  }
});
