// Feeds streaming agent messages to the Markdown worker at the streaming rhythm (pacer.ts), one
// requestAnimationFrame loop for all of them, independent of which rows are mounted and of which
// session is shown. It follows every transcript of the window; the loop runs only while some
// message is still being revealed.
import type { SessionTranscript } from '../store/transcript.js';
import type { MarkdownClient } from './markdown/markdown-client.js';
import { revealLength } from './pacer.js';

/** `requestAnimationFrame` and its counterpart; tests pass a manual clock. */
export interface FrameScheduler {
  requestAnimationFrame(callback: (now: number) => void): number;
  cancelAnimationFrame(handle: number): void;
}

interface Revealing {
  readonly rowId: string;
  readonly transcript: SessionTranscript;
  visible: number;
}

export class StreamingDriver {
  /** Messages being revealed → their transcript and the characters shown so far. */
  private readonly revealing = new Map<string, Revealing>();
  /** Messages that were streamed (their Markdown came through `stream`). */
  private readonly streamed = new Set<string>();
  private frame: number | null = null;
  private lastFrameAt: number | null = null;

  constructor(
    private readonly markdown: Pick<MarkdownClient, 'stream'>,
    private readonly scheduler: FrameScheduler,
  ) {}

  /** Starts following `transcript`; returns the function that stops it. */
  follow(transcript: SessionTranscript): () => void {
    return transcript.subscribeChanges((ids) => {
      for (const id of ids) {
        const row = transcript.row(id);
        const docKey = transcript.cacheKey(id);
        if (
          row?.kind === 'item' &&
          row.item.type === 'agentMessage' &&
          row.item.status === 'inProgress' &&
          !this.revealing.has(docKey) &&
          !this.streamed.has(docKey)
        ) {
          this.revealing.set(docKey, { transcript, rowId: id, visible: 0 });
          this.streamed.add(docKey);
        }
      }
      if (this.revealing.size > 0) {
        this.schedule();
      }
    });
  }

  /** True when the message's Markdown comes from streaming, not from a one-shot parse. */
  streams(docKey: string): boolean {
    return this.streamed.has(docKey);
  }

  /** Stops the loop and forgets every message (the transcript was cleared). */
  reset(): void {
    if (this.frame !== null) {
      this.scheduler.cancelAnimationFrame(this.frame);
    }
    this.frame = null;
    this.lastFrameAt = null;
    this.revealing.clear();
    this.streamed.clear();
  }

  private schedule(): void {
    this.frame ??= this.scheduler.requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    this.frame = null;
    const dt = this.lastFrameAt === null ? 1000 / 60 : now - this.lastFrameAt;
    let backlog = false;
    for (const [docKey, revealing] of this.revealing) {
      const row = revealing.transcript.row(revealing.rowId);
      if (row?.kind !== 'item' || row.item.type !== 'agentMessage') {
        this.revealing.delete(docKey);
        continue;
      }
      const { text, status } = row.item;
      const next = revealLength(text, revealing.visible, dt);
      const done = status !== 'inProgress' && next === text.length;
      if (next !== revealing.visible || done) {
        this.markdown.stream(docKey, text.slice(0, next), done);
      }
      if (done) {
        this.revealing.delete(docKey);
      } else {
        revealing.visible = next;
        backlog ||= next < text.length;
      }
    }
    // Caught up: wait for the next change instead of spinning while the model is quiet.
    if (backlog) {
      this.lastFrameAt = now;
      this.schedule();
    } else {
      this.lastFrameAt = null;
    }
  };
}
