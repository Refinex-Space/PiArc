// The Agent Host's only path to stdout: an ordered frame queue that respects backpressure.
//
// Core may read stdout slower than Pi produces events. Node's stream would then buffer every
// write in memory without limit, so frames wait here instead and the queue writes the next one
// only after the stream drained. Waiting text deltas of the same item are merged into one
// frame, and a waiting `item/updated` is replaced by a newer one for the same item, so a stalled
// reader costs memory proportional to the text produced, not to the number of events; past
// `maxQueuedBytes` the queue reports an overflow and the host exits (Core then restarts it).
// Session events get their `seq` when they are written, so merging never leaves a gap: per
// session, `seq` counts the frames Core actually receives, from 1 without holes.
//
// Every written session event also goes into a bounded per-session replay buffer: when Core sees
// a gap in `seq` it asks for the events after the last one it has (`session/getEntries`). A
// session event whose frame would exceed Core's frame limit is not written; it is logged and
// keeps no `seq`, so Core sees no gap for it.
import type { SessionEntries, SessionEventNotification } from '@piarc/protocol';
import { DEFAULT_MAX_FRAME_BYTES, encodeFrame } from '@piarc/protocol';

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
  /** Text-delta and replaceable entries carry a merge key; others leave it undefined. */
  readonly mergeKey: string | undefined;
  /** How a later entry with the same key merges in: appended text, or a newer payload. */
  readonly merge: 'append' | 'replace' | undefined;
  delta: string;
  /** The payload of a replaceable entry, updated when a newer one replaces it. */
  latest: Record<string, unknown> | undefined;
  /** Estimated encoded size, kept up to date as deltas merge in. */
  bytes: number;
}

type Entry = PlainEntry | SessionEntry;

/** Default ceiling for the bytes waiting in the queue: 64 MiB. */
export const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024;

/** Session events kept for replay per session. */
export const REPLAY_EVENTS = 4096;

/** Encoded bytes of session events kept for replay per session. */
export const REPLAY_BYTES = 8 * 1024 * 1024;

interface Replay {
  readonly events: { readonly event: SessionEventNotification; readonly bytes: number }[];
  bytes: number;
}

export interface OutboundOptions {
  maxQueuedBytes?: number;
  /** Frames longer than this are not written (Core's limit). */
  maxFrameBytes?: number;
  onOverflow: (stats: OutboundStats) => void;
  /** Called for a session event dropped because it was too large. */
  onOversize?: (method: string, sessionId: string, bytes: number) => void;
  /** Test only (`--test-drop-seq`): the frame with this `seq` is recorded but not written. */
  dropSeq?: number;
}

const SESSION_HEADER_BYTES = 128;

export class OutboundQueue {
  readonly #sink: FrameSink;
  readonly #maxQueuedBytes: number;
  readonly #onOverflow: (stats: OutboundStats) => void;
  readonly #entries: Entry[] = [];
  /** Per session, the newest queued entry, while it is still waiting: the only merge target. */
  readonly #tails = new Map<string, SessionEntry>();
  readonly #seq = new Map<string, number>();
  readonly #replay = new Map<string, Replay>();
  readonly #maxFrameBytes: number;
  readonly #onOversize: (method: string, sessionId: string, bytes: number) => void;
  readonly #dropSeq: number | undefined;
  readonly #idleWaiters: (() => void)[] = [];
  #queuedBytes = 0;
  #peakBytes = 0;
  #waitingForDrain = false;
  #overflowed = false;

  constructor(sink: FrameSink, options: OutboundOptions) {
    this.#sink = sink;
    this.#maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.#onOverflow = options.onOverflow;
    this.#onOversize = options.onOversize ?? (() => undefined);
    this.#dropSeq = options.dropSeq;
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
      merge: undefined,
      delta: '',
      latest: undefined,
      bytes: SESSION_HEADER_BYTES + JSON.stringify(payload).length,
    };
    this.#enqueueSession(entry);
  }

  /**
   * Queues a session notification that a later one with the same `method` and `key` replaces
   * while it waits (progress such as `item/updated`).
   */
  sendReplaceable(
    sessionId: string,
    method: string,
    key: string,
    payload: Record<string, unknown>,
  ): void {
    const bytes = SESSION_HEADER_BYTES + JSON.stringify(payload).length;
    const tail = this.#tails.get(sessionId);
    if (tail?.merge === 'replace' && tail.mergeKey === key && tail.method === method) {
      this.#account(bytes - tail.bytes);
      tail.latest = payload;
      tail.bytes = bytes;
      return;
    }
    this.#enqueueSession({
      kind: 'session',
      sessionId,
      method,
      ts: Date.now(),
      payload,
      mergeKey: key,
      merge: 'replace',
      delta: '',
      latest: payload,
      bytes,
    });
  }

  /**
   * The session events of `sessionId` after `since`, from the replay buffer; `complete` is false
   * when the buffer no longer holds all of them.
   */
  entriesSince(sessionId: string, since: number): SessionEntries {
    const replay = this.#replay.get(sessionId);
    const lastSeq = this.#seq.get(sessionId) ?? 0;
    const entries = (replay?.events ?? [])
      .map(({ event }) => event)
      .filter((event) => event.params.seq > since);
    const first = entries[0]?.params.seq;
    const complete = since >= lastSeq || first === since + 1;
    return { entries, complete };
  }

  /** Forgets the replay buffer of a closed session. */
  forget(sessionId: string): void {
    this.#replay.delete(sessionId);
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
    if (tail?.merge === 'append' && tail.mergeKey === mergeKey && tail.method === method) {
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
      merge: 'append',
      delta,
      latest: undefined,
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
      const frame = entry.kind === 'plain' ? entry.frame : this.#encode(entry);
      if (frame === undefined) {
        continue;
      }
      const ready = this.#sink.write(frame);
      if (!ready) {
        this.#waitingForDrain = true;
        this.#sink.once('drain', () => {
          this.#waitingForDrain = false;
          this.#pump();
        });
      }
    }
  }

  /** The frame of a session entry, recorded for replay; undefined when it is not written. */
  #encode(entry: SessionEntry): Uint8Array | undefined {
    const seq = (this.#seq.get(entry.sessionId) ?? 0) + 1;
    const event: SessionEventNotification = {
      jsonrpc: '2.0',
      method: entry.method,
      params: {
        ...(entry.merge === 'replace' ? (entry.latest ?? entry.payload) : entry.payload),
        ...(entry.merge === 'append' ? { delta: entry.delta } : {}),
        sessionId: entry.sessionId,
        seq,
        ts: entry.ts,
      },
    };
    const frame = encodeFrame(event);
    if (frame.length > this.#maxFrameBytes) {
      this.#onOversize(entry.method, entry.sessionId, frame.length);
      return undefined;
    }
    this.#seq.set(entry.sessionId, seq);
    this.#record(entry.sessionId, event, frame.length);
    return seq === this.#dropSeq ? undefined : frame;
  }

  #record(sessionId: string, event: SessionEventNotification, bytes: number): void {
    let replay = this.#replay.get(sessionId);
    if (replay === undefined) {
      replay = { events: [], bytes: 0 };
      this.#replay.set(sessionId, replay);
    }
    replay.events.push({ event, bytes });
    replay.bytes += bytes;
    while (replay.events.length > REPLAY_EVENTS || replay.bytes > REPLAY_BYTES) {
      const dropped = replay.events.shift();
      replay.bytes -= dropped?.bytes ?? 0;
    }
  }

  #notifyIdle(): void {
    for (const resolve of this.#idleWaiters.splice(0)) {
      resolve();
    }
  }
}
