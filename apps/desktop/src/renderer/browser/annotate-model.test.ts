import { describe, expect, it } from 'vitest';

import {
  addShape,
  annotationItems,
  bigEnough,
  clear,
  EMPTY_ANNOTATION,
  hasWork,
  numbered,
  rectOf,
  redo,
  setComment,
  undo,
  type Shape,
} from './annotate-model.js';

const box = (id: string, kind: 'rect' | 'ellipse' | 'redact' | 'arrow' = 'rect'): Shape => ({
  id,
  kind,
  color: 'danger',
  width: 4,
  from: { x: 30, y: 40 },
  to: { x: 10, y: 20 },
});
const marker = (id: string): Shape => ({
  id,
  kind: 'marker',
  color: 'accent',
  width: 2,
  at: { x: 5.4, y: 6.6 },
});

describe('annotation model', () => {
  it('undoes and redoes whole shape lists; clear is undoable', () => {
    let state = addShape(EMPTY_ANNOTATION, box('a'));
    state = addShape(state, marker('b'));
    expect(state.shapes.map((s) => s.id)).toEqual(['a', 'b']);
    state = undo(state);
    expect(state.shapes.map((s) => s.id)).toEqual(['a']);
    state = redo(state);
    expect(state.shapes.map((s) => s.id)).toEqual(['a', 'b']);
    state = clear(state);
    expect(state.shapes).toEqual([]);
    expect(hasWork(state)).toBe(false);
    state = undo(state);
    expect(state.shapes).toHaveLength(2);
    // A new shape after an undo drops the redo branch.
    state = addShape(undo(state), box('c'));
    expect(redo(state).shapes.map((s) => s.id)).toEqual(['a', 'c']);
    expect(undo(EMPTY_ANNOTATION)).toBe(EMPTY_ANNOTATION);
    expect(redo(EMPTY_ANNOTATION)).toBe(EMPTY_ANNOTATION);
  });

  it('numbers boxes and markers in drawing order, not arrows or redactions', () => {
    const shapes = [
      box('a'),
      box('x', 'arrow'),
      marker('b'),
      box('r', 'redact'),
      box('c', 'ellipse'),
    ];
    expect(numbered(shapes).map(({ n, shape }) => [n, shape.id])).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ]);
  });

  it('gives each number an item with its comment', () => {
    let state = EMPTY_ANNOTATION;
    for (const shape of [box('a'), marker('b')]) state = addShape(state, shape);
    state = setComment(state, 'b', 'Too much padding');
    expect(annotationItems(state)).toEqual([
      {
        n: 1,
        kind: 'box',
        title: 'box at x 10, y 20, 20 × 20',
        data: [['area', 'x 10, y 20, 20 × 20 (image px)']],
        comment: '',
      },
      {
        n: 2,
        kind: 'marker',
        title: 'marker at x 5, y 7',
        data: [['position', 'x 5, y 7 (image px)']],
        comment: 'Too much padding',
      },
    ]);
  });

  it('normalizes rectangles and ignores clicks', () => {
    expect(rectOf({ x: 30, y: 40 }, { x: 10, y: 20 })).toEqual({
      x: 10,
      y: 20,
      width: 20,
      height: 20,
    });
    expect(bigEnough({ x: 0, y: 0 }, { x: 2, y: 3 })).toBe(false);
    expect(bigEnough({ x: 0, y: 0 }, { x: 0, y: 4 })).toBe(true);
  });
});
