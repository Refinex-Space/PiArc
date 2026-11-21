// The data source of the forked CanvasRenderer, driven by frames from Core (ADR-0017 rule 4):
// it turns the Screen's cells into drawable cells with resolved colors and tells the renderer
// which rows changed in the frames applied since the last draw. The view's own marks (find
// matches, the hovered link, the cursor's blink phase and focus look, the input-method
// preedit) are kept here too; everything about the terminal itself comes from the frames.
import type { FrameColors, FrameCursor, Rgb } from './frame/decoder.js';
import type { AppliedChange, Screen } from './frame/screen.js';
import type {
  CellSpan,
  CursorShape,
  Highlight,
  IRenderable,
  RenderCell,
  RenderRgb,
  ViewColors,
} from './vendor/ghostty-web/renderer.js';

/** The theme's colors (design tokens), used before Core's first frame and for marks. */
export interface ThemeColors extends ViewColors {
  readonly background: RenderRgb;
  readonly foreground: RenderRgb;
  readonly cursor: RenderRgb;
}

/** Colors until the view reads its theme. */
const FALLBACK: ThemeColors = {
  background: { r: 30, g: 30, b: 30 },
  foreground: { r: 212, g: 212, b: 212 },
  cursor: { r: 212, g: 212, b: 212 },
  selection: { r: 60, g: 70, b: 110 },
  findMatch: { r: 90, g: 80, b: 30 },
  findCurrent: { r: 160, g: 120, b: 20 },
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
  #theme: ThemeColors = FALLBACK;
  #highlights = new Map<number, readonly Highlight[]>();
  #link: (CellSpan & { readonly row: number }) | null = null;
  /** The blink phase hides a blinking cursor. */
  #blinkHidden = false;
  #focused = true;

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

  /** Everything must be drawn again (theme, ratio). */
  markAll(): void {
    this.#full = true;
  }

  /** Sets the input-method preedit text drawn at the cursor. */
  setPreedit(text: string): void {
    this.#preedit = text;
  }

  get preedit(): string {
    return this.#preedit;
  }

  setTheme(theme: ThemeColors): void {
    this.#theme = theme;
    this.#full = true;
  }

  get theme(): ThemeColors {
    return this.#theme;
  }

  /** Replaces the find matches, per viewport row. */
  setHighlights(highlights: ReadonlyMap<number, readonly Highlight[]>): void {
    for (const y of [...this.#highlights.keys(), ...highlights.keys()]) {
      this.#dirty.add(y);
    }
    this.#highlights = new Map(highlights);
  }

  setHoveredLink(link: (CellSpan & { readonly row: number }) | null): void {
    this.#link = link;
  }

  get hoveredLink(): (CellSpan & { readonly row: number }) | null {
    return this.#link;
  }

  /** The blink phase; true hides a blinking cursor. */
  setBlinkHidden(hidden: boolean): void {
    this.#blinkHidden = hidden;
  }

  setFocused(focused: boolean): void {
    this.#focused = focused;
  }

  getColors(): { background: RenderRgb; foreground: RenderRgb; cursor: RenderRgb | null } {
    const colors: FrameColors | null = this.#screen.colors;
    return {
      background: colors?.background ?? this.#theme.background,
      foreground: colors?.foreground ?? this.#theme.foreground,
      cursor: colors?.cursor ?? this.#theme.cursor,
    };
  }

  getViewColors(): ViewColors {
    return this.#theme;
  }

  getLine(y: number): readonly RenderCell[] | null {
    if (y < 0 || y >= this.#screen.rows) {
      return null;
    }
    const foreground: Rgb = this.#screen.colors?.foreground ?? this.#theme.foreground;
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
    const shape = SHAPES[cursor.style];
    return {
      x: cursor.x,
      y: cursor.y,
      visible: cursor.visible && cursor.inViewport && !(cursor.blinking && this.#blinkHidden),
      // An unfocused terminal shows an outlined block, as terminals do.
      shape: !this.#focused && shape === 'block' ? 'blockHollow' : shape,
    };
  }

  getDimensions(): { cols: number; rows: number } {
    return { cols: this.#screen.cols, rows: this.#screen.rows };
  }

  getSelection(y: number): CellSpan | null {
    return this.#screen.selection(y);
  }

  getHighlights(y: number): readonly Highlight[] {
    return this.#highlights.get(y) ?? [];
  }

  getHoveredLink(): (CellSpan & { readonly row: number }) | null {
    return this.#link;
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
