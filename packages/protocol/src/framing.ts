// LF-delimited JSON frame codec: the TypeScript twin of piarc-protocol's `framing`
// module. Both implementations pass the shared byte-level cases in
// tests/contracts/framing/.
//
// - Frames are split on the LF byte (0x0A) only; U+2028 and U+2029 inside JSON strings are
//   ordinary characters.
// - A partial frame is buffered until the next input; one input may yield many frames.
// - Empty frames (two consecutive LFs) are skipped.
// - A frame whose content exceeds the limit is reported once as `frameTooLarge` and
//   discarded up to the next LF; later frames decode normally. The buffer never grows
//   beyond the limit.
// - Invalid UTF-8 and invalid JSON are reported per frame as `parseError`; decoding never
//   throws. A UTF-8 byte order mark is not stripped (it is invalid JSON, as in Rust).
// - Encoding writes compact JSON, which never contains a raw LF, and appends one LF.
import type { ErrorKind } from './generated/ahp.js';

/** Default limit for the content of one frame (excluding the LF): 8 MiB. */
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

const LF = 0x0a;

/** Structured error for one frame, matching the wire error data shape. */
export interface FrameError {
  readonly kind: Extract<ErrorKind, 'frameTooLarge' | 'parseError'>;
  readonly retryable: false;
  readonly message: string;
}

/** One decoded frame: the parsed JSON value, or the error for that frame. */
export type FrameResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: FrameError };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

function frameError(kind: FrameError['kind'], message: string): FrameResult {
  return { ok: false, error: { kind, retryable: false, message } };
}

function parseFrame(bytes: Uint8Array): FrameResult | undefined {
  if (bytes.length === 0) {
    return undefined;
  }
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch (error) {
    return frameError('parseError', `frame is not valid UTF-8: ${describe(error)}`);
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return frameError('parseError', `frame is not valid JSON: ${describe(error)}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Incremental decoder for LF-delimited JSON frames. */
export class FrameDecoder {
  readonly maxFrameBytes: number;
  #chunks: Uint8Array[] = [];
  #buffered = 0;
  /** Inside an oversized frame that was already reported; skip until the next LF. */
  #discarding = false;

  constructor(maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
  }

  /** Feeds `input` and returns every frame it completes, in order. */
  decode(input: Uint8Array): FrameResult[] {
    const frames: FrameResult[] = [];
    let start = 0;
    let end = input.indexOf(LF, start);
    while (end !== -1) {
      const line = input.subarray(start, end);
      start = end + 1;
      end = input.indexOf(LF, start);
      if (this.#discarding) {
        this.#discarding = false;
        continue;
      }
      if (this.#buffered + line.length > this.maxFrameBytes) {
        this.#clear();
        frames.push(this.#tooLarge());
        continue;
      }
      const frame = parseFrame(this.#buffered === 0 ? line : this.#take(line));
      if (frame !== undefined) {
        frames.push(frame);
      }
    }
    const rest = input.subarray(start);
    if (!this.#discarding && rest.length > 0) {
      if (this.#buffered + rest.length > this.maxFrameBytes) {
        this.#clear();
        this.#discarding = true;
        frames.push(this.#tooLarge());
      } else {
        // Copy: the caller may reuse its buffer after `decode` returns.
        this.#chunks.push(rest.slice());
        this.#buffered += rest.length;
      }
    }
    return frames;
  }

  /** Joins the buffered chunks with `tail` and empties the buffer. */
  #take(tail: Uint8Array): Uint8Array {
    const joined = new Uint8Array(this.#buffered + tail.length);
    let offset = 0;
    for (const chunk of [...this.#chunks, tail]) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    this.#clear();
    return joined;
  }

  #clear(): void {
    this.#chunks = [];
    this.#buffered = 0;
  }

  #tooLarge(): FrameResult {
    return frameError(
      'frameTooLarge',
      `frame exceeds the limit of ${String(this.maxFrameBytes)} bytes and was discarded`,
    );
  }
}

/**
 * Serializes `value` as one frame: compact JSON followed by LF.
 * Throws a TypeError when `value` cannot be represented as JSON (for example `undefined`,
 * a function, or a BigInt).
 */
export function encodeFrame(value: unknown): Uint8Array {
  const json: unknown = JSON.stringify(value);
  if (typeof json !== 'string') {
    throw new TypeError('value cannot be encoded as JSON');
  }
  return encoder.encode(`${json}\n`);
}
