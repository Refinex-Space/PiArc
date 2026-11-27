// Shapes of the dictation events a window receives on `dictation/<id>` (`piarc_protocol::
// dictation::DictationEvent`), checked before use: the batch arrives as JSON bytes from Core.
// Lengths are bounded here as well as in Core.

export type DictationEventMessage =
  | {
      readonly type: 'state';
      readonly sessionId: string;
      readonly sequence: number;
      readonly state: string;
      readonly code?: string;
    }
  | {
      readonly type: 'level';
      readonly sessionId: string;
      readonly sequence: number;
      readonly audioMs: number;
      readonly peak: number;
      readonly envelope: readonly number[];
    }
  | {
      readonly type: 'text';
      readonly sessionId: string;
      readonly sequence: number;
      readonly segmentId: number;
      readonly revision: number;
      readonly stage: 'partial' | 'provisional' | 'final';
      readonly text: string;
    }
  | {
      readonly type: 'notice';
      readonly sessionId: string;
      readonly sequence: number;
      readonly code: string;
    };

const MAX_TEXT = 4096;
const STAGES = new Set(['partial', 'provisional', 'final']);
const STATES = new Set(['preparing', 'recording', 'finalizing', 'completed', 'cancelled', 'error']);
const CODE = /^[A-Za-z]{1,64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function level(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** One checked event, or `undefined`. */
export function parseDictationEvent(value: unknown): DictationEventMessage | undefined {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || !count(value.sequence))
    return undefined;
  const { sessionId, sequence } = value;
  switch (value.type) {
    case 'state':
      if (typeof value.state !== 'string' || !STATES.has(value.state)) return undefined;
      return {
        type: 'state',
        sessionId,
        sequence,
        state: value.state,
        ...(typeof value.code === 'string' && CODE.test(value.code) ? { code: value.code } : {}),
      };
    case 'level': {
      const envelope = Array.isArray(value.envelope) ? value.envelope.slice(0, 8) : [];
      if (!count(value.audioMs) || !level(value.peak) || !envelope.every(level)) return undefined;
      return {
        type: 'level',
        sessionId,
        sequence,
        audioMs: value.audioMs,
        peak: value.peak,
        envelope,
      };
    }
    case 'text':
      if (
        !count(value.segmentId) ||
        !count(value.revision) ||
        typeof value.stage !== 'string' ||
        !STAGES.has(value.stage) ||
        typeof value.text !== 'string' ||
        value.text.length > MAX_TEXT
      ) {
        return undefined;
      }
      return {
        type: 'text',
        sessionId,
        sequence,
        segmentId: value.segmentId,
        revision: value.revision,
        stage: value.stage as 'partial' | 'provisional' | 'final',
        text: value.text,
      };
    case 'notice':
      if (typeof value.code !== 'string' || !CODE.test(value.code)) return undefined;
      return { type: 'notice', sessionId, sequence, code: value.code };
    default:
      return undefined;
  }
}

/** The events of one batch payload (a UTF-8 JSON array). */
export function parseDictationBatch(payload: unknown): DictationEventMessage[] {
  let value: unknown = payload;
  if (payload instanceof Uint8Array) {
    try {
      value = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.map(parseDictationEvent).filter((e): e is DictationEventMessage => e !== undefined);
}
