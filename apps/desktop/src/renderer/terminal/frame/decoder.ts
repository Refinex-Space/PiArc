// Decoder of the draft terminal frame format (ADR-0017, T10). The format and its rules are
// documented once, in crates/piarc-protocol/src/term_frame.rs; this is the TypeScript twin of
// its `decode`, and both run the shared samples in frame-samples.json.

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export type Dirty = 'clean' | 'partial' | 'full';
export type CursorStyle = 'bar' | 'block' | 'underline' | 'blockHollow';

export interface FrameCursor {
  readonly visible: boolean;
  readonly blinking: boolean;
  readonly inViewport: boolean;
  readonly wideTail: boolean;
  readonly passwordInput: boolean;
  readonly style: CursorStyle;
  readonly x: number;
  readonly y: number;
}

export interface FrameColors {
  readonly background: Rgb;
  readonly foreground: Rgb;
  readonly cursor: Rgb | null;
  /** 256 entries. */
  readonly palette: readonly Rgb[];
}

/** A resolved style: `null` colors are the defaults. */
export interface FrameStyle {
  readonly fg: Rgb | null;
  readonly bg: Rgb | null;
  readonly underline: Rgb | null;
  /** libghostty-vt style flags; see `STYLE_FLAGS`. */
  readonly flags: number;
}

/** 0 narrow, 1 wide, 2 spacer tail, 3 spacer head. */
export type Wide = 0 | 1 | 2 | 3;

export interface FrameCell {
  readonly wide: Wide;
  readonly style: number;
  readonly text: string;
}

export interface FrameRow {
  readonly id: number;
  readonly cells: readonly FrameCell[] | null;
}

export interface FrameBody {
  readonly cursor: FrameCursor;
  readonly colors: FrameColors | null;
  readonly styles: readonly { readonly id: number; readonly style: FrameStyle }[];
  readonly rows: readonly FrameRow[];
}

export interface Frame {
  readonly seq: number;
  readonly reset: boolean;
  readonly held: boolean;
  readonly dirty: Dirty;
  readonly cols: number;
  readonly rows: number;
  /** `null` for an empty frame: nothing changed. */
  readonly body: FrameBody | null;
}

/** libghostty-vt style flag bits. */
export const STYLE_FLAGS = {
  bold: 1,
  italic: 1 << 1,
  faint: 1 << 2,
  blink: 1 << 3,
  inverse: 1 << 4,
  invisible: 1 << 5,
  strikethrough: 1 << 6,
  overline: 1 << 7,
  /** Underline kind in bits 8–10 (0 none, 1 single, 2 double, 3 curly, 4 dotted, 5 dashed). */
  underlineShift: 8,
  underlineMask: 0x7 << 8,
} as const;

export const FRAME_VERSION = 1;
export const FRAME_HEADER_BYTES = 14;

const FLAG_RESET = 1;
const FLAG_COLORS = 1 << 1;
const FLAG_EMPTY = 1 << 2;
const FLAG_HELD = 1 << 3;

export class FrameError extends Error {
  constructor(reason: string) {
    super(`invalid terminal frame: ${reason}`);
    this.name = 'FrameError';
  }
}

/** One-character strings for ASCII, so the common cell needs no decoder call. */
const ASCII = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code));
const utf8 = new TextDecoder('utf-8', { fatal: true });

class Reader {
  #at = 0;
  readonly #view: DataView;

  constructor(readonly bytes: Uint8Array) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get at(): number {
    return this.#at;
  }

  #need(n: number): number {
    const start = this.#at;
    if (start + n > this.bytes.byteLength) {
      throw new FrameError(`truncated at byte ${String(start)}`);
    }
    this.#at = start + n;
    return start;
  }

  u8(): number {
    return this.#view.getUint8(this.#need(1));
  }

  u16(): number {
    return this.#view.getUint16(this.#need(2), true);
  }

  u32(): number {
    return this.#view.getUint32(this.#need(4), true);
  }

  rgb(): Rgb {
    const at = this.#need(3);
    return {
      r: this.#view.getUint8(at),
      g: this.#view.getUint8(at + 1),
      b: this.#view.getUint8(at + 2),
    };
  }

  color(): Rgb | null {
    const tag = this.u8();
    const rgb = this.rgb();
    if (tag === 0) {
      return null;
    }
    if (tag === 1) {
      return rgb;
    }
    throw new FrameError(`unknown color tag ${String(tag)}`);
  }

  text(length: number): string {
    const start = this.#need(length);
    if (length === 1) {
      const byte = this.#view.getUint8(start);
      const ascii = ASCII[byte];
      if (ascii !== undefined) {
        return ascii;
      }
    }
    try {
      return utf8.decode(this.bytes.subarray(start, start + length));
    } catch {
      throw new FrameError('cell text is not UTF-8');
    }
  }
}

const CURSOR_STYLES: readonly CursorStyle[] = ['bar', 'block', 'underline', 'blockHollow'];
const WIDES: readonly Wide[] = [0, 1, 2, 3];
const DIRTY: readonly Dirty[] = ['clean', 'partial', 'full'];

/** Decodes one frame; throws `FrameError` on any deviation from the format. */
export function decodeFrame(bytes: Uint8Array): Frame {
  const r = new Reader(bytes);
  if (r.u8() !== 0x50 || r.u8() !== 0x54 || r.u8() !== 0x46) {
    throw new FrameError('bad magic');
  }
  const version = r.u8();
  if (version !== FRAME_VERSION) {
    throw new FrameError(`unsupported version ${String(version)}`);
  }
  const flags = r.u8();
  if ((flags & ~(FLAG_RESET | FLAG_COLORS | FLAG_EMPTY | FLAG_HELD)) !== 0) {
    throw new FrameError(`unknown flags ${String(flags)}`);
  }
  const dirty = DIRTY[r.u8()];
  if (dirty === undefined) {
    throw new FrameError('unknown dirty state');
  }
  const seq = r.u32();
  const cols = r.u16();
  const rows = r.u16();
  let body: FrameBody | null = null;
  if ((flags & FLAG_EMPTY) === 0) {
    body = decodeBody(r, (flags & FLAG_COLORS) !== 0, cols, rows);
  } else if ((flags & FLAG_COLORS) !== 0) {
    throw new FrameError('an empty frame cannot carry colors');
  }
  if (r.at !== bytes.byteLength) {
    throw new FrameError(`${String(bytes.byteLength - r.at)} trailing bytes`);
  }
  return {
    seq,
    reset: (flags & FLAG_RESET) !== 0,
    held: (flags & FLAG_HELD) !== 0,
    dirty,
    cols,
    rows,
    body,
  };
}

function decodeBody(r: Reader, hasColors: boolean, cols: number, rows: number): FrameBody {
  const cursorFlags = r.u8();
  const style = CURSOR_STYLES[r.u8()];
  if (style === undefined) {
    throw new FrameError('unknown cursor style');
  }
  const cursor: FrameCursor = {
    visible: (cursorFlags & 1) !== 0,
    blinking: (cursorFlags & 2) !== 0,
    inViewport: (cursorFlags & 4) !== 0,
    wideTail: (cursorFlags & 8) !== 0,
    passwordInput: (cursorFlags & 16) !== 0,
    style,
    x: r.u16(),
    y: r.u16(),
  };
  let colors: FrameColors | null = null;
  if (hasColors) {
    const background = r.rgb();
    const foreground = r.rgb();
    const hasCursor = r.u8() !== 0;
    const cursorColor = r.rgb();
    const palette: Rgb[] = [];
    for (let i = 0; i < 256; i += 1) {
      palette.push(r.rgb());
    }
    colors = { background, foreground, cursor: hasCursor ? cursorColor : null, palette };
  }
  const styleCount = r.u16();
  const styles: { id: number; style: FrameStyle }[] = [];
  for (let i = 0; i < styleCount; i += 1) {
    const id = r.u16();
    if (id === 0) {
      throw new FrameError('style id 0 is reserved for the default style');
    }
    styles.push({
      id,
      style: { fg: r.color(), bg: r.color(), underline: r.color(), flags: r.u16() },
    });
  }
  const rowCount = r.u16();
  if (rowCount !== rows) {
    throw new FrameError(`row list has ${String(rowCount)} rows, the viewport ${String(rows)}`);
  }
  const list: FrameRow[] = [];
  for (let y = 0; y < rows; y += 1) {
    const id = r.u32();
    const rowFlags = r.u8();
    if (rowFlags === 0) {
      list.push({ id, cells: null });
    } else if (rowFlags === 1) {
      list.push({ id, cells: decodeCells(r, cols) });
    } else {
      throw new FrameError(`unknown row flags ${String(rowFlags)}`);
    }
  }
  return { cursor, colors, styles, rows: list };
}

function decodeCells(r: Reader, cols: number): FrameCell[] {
  const count = r.u16();
  if (count !== cols) {
    throw new FrameError(`a row has ${String(count)} cells, the viewport ${String(cols)} columns`);
  }
  const cells: FrameCell[] = [];
  for (let x = 0; x < count; x += 1) {
    const code = r.u8();
    const wide = WIDES[code];
    if (wide === undefined) {
      throw new FrameError(`unknown width class ${String(code)}`);
    }
    const style = r.u16();
    const length = r.u8();
    cells.push({ wide, style, text: length === 0 ? '' : r.text(length) });
  }
  return cells;
}
