// The annotation of a frozen page (design addendum B3.3): shapes on the screenshot in image
// pixels, undo and redo over whole shape lists (clearing is undoable), comments by shape. Boxes
// (rectangles and ellipses) and markers are numbered in the order they were drawn; the numbers
// on the image are the numbers of the context items (B3.5).
import type { BrowserContextItem } from '../composer/browser-context.js';

export const ANNOTATE_TOOLS = [
  'rect',
  'ellipse',
  'arrow',
  'pen',
  'text',
  'marker',
  'redact',
] as const;
export type AnnotateTool = (typeof ANNOTATE_TOOLS)[number];

/** The five colors, each a design token (`annotate.tsx` reads them from CSS). */
export const ANNOTATE_COLORS = ['danger', 'warning', 'success', 'accent', 'neutral'] as const;
export type AnnotateColor = (typeof ANNOTATE_COLORS)[number];

/** Stroke widths in CSS pixels of the shown image. */
export const ANNOTATE_WIDTHS = [2, 4, 8] as const;
export type AnnotateWidth = (typeof ANNOTATE_WIDTHS)[number];

export interface Point {
  readonly x: number;
  readonly y: number;
}

interface Stroke {
  readonly id: string;
  readonly color: AnnotateColor;
  readonly width: AnnotateWidth;
}

export type Shape =
  | (Stroke & {
      readonly kind: 'rect' | 'ellipse' | 'redact' | 'arrow';
      readonly from: Point;
      readonly to: Point;
    })
  | (Stroke & { readonly kind: 'pen'; readonly points: readonly Point[] })
  | (Stroke & { readonly kind: 'text'; readonly at: Point; readonly text: string })
  | (Stroke & { readonly kind: 'marker'; readonly at: Point });

export interface Annotation {
  readonly shapes: readonly Shape[];
  readonly past: readonly (readonly Shape[])[];
  readonly future: readonly (readonly Shape[])[];
  /** Comments by shape id (kept when a shape is undone, so redo brings them back). */
  readonly comments: Readonly<Record<string, string>>;
}

export const EMPTY_ANNOTATION: Annotation = { shapes: [], past: [], future: [], comments: {} };

/** The most shapes one annotation holds. */
export const MAX_SHAPES = 200;

function commit(state: Annotation, shapes: readonly Shape[]): Annotation {
  return { ...state, shapes, past: [...state.past, state.shapes].slice(-100), future: [] };
}

export function addShape(state: Annotation, shape: Shape): Annotation {
  if (state.shapes.length >= MAX_SHAPES) return state;
  return commit(state, [...state.shapes, shape]);
}

export function undo(state: Annotation): Annotation {
  const previous = state.past.at(-1);
  if (previous === undefined) return state;
  return {
    ...state,
    shapes: previous,
    past: state.past.slice(0, -1),
    future: [state.shapes, ...state.future],
  };
}

export function redo(state: Annotation): Annotation {
  const next = state.future[0];
  if (next === undefined) return state;
  return {
    ...state,
    shapes: next,
    past: [...state.past, state.shapes],
    future: state.future.slice(1),
  };
}

export function clear(state: Annotation): Annotation {
  return state.shapes.length === 0 ? state : commit(state, []);
}

export function setComment(state: Annotation, id: string, comment: string): Annotation {
  return { ...state, comments: { ...state.comments, [id]: comment } };
}

/** Whether leaving would lose work (B3.3: confirm before discarding). */
export function hasWork(state: Annotation): boolean {
  return state.shapes.length > 0;
}

/** Whether a shape gets a number: boxes and markers. */
export function numberedKind(shape: Shape): boolean {
  return shape.kind === 'rect' || shape.kind === 'ellipse' || shape.kind === 'marker';
}

/** The numbered shapes with their numbers, in drawing order. */
export function numbered(
  shapes: readonly Shape[],
): { readonly n: number; readonly shape: Shape }[] {
  return shapes.filter(numberedKind).map((shape, index) => ({ n: index + 1, shape }));
}

/** A rectangle from two corners, in whole pixels. */
export function rectOf(
  from: Point,
  to: Point,
): { x: number; y: number; width: number; height: number } {
  const x = Math.round(Math.min(from.x, to.x));
  const y = Math.round(Math.min(from.y, to.y));
  return {
    x,
    y,
    width: Math.round(Math.max(from.x, to.x)) - x,
    height: Math.round(Math.max(from.y, to.y)) - y,
  };
}

/** Whether a drag is long enough to be a shape (a click is not a box). */
export function bigEnough(from: Point, to: Point): boolean {
  return Math.abs(to.x - from.x) >= 4 || Math.abs(to.y - from.y) >= 4;
}

/** The context items of an annotation: one per number, with the user's comment. */
export function annotationItems(state: Annotation): BrowserContextItem[] {
  return numbered(state.shapes).map(({ n, shape }) => {
    const comment = state.comments[shape.id] ?? '';
    if (shape.kind === 'marker') {
      const at = `x ${String(Math.round(shape.at.x))}, y ${String(Math.round(shape.at.y))}`;
      return {
        n,
        kind: 'marker',
        title: `marker at ${at}`,
        data: [['position', `${at} (image px)`]],
        comment,
      };
    }
    const area =
      shape.kind === 'pen' || shape.kind === 'text' ? undefined : rectOf(shape.from, shape.to);
    const where =
      area === undefined
        ? ''
        : `x ${String(area.x)}, y ${String(area.y)}, ${String(area.width)} × ${String(area.height)}`;
    return {
      n,
      kind: 'box',
      title: `${shape.kind === 'ellipse' ? 'ellipse' : 'box'} at ${where}`,
      data: [['area', `${where} (image px)`]],
      comment,
    };
  });
}
