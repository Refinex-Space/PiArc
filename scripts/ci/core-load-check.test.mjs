import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isRecord, repoRoot } from '../lib/repo.mjs';
import { frameRows } from './core-load-check.mjs';

/**
 * The frame samples Rust writes for the renderer's decoder (crates/piarc-term/tests/consistency.rs).
 * @returns {{ name: string, frames: Buffer[], screenRows: string[] }[]}
 */
function samples() {
  /** @type {unknown} */
  const json = JSON.parse(
    readFileSync(
      path.join(
        repoRoot,
        'apps',
        'desktop',
        'src',
        'renderer',
        'terminal',
        'frame',
        'frame-samples.json',
      ),
      'utf8',
    ),
  );
  if (!isRecord(json) || !Array.isArray(json.cases)) {
    throw new Error('unexpected frame-samples.json');
  }
  return json.cases.map((/** @type {unknown} */ sample) => {
    if (
      !isRecord(sample) ||
      typeof sample.name !== 'string' ||
      !Array.isArray(sample.frames) ||
      !isRecord(sample.screen) ||
      !Array.isArray(sample.screen.cells)
    ) {
      throw new Error('unexpected frame sample');
    }
    return {
      name: sample.name,
      frames: sample.frames.map((/** @type {unknown} */ frame) => {
        if (!isRecord(frame) || typeof frame.bytes !== 'string') {
          throw new Error('unexpected frame');
        }
        return Buffer.from(frame.bytes, 'base64');
      }),
      screenRows: sample.screen.cells.map((/** @type {unknown} */ row) =>
        Array.isArray(row)
          ? row
              .map((cell) => (isRecord(cell) && typeof cell.text === 'string' ? cell.text : ''))
              .join('')
          : '',
      ),
    };
  });
}

describe('frameRows', () => {
  it.each(samples())('reads every frame of "$name" and the rows it carries', (sample) => {
    const carried = sample.frames.flatMap((frame) => frameRows(frame));
    for (const row of sample.screenRows) {
      expect(carried).toContain(row);
    }
  });

  it('refuses bytes that are not a frame', () => {
    expect(() => frameRows(Buffer.from('not a frame'))).toThrow(/version 1 terminal frame/);
  });
});
