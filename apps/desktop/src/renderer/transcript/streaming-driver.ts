// Feeds streaming agent messages to the Markdown worker at the streaming rhythm (pacer.ts), one
// requestAnimationFrame loop for all of them, independent of which rows are mounted. The loop
// runs only while some message is still being revealed.
import type { TranscriptStore } from './item-store.js';
import type { MarkdownClient } from './markdown/markdown-client.js';
import { revealLength } from './pacer.js';

/** `requestAnimationFrame` and its counterpart; tests pass a manual clock. */
export interface FrameScheduler {
  requestAnimationFrame(callback: (now: number) => void): number;
  cancelAnimationFrame(handle: number): void;
}

export class StreamingDriver {
  /** Messages being revealed → characters shown so far. */
  private readonly revealing = new Map<string, number>();
  /** Messages that were streamed (their Markdown came through `stream`). */
  private readonly streamed = new Set<string>();
  private frame: number | null = null;
  private lastFrameAt: number | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly store: TranscriptStore,
    private readonly markdown: MarkdownClient,
    private readonly scheduler: FrameScheduler,
  ) {
    this.unsubscribe = store.subscribeChanges((ids) => {
      for (const id of ids) {
        const row = store.row(id);
        if (
          row?.kind === 'agentMessage' &&
          row.item.status === 'inProgress' &&
          !this.revealing.has(id) &&
          !this.streamed.has(id)
        ) {
          this.revealing.set(id, 0);
          this.streamed.add(id);
        }
      }
      if (this.revealing.size > 0) {
        this.schedule();
      }
    });
  }

  /** True when the message's Markdown comes from streaming, not from a one-shot parse. */
  streams(id: string): boolean {
    return this.streamed.has(id);
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

  dispose(): void {
    this.reset();
    this.unsubscribe();
  }

  private schedule(): void {
    this.frame ??= this.scheduler.requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    this.frame = null;
    const dt = this.lastFrameAt === null ? 1000 / 60 : now - this.lastFrameAt;
    let backlog = false;
    for (const [id, visible] of this.revealing) {
      const row = this.store.row(id);
      if (row?.kind !== 'agentMessage') {
        this.revealing.delete(id);
        continue;
      }
      const { text, status } = row.item;
      const next = revealLength(text, visible, dt);
      const done = status !== 'inProgress' && next === text.length;
      if (next !== visible || done) {
        this.markdown.stream(id, text.slice(0, next), done);
      }
      if (done) {
        this.revealing.delete(id);
      } else {
        this.revealing.set(id, next);
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
