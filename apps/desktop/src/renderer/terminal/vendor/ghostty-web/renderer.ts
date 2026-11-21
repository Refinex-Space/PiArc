/**
 * Canvas Renderer for Terminal Display
 *
 * Forked from ghostty-web (https://github.com/coder/ghostty-web), file lib/renderer.ts at
 * commit 640db4617c69a73ccebce437cebc598c7f73cdb7 (v0.4.0-21-g640db46; the file last changed
 * in 174a5547a4a6f178455f10e7928adb4fd300896f).
 *
 * Copyright (c) 2025 Coder. Licensed under the MIT License; the full text is in LICENSE next
 * to this file.
 *
 * Modified for PiArc (ADR-0017): the data source is a terminal state held by PiArc Core and
 * delivered as frames, not ghostty-web's WASM terminal. The list of changes is in README.md
 * next to this file.
 */

// ============================================================================
// Data source interface
// ============================================================================

/** An RGB color. */
export interface RenderRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * One cell, ready to draw. PiArc change: cells carry their grapheme text and resolved colors
 * instead of ghostty-web's codepoint, grapheme length and packed RGB fields.
 */
export interface RenderCell {
  /** The grapheme cluster; '' for an empty cell. */
  readonly text: string;
  /** 0 for the spacer half of a wide character, 1 normal, 2 wide. */
  readonly width: number;
  /** Foreground, already resolved (default foreground when the cell has none). */
  readonly fg: RenderRgb;
  /** Background, or null for the terminal background. */
  readonly bg: RenderRgb | null;
  /** Underline color, or null for the foreground. */
  readonly underlineColor: RenderRgb | null;
  /** libghostty-vt style flags (see CELL_FLAGS). */
  readonly flags: number;
}

/** libghostty-vt style flag bits. PiArc change: replaces ghostty-web's CellFlags. */
export const CELL_FLAGS = {
  BOLD: 1,
  ITALIC: 1 << 1,
  FAINT: 1 << 2,
  BLINK: 1 << 3,
  INVERSE: 1 << 4,
  INVISIBLE: 1 << 5,
  STRIKETHROUGH: 1 << 6,
  OVERLINE: 1 << 7,
  UNDERLINE_MASK: 0x7 << 8,
} as const;

export type CursorShape = 'block' | 'underline' | 'bar' | 'blockHollow';

/** PiArc addition: columns of a row, both included. */
export interface CellSpan {
  readonly start: number;
  readonly end: number;
}

/** PiArc addition: a find-bar match on a row; `current` is the one the bar points at. */
export interface Highlight extends CellSpan {
  readonly current: boolean;
}

/** PiArc addition: colors the viewer draws with that do not come from the terminal. */
export interface ViewColors {
  readonly selection: RenderRgb;
  readonly findMatch: RenderRgb;
  readonly findCurrent: RenderRgb;
}

/** Interface for objects that can be rendered. */
export interface IRenderable {
  getLine(y: number): readonly RenderCell[] | null;
  getCursor(): { x: number; y: number; visible: boolean; shape: CursorShape };
  getDimensions(): { cols: number; rows: number };
  isRowDirty(y: number): boolean;
  /** Returns true if a full redraw is needed (e.g., screen change) */
  needsFullRedraw?(): boolean;
  clearDirty(): void;
  /** PiArc addition: the terminal's colors come from the data source, not a theme. */
  getColors(): { background: RenderRgb; foreground: RenderRgb; cursor: RenderRgb | null };
  /** PiArc addition: input-method preedit text to draw at the cursor ('' for none). */
  getPreedit?(): string;
  /** PiArc addition: the selected columns of row `y` (they come in the frame). */
  getSelection?(y: number): CellSpan | null;
  /** PiArc addition: find-bar matches on row `y`. */
  getHighlights?(y: number): readonly Highlight[];
  /** PiArc addition: the link under the pointer, underlined while hovered. */
  getHoveredLink?(): (CellSpan & { readonly row: number }) | null;
  /** PiArc addition: selection and find colors (from the design tokens). */
  getViewColors?(): ViewColors;
}

// ============================================================================
// Type Definitions
// ============================================================================

export interface RendererOptions {
  fontSize?: number; // Default: 15
  fontFamily?: string; // Default: 'monospace'
  devicePixelRatio?: number; // Default: window.devicePixelRatio
}

/**
 * PiArc change: metrics are in device pixels, measured with the font at its device size, and
 * the canvas draws without a scale transform. Cells then start on whole device pixels at any
 * ratio (1.25, 1.5, ...), so backgrounds, lines and the cursor stay crisp; upstream measured
 * in CSS pixels and scaled, which blurs at fractional ratios.
 */
export interface FontMetrics {
  width: number; // Character cell width in device pixels
  height: number; // Character cell height in device pixels
  baseline: number; // Distance from top to text baseline, device pixels
}

/** PiArc addition: Powerline separators drawn as shapes filling their cell. */
const POWERLINE = new Set(['\ue0b0', '\ue0b1', '\ue0b2', '\ue0b3']);

function rgbToCSS(color: RenderRgb): string {
  return `rgb(${String(color.r)}, ${String(color.g)}, ${String(color.b)})`;
}

// ============================================================================
// CanvasRenderer Class
// ============================================================================

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private fontSize: number;
  private fontFamily: string;
  private devicePixelRatio: number;
  private metrics: FontMetrics;

  private lastCursorPosition: { x: number; y: number } = { x: 0, y: 0 };
  /** PiArc addition: the preedit drawn last, to repaint the cursor line when it changes. */
  private lastPreedit = '';
  /** PiArc addition: the cursor's look drawn last (blink phase, focus), same reason. */
  private lastCursorLook = '';
  /** PiArc addition: the hovered link drawn last, to repaint its row when it changes. */
  private lastLinkRow = -1;

  // Current buffer being rendered
  private currentBuffer: IRenderable | null = null;
  /** PiArc addition: advance widths of wide glyphs per font, for centering them. */
  private wideGlyphWidths = new Map<string, number>();
  private background: RenderRgb = { r: 0, g: 0, b: 0 };

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    this.ctx = ctx;

    // Apply options
    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? 'monospace';
    this.devicePixelRatio = options.devicePixelRatio ?? window.devicePixelRatio;

    // Measure font metrics
    this.metrics = this.measureFont();
  }

  // ==========================================================================
  // Font Metrics Measurement
  // ==========================================================================

  private measureFont(): FontMetrics {
    // Use an offscreen canvas for measurement
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }

    // Set font (use actual pixel size for accurate measurement). PiArc change: the device
    // size, so the cell is a whole number of device pixels.
    ctx.font = this.font('');

    // Measure width using 'M' (typically widest character)
    const widthMetrics = ctx.measureText('M');
    const width = Math.ceil(widthMetrics.width);

    // Measure height using ascent + descent with padding for glyph overflow
    const size = this.fontSize * this.devicePixelRatio;
    const ascent = widthMetrics.actualBoundingBoxAscent || size * 0.8;
    const descent = widthMetrics.actualBoundingBoxDescent || size * 0.2;

    // Add 2px padding to height to account for glyphs that overflow (like 'f', 'd', 'g', 'p')
    // and anti-aliasing pixels (PiArc: 2 CSS pixels, in device pixels)
    const pad = Math.max(1, Math.round(this.devicePixelRatio));
    const height = Math.ceil(ascent + descent) + 2 * pad;
    const baseline = Math.ceil(ascent) + pad; // Offset baseline by half the padding

    return { width, height, baseline };
  }

  /**
   * Remeasure font metrics (call after font loads or changes)
   */
  public remeasureFont(): void {
    this.metrics = this.measureFont();
  }

  /** PiArc addition: a font string at device size (`style` is '', 'bold ', 'italic ', ...). */
  private font(style: string): string {
    return `${style}${String(this.fontSize * this.devicePixelRatio)}px ${this.fontFamily}`;
  }

  /** PiArc addition: a line one device pixel per CSS pixel wide. */
  private get lineWidth(): number {
    return Math.max(1, Math.round(this.devicePixelRatio));
  }

  // ==========================================================================
  // Canvas Sizing
  // ==========================================================================

  /**
   * Resize canvas to fit terminal dimensions
   */
  public resize(cols: number, rows: number): void {
    const width = cols * this.metrics.width;
    const height = rows * this.metrics.height;

    // Set CSS size (what user sees). PiArc change: device size divided by the ratio.
    this.canvas.style.width = `${String(width / this.devicePixelRatio)}px`;
    this.canvas.style.height = `${String(height / this.devicePixelRatio)}px`;

    // Set actual canvas size (device pixels; PiArc: drawn without a scale transform)
    this.canvas.width = width;
    this.canvas.height = height;

    // Set text rendering properties for crisp text
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.textAlign = 'left';

    // Fill background after resize
    this.ctx.fillStyle = rgbToCSS(this.background);
    this.ctx.fillRect(0, 0, width, height);
  }

  // ==========================================================================
  // Main Rendering
  // ==========================================================================

  /**
   * Render the terminal buffer to canvas
   */
  public render(buffer: IRenderable, forceAll = false): void {
    // Store buffer reference for cursor redraws
    this.currentBuffer = buffer;

    const cursor = buffer.getCursor();
    const dims = buffer.getDimensions();
    const colors = buffer.getColors();
    const preedit = buffer.getPreedit?.() ?? '';

    // Check if buffer needs full redraw (e.g., screen change between normal/alternate)
    if (buffer.needsFullRedraw?.()) {
      forceAll = true;
    }
    if (!sameRgb(colors.background, this.background)) {
      this.background = colors.background;
      forceAll = true;
    }

    // Resize canvas if dimensions changed
    const needsResize =
      this.canvas.width !== dims.cols * this.metrics.width ||
      this.canvas.height !== dims.rows * this.metrics.height;

    if (needsResize) {
      this.resize(dims.cols, dims.rows);
      forceAll = true; // Force full render after resize
    }

    // Determine which rows need rendering.
    // We also include adjacent rows (above and below) for each dirty row to handle
    // glyph overflow - tall glyphs like Devanagari vowel signs can extend into
    // adjacent rows' visual space.
    const rowsToRender = new Set<number>();
    const addRow = (y: number) => {
      if (y < 0 || y >= dims.rows) {
        return;
      }
      rowsToRender.add(y);
      if (y > 0) rowsToRender.add(y - 1);
      if (y < dims.rows - 1) rowsToRender.add(y + 1);
    };
    for (let y = 0; y < dims.rows; y++) {
      if (forceAll || buffer.isRowDirty(y)) {
        addRow(y);
      }
    }

    // Check if cursor position or preedit changed (need to redraw cursor lines)
    const cursorMoved =
      cursor.x !== this.lastCursorPosition.x || cursor.y !== this.lastCursorPosition.y;
    const look = `${String(cursor.visible)} ${cursor.shape}`;
    if (cursorMoved || preedit !== this.lastPreedit || look !== this.lastCursorLook) {
      addRow(cursor.y);
      addRow(this.lastCursorPosition.y);
    }
    // PiArc addition: the hovered link's underline comes and goes with the pointer.
    const link = buffer.getHoveredLink?.() ?? null;
    const linkRow = link?.row ?? -1;
    if (linkRow !== this.lastLinkRow) {
      addRow(linkRow);
      addRow(this.lastLinkRow);
    } else if (linkRow >= 0) {
      addRow(linkRow);
    }

    // Render each line
    const view = buffer.getViewColors?.();
    for (const y of [...rowsToRender].sort((a, b) => a - b)) {
      const line = buffer.getLine(y);
      if (line) {
        this.renderLine(line, y, dims.cols, {
          selection: buffer.getSelection?.(y) ?? null,
          highlights: buffer.getHighlights?.(y) ?? [],
          link: link !== null && link.row === y ? link : null,
          colors: view,
        });
      }
    }

    // Render cursor and preedit on top
    if (preedit !== '') {
      this.renderPreedit(preedit, cursor.x, cursor.y, colors);
    } else if (cursor.visible) {
      this.renderCursor(cursor.x, cursor.y, cursor.shape, colors);
    }

    // Update last cursor position
    this.lastCursorPosition = { x: cursor.x, y: cursor.y };
    this.lastPreedit = preedit;
    this.lastCursorLook = look;
    this.lastLinkRow = linkRow;

    // ALWAYS clear dirty flags after rendering, regardless of forceAll.
    buffer.clearDirty();
  }

  /**
   * Render a single line using two-pass approach:
   * 1. First pass: Draw all cell backgrounds
   * 2. Second pass: Draw all cell text and decorations
   *
   * This two-pass approach is necessary for proper rendering of complex scripts
   * like Devanagari where diacritics (like vowel sign ि) can extend LEFT of the
   * base character into the previous cell's visual area. If we draw backgrounds
   * and text in a single pass (cell by cell), the background of cell N would
   * cover any left-extending portions of graphemes from cell N-1.
   */
  private renderLine(
    line: readonly RenderCell[],
    y: number,
    cols: number,
    marks: {
      readonly selection: CellSpan | null;
      readonly highlights: readonly Highlight[];
      readonly link: CellSpan | null;
      readonly colors: ViewColors | undefined;
    },
  ): void {
    const lineY = y * this.metrics.height;
    const lineWidth = cols * this.metrics.width;

    // Clear line background then fill with the terminal background.
    // clearRect is needed because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, lineY, lineWidth, this.metrics.height);
    this.ctx.fillStyle = rgbToCSS(this.background);
    this.ctx.fillRect(0, lineY, lineWidth, this.metrics.height);

    // PASS 1: Draw all cell backgrounds first
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell === undefined || cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellBackground(cell, x, y, markBackground(marks, x));
    }

    // PASS 2: Draw all cell text and decorations
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell === undefined || cell.width === 0) continue; // Skip spacer cells for wide characters
      const linked = marks.link !== null && x >= marks.link.start && x <= marks.link.end;
      this.renderCellText(cell, x, y, undefined, linked);
    }
  }

  /**
   * Render a cell's background only (Pass 1 of two-pass rendering)
   */
  private renderCellBackground(
    cell: RenderCell,
    x: number,
    y: number,
    mark: RenderRgb | null,
  ): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Inverse swaps foreground and background. PiArc change: a cell without a background
    // of its own uses the terminal background, which ghostty-web approximated as black; the
    // selection and find matches (PiArc) paint over the cell's own background.
    const bg = mark ?? ((cell.flags & CELL_FLAGS.INVERSE) !== 0 ? cell.fg : cell.bg);
    if (bg !== null) {
      this.ctx.fillStyle = rgbToCSS(bg);
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
    }
  }

  /**
   * Render a cell's text and decorations (Pass 2 of two-pass rendering)
   */
  private renderCellText(
    cell: RenderCell,
    x: number,
    y: number,
    colorOverride?: string,
    linked = false,
  ): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Skip rendering if invisible
    if ((cell.flags & CELL_FLAGS.INVISIBLE) !== 0) {
      return;
    }
    const decorated =
      linked ||
      (cell.flags &
        (CELL_FLAGS.UNDERLINE_MASK | CELL_FLAGS.STRIKETHROUGH | CELL_FLAGS.OVERLINE)) !==
        0;
    // PiArc change: empty cells and spaces have no glyph; skip them unless decorated.
    if ((cell.text === '' || cell.text === ' ') && !decorated) {
      return;
    }

    // Set text style
    let fontStyle = '';
    if ((cell.flags & CELL_FLAGS.ITALIC) !== 0) fontStyle += 'italic ';
    if ((cell.flags & CELL_FLAGS.BOLD) !== 0) fontStyle += 'bold ';
    this.ctx.font = this.font(fontStyle);

    // Set text color - use override or normal color (inverse uses the background)
    let color: string;
    if (colorOverride !== undefined) {
      color = colorOverride;
    } else if ((cell.flags & CELL_FLAGS.INVERSE) !== 0) {
      color = rgbToCSS(cell.bg ?? this.background);
    } else {
      color = rgbToCSS(cell.fg);
    }
    this.ctx.fillStyle = color;

    // Apply faint effect
    if ((cell.flags & CELL_FLAGS.FAINT) !== 0) {
      this.ctx.globalAlpha = 0.5;
    }

    // Draw text. PiArc change: a wide glyph (CJK, emoji) is centered in its two cells; fonts
    // draw them narrower than two cells, which left a gap on the right.
    if (POWERLINE.has(cell.text)) {
      // PiArc addition: drawn, not taken from a font (system fonts lack these glyphs).
      this.renderPowerline(cell.text, cellX, cellY, cellWidth);
    } else if (cell.text !== '' && cell.text !== ' ') {
      let textX = cellX;
      if (cell.width === 2) {
        const key = `${this.ctx.font}\u0000${cell.text}`;
        let advance = this.wideGlyphWidths.get(key);
        if (advance === undefined) {
          advance = this.ctx.measureText(cell.text).width;
          this.wideGlyphWidths.set(key, advance);
        }
        textX += Math.max(0, (cellWidth - advance) / 2);
      }
      this.ctx.fillText(cell.text, textX, cellY + this.metrics.baseline);
    }

    // Reset alpha
    if ((cell.flags & CELL_FLAGS.FAINT) !== 0) {
      this.ctx.globalAlpha = 1.0;
    }

    const line = (lineY: number, strokeColor: string) => {
      this.ctx.strokeStyle = strokeColor;
      this.ctx.lineWidth = this.lineWidth;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, lineY);
      this.ctx.lineTo(cellX + cellWidth, lineY);
      this.ctx.stroke();
    };

    // Draw underline (PiArc change: every underline kind is drawn as a single line, in the
    // cell's underline color when it has one; a hovered link is underlined too)
    if (linked || (cell.flags & CELL_FLAGS.UNDERLINE_MASK) !== 0) {
      const underlineColor =
        colorOverride === undefined && cell.underlineColor !== null
          ? rgbToCSS(cell.underlineColor)
          : color;
      line(cellY + this.metrics.baseline + 2 * this.lineWidth, underlineColor);
    }

    // Draw strikethrough
    if ((cell.flags & CELL_FLAGS.STRIKETHROUGH) !== 0) {
      line(cellY + this.metrics.height / 2, color);
    }

    // Draw overline (PiArc addition)
    if ((cell.flags & CELL_FLAGS.OVERLINE) !== 0) {
      line(cellY + this.lineWidth / 2, color);
    }
  }

  /**
   * PiArc addition: Powerline separators U+E0B0–E0B3 as filled or outlined triangles that
   * cover the whole cell, so they meet the neighbouring cells' backgrounds without gaps.
   */
  private renderPowerline(text: string, cellX: number, cellY: number, cellWidth: number): void {
    const right = text === '\ue0b0' || text === '\ue0b1';
    const filled = text === '\ue0b0' || text === '\ue0b2';
    const top = cellY;
    const bottom = cellY + this.metrics.height;
    const tipX = right ? cellX + cellWidth : cellX;
    const baseX = right ? cellX : cellX + cellWidth;
    this.ctx.beginPath();
    this.ctx.moveTo(baseX, top);
    this.ctx.lineTo(tipX, (top + bottom) / 2);
    this.ctx.lineTo(baseX, bottom);
    if (filled) {
      this.ctx.closePath();
      this.ctx.fill();
    } else {
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = this.lineWidth;
      this.ctx.stroke();
    }
  }

  /**
   * Render cursor
   */
  private renderCursor(
    x: number,
    y: number,
    shape: CursorShape,
    colors: ReturnType<IRenderable['getColors']>,
  ): void {
    const cursorX = x * this.metrics.width;
    const cursorY = y * this.metrics.height;

    this.ctx.fillStyle = rgbToCSS(colors.cursor ?? colors.foreground);

    switch (shape) {
      case 'block': {
        // Full cell block
        this.ctx.fillRect(cursorX, cursorY, this.metrics.width, this.metrics.height);
        // Re-draw character under cursor with the background color
        const cell = this.currentBuffer?.getLine(y)?.[x];
        if (cell) {
          this.ctx.save();
          this.ctx.beginPath();
          this.ctx.rect(cursorX, cursorY, this.metrics.width, this.metrics.height);
          this.ctx.clip();
          this.renderCellText(cell, x, y, rgbToCSS(colors.background));
          this.ctx.restore();
        }
        break;
      }

      case 'blockHollow': {
        // PiArc addition: an outlined block (unfocused cursor, DECSCUSR hollow).
        const w = this.lineWidth;
        this.ctx.strokeStyle = this.ctx.fillStyle;
        this.ctx.lineWidth = w;
        this.ctx.strokeRect(
          cursorX + w / 2,
          cursorY + w / 2,
          this.metrics.width - w,
          this.metrics.height - w,
        );
        break;
      }

      case 'underline': {
        // Underline at bottom of cell
        const underlineHeight = Math.max(2, Math.floor(this.metrics.height * 0.15));
        this.ctx.fillRect(
          cursorX,
          cursorY + this.metrics.height - underlineHeight,
          this.metrics.width,
          underlineHeight,
        );
        break;
      }

      case 'bar': {
        // Vertical bar at left of cell
        const barWidth = Math.max(2, Math.floor(this.metrics.width * 0.15));
        this.ctx.fillRect(cursorX, cursorY, barWidth, this.metrics.height);
        break;
      }
    }
  }

  /**
   * PiArc addition: input-method preedit text at the cursor, on the terminal background and
   * underlined, so the person sees what they are composing where it will be inserted.
   */
  private renderPreedit(
    text: string,
    x: number,
    y: number,
    colors: ReturnType<IRenderable['getColors']>,
  ): void {
    const startX = x * this.metrics.width;
    const startY = y * this.metrics.height;
    this.ctx.font = this.font('');
    const width =
      Math.ceil(this.ctx.measureText(text).width / this.metrics.width) * this.metrics.width;
    this.ctx.fillStyle = rgbToCSS(colors.background);
    this.ctx.fillRect(startX, startY, width, this.metrics.height);
    this.ctx.fillStyle = rgbToCSS(colors.foreground);
    this.ctx.fillText(text, startX, startY + this.metrics.baseline);
    this.ctx.strokeStyle = this.ctx.fillStyle;
    this.ctx.lineWidth = this.lineWidth;
    this.ctx.beginPath();
    this.ctx.moveTo(startX, startY + this.metrics.baseline + 2 * this.lineWidth);
    this.ctx.lineTo(startX + width, startY + this.metrics.baseline + 2 * this.lineWidth);
    this.ctx.stroke();
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Update font size
   */
  public setFontSize(size: number): void {
    this.fontSize = size;
    this.wideGlyphWidths.clear();
    this.metrics = this.measureFont();
  }

  /**
   * Update font family
   */
  public setFontFamily(family: string): void {
    this.fontFamily = family;
    this.wideGlyphWidths.clear();
    this.metrics = this.measureFont();
  }

  /**
   * PiArc addition: the window moved to a screen with another ratio (or zoomed); metrics are
   * measured again and the next render redraws everything.
   */
  public setDevicePixelRatio(ratio: number): void {
    if (ratio === this.devicePixelRatio || !(ratio > 0)) return;
    this.devicePixelRatio = ratio;
    this.wideGlyphWidths.clear();
    this.metrics = this.measureFont();
  }

  /** PiArc addition: the ratio the metrics are measured at. */
  public get pixelRatio(): number {
    return this.devicePixelRatio;
  }

  /**
   * Get current font metrics
   */
  public getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  /**
   * Get canvas element
   */
  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Get character cell width (for coordinate conversion). PiArc: device pixels.
   */
  public get charWidth(): number {
    return this.metrics.width;
  }

  /**
   * Get character cell height (for coordinate conversion). PiArc: device pixels.
   */
  public get charHeight(): number {
    return this.metrics.height;
  }

  /**
   * Clear entire canvas
   */
  public clear(): void {
    // clearRect first because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = rgbToCSS(this.background);
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }
}

function sameRgb(a: RenderRgb, b: RenderRgb): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

/** PiArc addition: the background a selection or find match gives column `x`, if any. */
function markBackground(
  marks: {
    readonly selection: CellSpan | null;
    readonly highlights: readonly Highlight[];
    readonly colors: ViewColors | undefined;
  },
  x: number,
): RenderRgb | null {
  const colors = marks.colors;
  if (colors === undefined) return null;
  if (marks.selection !== null && x >= marks.selection.start && x <= marks.selection.end) {
    return colors.selection;
  }
  for (const highlight of marks.highlights) {
    if (x >= highlight.start && x <= highlight.end) {
      return highlight.current ? colors.findCurrent : colors.findMatch;
    }
  }
  return null;
}
