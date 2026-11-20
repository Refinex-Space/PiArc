// The TypeScript decoder and screen against the shared samples that
// crates/piarc-term/tests/consistency.rs generated from real libghostty-vt frames (T10-A08):
// both decoders must build the same screen, cell by cell.
import { describe, expect, it } from 'vitest';

import { decodeFrame, FRAME_HEADER_BYTES, FrameError, type Rgb } from './decoder.js';
import samples from './frame-samples.json' with { type: 'json' };
import { Screen } from './screen.js';

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

const rgb = (color: Rgb | null) => (color === null ? null : [color.r, color.g, color.b]);

function screenJson(screen: Screen) {
  const cells = [];
  for (let y = 0; y < screen.rows; y += 1) {
    cells.push(
      screen.row(y).map((cell) => {
        const style = screen.style(cell.style);
        return {
          wide: cell.wide,
          text: cell.text,
          style: {
            fg: rgb(style.fg),
            bg: rgb(style.bg),
            underline: rgb(style.underline),
            flags: style.flags,
          },
        };
      }),
    );
  }
  return {
    cols: screen.cols,
    rows: screen.rows,
    cursor: {
      x: screen.cursor.x,
      y: screen.cursor.y,
      visible: screen.cursor.visible,
      inViewport: screen.cursor.inViewport,
    },
    cells,
    plainText: screen.plainText(),
  };
}

describe('frame decoder and screen on the shared samples', () => {
  expect(samples.cases.length).toBeGreaterThanOrEqual(5);
  for (const sample of samples.cases) {
    it(`builds the same screen as Rust: ${sample.name}`, () => {
      const screen = new Screen();
      for (const expected of sample.frames) {
        const frame = decodeFrame(fromBase64(expected.bytes));
        expect(frame.seq).toBe(expected.seq);
        expect(frame.reset).toBe(expected.reset);
        expect(frame.body === null).toBe(expected.empty);
        const withCells = (frame.body?.rows ?? []).flatMap((row, y) =>
          row.cells === null ? [] : [y],
        );
        expect(withCells).toEqual(expected.rowsWithCells);
        screen.apply(frame);
      }
      expect(screenJson(screen)).toEqual(sample.screen);
    });
  }
});

describe('decodeFrame', () => {
  const first = samples.cases[0]?.frames[0]?.bytes ?? '';

  it('rejects truncated, padded and foreign frames', () => {
    const bytes = fromBase64(first);
    for (const cut of [0, 2, FRAME_HEADER_BYTES, bytes.length - 1]) {
      expect(() => decodeFrame(bytes.subarray(0, cut))).toThrow(FrameError);
    }
    expect(() => decodeFrame(Uint8Array.from([...bytes, 0]))).toThrow(/trailing/);
    const magic = Uint8Array.from(bytes);
    magic[0] = 0x58;
    expect(() => decodeFrame(magic)).toThrow(/magic/);
    const version = Uint8Array.from(bytes);
    version[3] = 1; // T10's draft
    expect(() => decodeFrame(version)).toThrow(/version/);
  });

  it('decodes an empty frame', () => {
    const empty = Uint8Array.from([0x50, 0x54, 0x46, 2, 4, 0, 7, 0, 0, 0, 80, 0, 24, 0]);
    expect(decodeFrame(empty)).toEqual({
      seq: 7,
      reset: false,
      held: false,
      dirty: 'clean',
      cols: 80,
      rows: 24,
      body: null,
    });
  });
});

describe('Screen', () => {
  const scrolling = samples.cases.find((c) => c.name === 'scrolling output');

  it('reports moved and new rows, and rejects frames out of order', () => {
    const frames = (scrolling?.frames ?? []).map((f) => decodeFrame(fromBase64(f.bytes)));
    const [reset, scroll, more] = frames;
    if (reset === undefined || scroll === undefined || more === undefined) {
      throw new Error('scrolling sample has three frames');
    }
    const screen = new Screen();
    expect(() => {
      screen.apply(scroll);
    }).toThrow(/must reset/);
    expect(screen.apply(reset).full).toBe(true);
    expect(() => {
      screen.apply(more);
    }).toThrow(/arrived after/);
    const change = screen.apply(scroll);
    // Every row shows another line after the scroll; only the last one carried cells.
    expect([...change.rows].sort()).toEqual([0, 1, 2, 3]);
    expect(change.full).toBe(false);
    expect(screen.plainText()).toBe('two\nthree\nfour\nfive');
  });
});
