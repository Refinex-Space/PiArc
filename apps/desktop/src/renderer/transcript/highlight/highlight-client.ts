// Renderer side of the highlight worker. Results are cached (least recently used first out) so
// a code block that scrolls back into view renders highlighted at once.
import { HIGHLIGHT_MAX_CHARS, languageId } from './languages.js';
import { isHighlightResponse, type HighlightLines, type HighlightRequest } from './protocol.js';

/** The part of `Worker` the client uses. */
export interface HighlightWorkerPort {
  postMessage(message: HighlightRequest): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** Highlighted code blocks kept in memory. */
const CACHE_ENTRIES = 300;

export class HighlightClient {
  private nextId = 1;
  private readonly waiting = new Map<number, (lines: HighlightLines | null) => void>();
  private readonly pending = new Map<string, Promise<HighlightLines | null>>();
  private readonly cache = new Map<string, HighlightLines | null>();

  constructor(private readonly worker: HighlightWorkerPort) {
    worker.addEventListener('message', (event) => {
      const message: unknown = event.data;
      if (!isHighlightResponse(message)) {
        console.error('[highlight] ignored a malformed worker message');
        return;
      }
      const resolve = this.waiting.get(message.id);
      this.waiting.delete(message.id);
      if (message.type === 'failed') {
        console.warn(`[highlight] ${message.message}`);
      }
      resolve?.(message.type === 'highlighted' ? message.lines : null);
    });
  }

  /** Whether `lang` and `code` can be highlighted at all. */
  static supports(lang: string | null, code: string): boolean {
    return languageId(lang) !== null && code.length <= HIGHLIGHT_MAX_CHARS;
  }

  /** A cached result: lines, `null` when the code stays plain, `undefined` when not known yet. */
  peek(lang: string | null, code: string): HighlightLines | null | undefined {
    const key = this.key(lang, code);
    if (key === null) {
      return null;
    }
    const lines = this.cache.get(key);
    if (lines !== undefined) {
      // Refresh the entry's position for the LRU order.
      this.cache.delete(key);
      this.cache.set(key, lines);
    }
    return lines;
  }

  /** Highlights `code`; resolves `null` when it stays plain text. */
  highlight(lang: string | null, code: string): Promise<HighlightLines | null> {
    const key = this.key(lang, code);
    const language = languageId(lang);
    if (key === null || language === null) {
      return Promise.resolve(null);
    }
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    let request = this.pending.get(key);
    if (request === undefined) {
      const id = this.nextId++;
      request = new Promise<HighlightLines | null>((resolve) => {
        this.waiting.set(id, resolve);
      }).then((lines) => {
        this.pending.delete(key);
        this.remember(key, lines);
        return lines;
      });
      this.pending.set(key, request);
      this.worker.postMessage({ type: 'highlight', id, language, code });
    }
    return request;
  }

  private key(lang: string | null, code: string): string | null {
    const language = languageId(lang);
    return language === null || code.length > HIGHLIGHT_MAX_CHARS ? null : `${language}\n${code}`;
  }

  private remember(key: string, lines: HighlightLines | null): void {
    this.cache.set(key, lines);
    while (this.cache.size > CACHE_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.cache.delete(oldest.value);
    }
  }
}
