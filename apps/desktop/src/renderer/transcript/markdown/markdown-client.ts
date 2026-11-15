// Renderer side of the Markdown worker: holds the parsed blocks of each transcript item and lets
// React components subscribe per item (`useSyncExternalStore`). Streaming items send only what
// was added since the last call and keep at most one request in flight, so the worker never
// falls behind; finished items are batched into one parse request per task.
import type { Block } from './ir.js';
import {
  applyUpdate,
  isMarkdownResponse,
  type DocUpdate,
  type MarkdownRequest,
} from './protocol.js';

/** The parsed form of one item. */
export interface ParsedDoc {
  readonly blocks: readonly Block[];
  /** The item's text is complete and fully parsed. */
  readonly final: boolean;
}

/** The part of `Worker` the client uses; tests pass a fake. */
export interface MarkdownWorkerPort {
  postMessage(message: MarkdownRequest): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

interface DocState {
  parsed: ParsedDoc | undefined;
  readonly listeners: Set<() => void>;
  /** Characters of the streaming text sent to the worker. */
  sent: number;
  inFlight: boolean;
  /** Text added while a request was in flight. */
  pending: string;
  finalPending: boolean;
  finalSent: boolean;
  /** A one-shot parse was requested. */
  requested: boolean;
}

export class MarkdownClient {
  private readonly docs = new Map<string, DocState>();
  private batch: { docId: string; text: string }[] = [];
  private batchScheduled = false;

  constructor(private readonly worker: MarkdownWorkerPort) {
    worker.addEventListener('message', (event) => {
      const message: unknown = event.data;
      if (!isMarkdownResponse(message)) {
        console.error('[markdown] ignored a malformed worker message');
        return;
      }
      if (message.type === 'error') {
        console.error(`[markdown] parsing ${message.docId} failed: ${message.message}`);
        return;
      }
      for (const update of message.updates) {
        this.receive(update);
      }
    });
  }

  /** The parsed blocks of `docId`, if any arrived yet. */
  get(docId: string): ParsedDoc | undefined {
    return this.docs.get(docId)?.parsed;
  }

  subscribe(docId: string, listener: () => void): () => void {
    const state = this.state(docId);
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  }

  /**
   * Streams `text`, the visible prefix of an item; each call must extend the previous one.
   * `final` says `text` is the whole item.
   */
  stream(docId: string, text: string, final: boolean): void {
    const state = this.state(docId);
    if (state.finalSent || state.requested) {
      return;
    }
    const added = text.slice(state.sent + state.pending.length);
    state.pending += added;
    state.finalPending ||= final;
    this.flush(docId, state);
  }

  /** Parses a finished item once; later calls for the same item do nothing. */
  parseFinished(docId: string, text: string): void {
    const state = this.state(docId);
    if (state.requested || state.sent > 0 || state.inFlight) {
      return;
    }
    state.requested = true;
    this.batch.push({ docId, text });
    if (!this.batchScheduled) {
      this.batchScheduled = true;
      queueMicrotask(() => {
        this.batchScheduled = false;
        const docs = this.batch;
        this.batch = [];
        this.worker.postMessage({ type: 'parse', docs });
      });
    }
  }

  /** Forgets items, for example when a session is closed. */
  drop(docIds: readonly string[]): void {
    for (const docId of docIds) {
      this.docs.delete(docId);
    }
    this.worker.postMessage({ type: 'drop', docIds });
  }

  private state(docId: string): DocState {
    let state = this.docs.get(docId);
    if (state === undefined) {
      state = {
        parsed: undefined,
        listeners: new Set(),
        sent: 0,
        inFlight: false,
        pending: '',
        finalPending: false,
        finalSent: false,
        requested: false,
      };
      this.docs.set(docId, state);
    }
    return state;
  }

  private flush(docId: string, state: DocState): void {
    if (state.inFlight || state.finalSent || (state.pending === '' && !state.finalPending)) {
      return;
    }
    const chunk = state.pending;
    const final = state.finalPending;
    state.pending = '';
    state.sent += chunk.length;
    state.inFlight = true;
    state.finalSent = final;
    this.worker.postMessage({ type: 'append', docId, chunk, final });
  }

  private receive(update: DocUpdate): void {
    const state = this.docs.get(update.docId);
    if (state === undefined) {
      return;
    }
    state.parsed = {
      blocks: applyUpdate(state.parsed?.blocks ?? [], update),
      final: update.final,
    };
    state.inFlight = false;
    for (const listener of state.listeners) {
      listener();
    }
    this.flush(update.docId, state);
  }
}
