// Measured row heights keyed by row id and list width (architecture section 8.4), so rows that
// scroll back into view, and lists that return to an earlier width, start at the right size.
import { VIRTUAL_LIST } from './constants.js';
import type { TranscriptRow } from '../store/transcript.js';

/** Heights kept before the oldest are dropped. */
const MAX_ENTRIES = 20_000;

export class RowHeights {
  private readonly heights = new Map<string, number>();

  private static key(id: string, width: number): string {
    return `${id}@${String(Math.round(width))}`;
  }

  get(id: string, width: number): number | undefined {
    return this.heights.get(RowHeights.key(id, width));
  }

  set(id: string, width: number, height: number): void {
    const key = RowHeights.key(id, width);
    this.heights.delete(key);
    this.heights.set(key, height);
    if (this.heights.size > MAX_ENTRIES) {
      const oldest = this.heights.keys().next();
      if (oldest.done !== true) {
        this.heights.delete(oldest.value);
      }
    }
  }

  /** The measured height, or an estimate from the row's content and the width. */
  estimate(row: TranscriptRow | undefined, id: string, width: number): number {
    const measured = this.get(id, width);
    if (measured !== undefined) {
      return measured;
    }
    const { estimatedCharWidthPx, estimatedLineHeightPx } = VIRTUAL_LIST;
    const perLine = Math.max(20, Math.floor(Math.max(width - 48, 100) / estimatedCharWidthPx));
    const textHeight = (text: string): number => {
      const lines = text
        .split('\n')
        .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0);
      return 32 + lines * estimatedLineHeightPx;
    };
    switch (row?.kind) {
      case 'optimistic':
        return textHeight(row.input.text);
      case 'item':
        switch (row.item.type) {
          case 'agentMessage':
          case 'userMessage':
            return textHeight(row.item.text);
          case 'commandExecution':
            return 96;
          default:
            return 40;
        }
      case 'group':
      case 'working':
        return 40;
      default:
        return 72;
    }
  }
}
