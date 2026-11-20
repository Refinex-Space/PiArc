// Core's transcript window answer (`transcriptWindow`, `subagentTranscript`), checked before the
// store reads it.
import type { TranscriptEntry } from './transcript.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `{ start, items: [{ entryId, turnId?, item }], harness?, branches? }` from JSON text. */
export function parseWindow(text: string): {
  start: number;
  items: TranscriptEntry[];
  harness?: unknown;
  branches?: unknown;
} {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return { start: 0, items: [] };
  }
  const items = value.items.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry.entryId === 'string'
      ? [
          {
            entryId: entry.entryId,
            ...(typeof entry.turnId === 'string' ? { turnId: entry.turnId } : {}),
            item: entry.item,
          },
        ]
      : [],
  );
  return {
    start: typeof value.start === 'number' ? value.start : 0,
    items,
    harness: value.harness,
    branches: value.branches,
  };
}
