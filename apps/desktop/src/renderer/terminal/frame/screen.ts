// The viewer side of the frame protocol: applies frames in order and holds what the renderer
// draws. Same rules as `piarc_protocol::term_frame::Screen` (crates/piarc-protocol/src/
// term_frame/screen.rs); the shared samples check that both build the same screen.
import {
  FrameError,
  type Frame,
  type FrameCell,
  type FrameColors,
  type FrameCursor,
  type FrameStyle,
} from './decoder.js';

const DEFAULT_STYLE: FrameStyle = { fg: null, bg: null, underline: null, flags: 0 };

const NO_CURSOR: FrameCursor = {
  visible: false,
  blinking: false,
  inViewport: false,
  wideTail: false,
  passwordInput: false,
  style: 'block',
  x: 0,
  y: 0,
};

/** What changed in the last applied frame, for the renderer's redraw decisions. */
export interface AppliedChange {
  /** Everything must be drawn again (reset, new colors, new size). */
  readonly full: boolean;
  /** Viewport rows whose content changed or that show another row than before. */
  readonly rows: ReadonlySet<number>;
}

export class Screen {
  #seq = 0;
  #cols = 0;
  #rows = 0;
  #cursor: FrameCursor = NO_CURSOR;
  #colors: FrameColors | null = null;
  #styles = new Map<number, FrameStyle>();
  #held = new Map<number, readonly FrameCell[]>();
  #viewport: number[] = [];

  /**
   * Applies `frame` and reports what changed. Throws `FrameError` (leaving the screen as it
   * was) when the frame is out of order, the first frame does not reset, a RESET frame is
   * empty, a row without cells is not held, or a cell refers to an unknown style; the viewer
   * should then ask for a RESET frame.
   */
  apply(frame: Frame): AppliedChange {
    if (!frame.reset) {
      if (this.#seq === 0) {
        throw new FrameError('the first frame must reset');
      }
      if (frame.seq !== this.#seq + 1) {
        throw new FrameError(`frame ${String(frame.seq)} arrived after frame ${String(this.#seq)}`);
      }
    }
    const body = frame.body;
    if (body === null) {
      if (frame.reset) {
        throw new FrameError('a RESET frame must have a body');
      }
      this.#seq = frame.seq;
      return { full: false, rows: new Set() };
    }
    const styles = frame.reset ? new Map<number, FrameStyle>() : new Map(this.#styles);
    for (const entry of body.styles) {
      styles.set(entry.id, entry.style);
    }
    const old = frame.reset ? new Map<number, readonly FrameCell[]>() : this.#held;
    const held = new Map<number, readonly FrameCell[]>();
    const viewport: number[] = [];
    const changed = new Set<number>();
    body.rows.forEach((row, y) => {
      let cells = row.cells;
      if (cells !== null) {
        const unknown = cells.find((cell) => cell.style !== 0 && !styles.has(cell.style));
        if (unknown !== undefined) {
          throw new FrameError(`unknown style ${String(unknown.style)}`);
        }
        changed.add(y);
      } else {
        cells = held.get(row.id) ?? old.get(row.id) ?? null;
        if (cells === null) {
          throw new FrameError(`row ${String(row.id)} is not held`);
        }
        if (this.#viewport[y] !== row.id) {
          changed.add(y);
        }
      }
      held.set(row.id, cells);
      viewport.push(row.id);
    });
    const full =
      frame.reset || body.colors !== null || frame.cols !== this.#cols || frame.rows !== this.#rows;
    this.#seq = frame.seq;
    this.#cols = frame.cols;
    this.#rows = frame.rows;
    this.#cursor = body.cursor;
    if (body.colors !== null) {
      this.#colors = body.colors;
    } else if (frame.reset) {
      this.#colors = null;
    }
    this.#styles = styles;
    this.#held = held;
    this.#viewport = viewport;
    return { full, rows: changed };
  }

  get seq(): number {
    return this.#seq;
  }

  get cols(): number {
    return this.#cols;
  }

  get rows(): number {
    return this.#rows;
  }

  get cursor(): FrameCursor {
    return this.#cursor;
  }

  get colors(): FrameColors | null {
    return this.#colors;
  }

  /** The style of a cell's style id; id 0 is the default style. */
  style(id: number): FrameStyle {
    return id === 0 ? DEFAULT_STYLE : (this.#styles.get(id) ?? DEFAULT_STYLE);
  }

  get rowIds(): readonly number[] {
    return this.#viewport;
  }

  row(y: number): readonly FrameCell[] {
    const id = this.#viewport[y];
    return id === undefined ? [] : (this.#held.get(id) ?? []);
  }

  /** Row `y` as text, by the formatter's plain-text rules. */
  rowText(y: number): string {
    let text = '';
    for (const cell of this.row(y)) {
      if (cell.wide === 2 || cell.wide === 3) {
        continue;
      }
      text += cell.text === '' ? ' ' : cell.text;
    }
    return text.replace(/ +$/, '');
  }

  /** The viewport as plain text, trailing blank lines removed. */
  plainText(): string {
    const lines: string[] = [];
    for (let y = 0; y < this.#rows; y += 1) {
      lines.push(this.rowText(y));
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.join('\n');
  }
}
