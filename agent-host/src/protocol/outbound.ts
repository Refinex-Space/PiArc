// The Agent Host's only path to stdout: an ordered frame queue that respects backpressure.
//
// Core may read stdout slower than Pi produces events. Node's stream would then buffer every
// write in memory without limit, so frames wait here instead and the queue writes the next one
// only after the stream drained. Waiting text deltas of the same item are merged into one
// frame, so a stalled reader costs memory proportional to the text produced, not to the number
// of deltas; past `maxQueuedBytes` the queue reports an overflow and the host exits (Core then
// restarts it). Session events get their `seq` when they are written, so merging never leaves
// a gap: per session, `seq` counts the frames Core actually receives, from 1 without holes.
import { encodeFrame } from '@piarc/protocol';

/** Where frames go: the real stdout, or a test double with the same backpressure contract. */
export interface FrameSink {
  /** Writes a chunk; `false` means "stop until `drain`". */
  write(chunk: Uint8Array): boolean;
  once(event: 'drain', listener: () => void): unknown;
}

/** Counters reported in `host/ping` results. */
export interface OutboundStats {
  queuedFrames: number;
  queuedBytes: number;
  peakBytes: number;
}

interface PlainEntry {
  readonly kind: 'plain';
  readonly frame: Uint8Array;
}

interface SessionEntry {
  readonly kind: 'session';
  readonly sessionId: string;
  readonly method: string;
  readonly ts: number;
  readonly payload: Record<string, unknown>;
  /** Text-delta entries carry a merge key and their text; others leave both undefined. */
  readonly mergeKey: string | undefined;
  delta: string;
  /** Estimated encoded size, kept up to date as deltas merge in. */
  bytes: number;
}

type Entry = PlainEntry | SessionEntry;

/** Default ceiling for the bytes waiting in the queue: 64 MiB. */
export const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024;

const SESSION_HEADER_BYTES = 128;

export class OutboundQueue {
  readonly #sink: FrameSink;
  readonly #maxQueuedBytes: number;
  readonly #onOverflow: (stats: OutboundStats) => void;
  readonly #entries: Entry[] = [];
  /** Per session, the newest queued entry, while it is still waiting: the only merge target. */
  readonly #tails = new Map<string, SessionEntry>();
  readonly #seq = new Map<string, number>();
  readonly #idleWaiters: (() => void)[] = [];
  #queuedBytes = 0;
  #peakBytes = 0;
  #waitingForDrain = false;
  #overflowed = false;

  constructor(
    sink: FrameSink,
    options: { maxQueuedBytes?: number; onOverflow: (stats: OutboundStats) => void },
  ) {
    this.#sink = sink;
    this.#maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    this.#onOverflow = options.onOverflow;
  }

  /** Queues a request, response or non-session notification. */
  sendMessage(message: object): void {
    const frame = encodeFrame(message);
    this.#push({ kind: 'plain', frame }, frame.length);
  }

  /**
   * Queues a session notification. `payload` is everything but the header; `sessionId`,
   * `seq` and `ts` are added when the frame is written.
   */
  sendSessionEvent(sessionId: string, method: string, payload: Record<string, unknown>): void {
    const entry: SessionEntry = {
      kind: 'session',
      sessionId,
      method,
      ts: Date.now(),
      payload,
      mergeKey: undefined,
      delta: '',
      bytes: SESSION_HEADER_BYTES + JSON.stringify(payload).length,
    };
    this.#enqueueSession(entry);
  }

  /**
   * Queues a text delta, written as `payload` plus a `delta` member. While it waits, a later
   * delta for the same session, method and `mergeKey` is appended to it instead of becoming
   * another frame.
   */
  sendDelta(
    sessionId: string,
    method: string,
    mergeKey: string,
    payload: Record<string, unknown>,
    delta: string,
  ): void {
    const tail = this.#tails.get(sessionId);
    if (tail?.mergeKey === mergeKey && tail.method === method) {
      tail.delta += delta;
      tail.bytes += delta.length;
      this.#account(delta.length);
      return;
    }
    const entry: SessionEntry = {
      kind: 'session',
      sessionId,
      method,
      ts: Date.now(),
      payload,
      mergeKey,
      delta,
      bytes: SESSION_HEADER_BYTES + JSON.stringify(payload).length + delta.length,
    };
    this.#enqueueSession(entry);
  }

  /**
   * Continues a session's numbering after `lastSeq`: a session reopened after a restart keeps
   * increasing `seq` from where Core last saw it.
   */
  continueSeq(sessionId: string, lastSeq: number): void {
    this.#seq.set(sessionId, Math.max(this.#seq.get(sessionId) ?? 0, lastSeq));
  }

  /** Current counters. */
  stats(): OutboundStats {
    return {
      queuedFrames: this.#entries.length,
      queuedBytes: this.#queuedBytes,
      peakBytes: this.#peakBytes,
    };
  }

  /** Resolves once every queued frame has been handed to the sink and the sink drained. */
  async flushed(): Promise<void> {
    if (this.#entries.length === 0 && !this.#waitingForDrain) {
      return;
    }
    await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
  }

  /** The entry becomes the session's merge target before the pump may write it. */
  #enqueueSession(entry: SessionEntry): void {
    this.#tails.set(entry.sessionId, entry);
    this.#push(entry, entry.bytes);
  }

  #push(entry: Entry, bytes: number): void {
    this.#entries.push(entry);
    this.#account(bytes);
    this.#pump();
  }

  #account(bytes: number): void {
    this.#queuedBytes += bytes;
    this.#peakBytes = Math.max(this.#peakBytes, this.#queuedBytes);
    if (this.#queuedBytes > this.#maxQueuedBytes && !this.#overflowed) {
      this.#overflowed = true;
      this.#onOverflow(this.stats());
    }
  }

  #pump(): void {
    while (!this.#waitingForDrain) {
      const entry = this.#entries.shift();
      if (entry === undefined) {
        this.#notifyIdle();
        return;
      }
      if (entry.kind === 'session' && this.#tails.get(entry.sessionId) === entry) {
        this.#tails.delete(entry.sessionId);
      }
      this.#queuedBytes -= entry.kind === 'plain' ? entry.frame.length : entry.bytes;
      const ready = this.#sink.write(entry.kind === 'plain' ? entry.frame : this.#encode(entry));
      if (!ready) {
        this.#waitingForDrain = true;
        this.#sink.once('drain', () => {
          this.#waitingForDrain = false;
          this.#pump();
        });
      }
    }
  }

  #encode(entry: SessionEntry): Uint8Array {
    const seq = (this.#seq.get(entry.sessionId) ?? 0) + 1;
    this.#seq.set(entry.sessionId, seq);
    const params: Record<string, unknown> = {
      sessionId: entry.sessionId,
      seq,
      ts: entry.ts,
      ...entry.payload,
      ...(entry.mergeKey === undefined ? {} : { delta: entry.delta }),
    };
    return encodeFrame({ jsonrpc: '2.0', method: entry.method, params });
  }

  #notifyIdle(): void {
    for (const resolve of this.#idleWaiters.splice(0)) {
      resolve();
    }
  }
}
