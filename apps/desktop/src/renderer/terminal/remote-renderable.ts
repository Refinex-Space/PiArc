// The data source of the forked CanvasRenderer, driven by frames from Core (ADR-0017 rule 4):
// it turns the Screen's cells into drawable cells with resolved colors and tells the renderer
// which rows changed in the frames applied since the last draw.
import type { FrameColors, FrameCursor, Rgb } from './frame/decoder.js';
import type { AppliedChange, Screen } from './frame/screen.js';
import type {
  CursorShape,
  IRenderable,
  RenderCell,
  RenderRgb,
} from './vendor/ghostty-web/renderer.js';

/** Colors used before the first frame arrives. */
const FALLBACK = {
  background: { r: 30, g: 30, b: 30 },
  foreground: { r: 212, g: 212, b: 212 },
};

const SHAPES: Readonly<Record<FrameCursor['style'], CursorShape>> = {
  bar: 'bar',
  block: 'block',
  underline: 'underline',
  blockHollow: 'blockHollow',
};

export class RemoteRenderable implements IRenderable {
  readonly #screen: Screen;
  #dirty = new Set<number>();
  #full = true;
  #preedit = '';

  constructor(screen: Screen) {
    this.#screen = screen;
  }

  /** Records what an applied frame changed. */
  noteChange(change: AppliedChange): void {
    if (change.full) {
      this.#full = true;
    }
    for (const y of change.rows) {
      this.#dirty.add(y);
    }
  }

  /** Sets the input-method preedit text drawn at the cursor. */
  setPreedit(text: string): void {
    this.#preedit = text;
  }

  get preedit(): string {
    return this.#preedit;
  }

  #colors(): FrameColors | null {
    return this.#screen.colors;
  }

  getColors(): { background: RenderRgb; foreground: RenderRgb; cursor: RenderRgb | null } {
    const colors = this.#colors();
    return {
      background: colors?.background ?? FALLBACK.background,
      foreground: colors?.foreground ?? FALLBACK.foreground,
      cursor: colors?.cursor ?? null,
    };
  }

  getLine(y: number): readonly RenderCell[] | null {
    if (y < 0 || y >= this.#screen.rows) {
      return null;
    }
    const foreground: Rgb = this.#colors()?.foreground ?? FALLBACK.foreground;
    return this.#screen.row(y).map((cell) => {
      const style = this.#screen.style(cell.style);
      return {
        text: cell.text,
        width: cell.wide === 1 ? 2 : cell.wide === 2 ? 0 : 1,
        fg: style.fg ?? foreground,
        bg: style.bg,
        underlineColor: style.underline,
        flags: style.flags,
      };
    });
  }

  getCursor(): { x: number; y: number; visible: boolean; shape: CursorShape } {
    const cursor = this.#screen.cursor;
    return {
      x: cursor.x,
      y: cursor.y,
      visible: cursor.visible && cursor.inViewport,
      shape: SHAPES[cursor.style],
    };
  }

  getDimensions(): { cols: number; rows: number } {
    return { cols: this.#screen.cols, rows: this.#screen.rows };
  }

  isRowDirty(y: number): boolean {
    return this.#dirty.has(y);
  }

  needsFullRedraw(): boolean {
    return this.#full;
  }

  clearDirty(): void {
    this.#dirty.clear();
    this.#full = false;
  }

  getPreedit(): string {
    return this.#preedit;
  }
}
