import { describe, expect, it } from 'vitest';
import {
  dropEdge,
  leafIds,
  moveTile,
  readTileLayout,
  resizeTiles,
  tileGeometry,
  visibleTree,
  withOpenTools,
} from './tool-layout.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing expected tile geometry');
  return value;
}

describe('session tool tile geometry', () => {
  const ids = ['terminal', 'changes', 'preview'];
  const layout = withOpenTools({}, ids);
  it('stacks the second pane below the first and opens the third in a new column', () => {
    const g = tileGeometry(layout, ids, 1600, 900, undefined);
    const terminal = required(g.panes.get('terminal')),
      changes = required(g.panes.get('changes')),
      preview = required(g.panes.get('preview'));
    expect(g.main?.x).toBe(0);
    expect(terminal.x).toBe(changes.x);
    expect(terminal.y + terminal.height + 1).toBe(changes.y);
    expect(preview.x).toBe(terminal.x + terminal.width + 1);
    expect(preview.height).toBe(900);
    expect(preview.x + preview.width).toBe(1600);
    expect(g.boundaries.map((b) => b.axis)).toEqual(['x', 'x', 'y']);
  });
  it('removes a leaf without losing sibling shares; reopening the same tools preserves the layout', () => {
    const projected = visibleTree(layout.tree, new Set(['changes', 'preview']));
    expect(leafIds(projected)).toEqual(['changes', 'preview']);
    expect(withOpenTools(layout, ['changes', 'preview'])).toBe(layout);
    expect(withOpenTools(layout, ids)).toBe(layout);
    const moved = moveTile(required(layout.tree), 'preview', 'changes', 'left');
    const g = tileGeometry({ tree: moved }, ids, 1600, 900, undefined);
    expect(required(g.panes.get('preview')).y).toBe(required(g.panes.get('changes')).y);
    expect(required(g.panes.get('preview')).x).toBeLessThan(required(g.panes.get('changes')).x);
    expect(moved).toBe(moveTile(moved, 'changes', 'changes', 'left'));
  });
  it('clamps drags to the space each subtree needs, and restores the original rectangles after maximize', () => {
    const g = tileGeometry(layout, ids, 1600, 900, undefined);
    const boundary = required(g.boundaries[0]);
    const changed = resizeTiles(layout, boundary, 99999);
    const resized = tileGeometry(changed, ids, 1600, 900, undefined);
    expect(required(resized.main).width).toBe(boundary.max);
    expect(required(resized.panes.get('terminal')).width).toBeGreaterThanOrEqual(250);
    const full = tileGeometry(changed, ids, 1600, 900, undefined, 'changes');
    expect(full.main).toBeUndefined();
    expect([...full.panes]).toEqual([['changes', { x: 0, y: 0, width: 1600, height: 900 }]]);
    expect(tileGeometry(changed, ids, 1600, 900, undefined)).toEqual(resized);
  });
  it('collapses extra columns at intermediate widths and offers the conversation at the smallest width', () => {
    const middle = tileGeometry(layout, ids, 760, 900, 'preview');
    expect(middle.main).toBeDefined();
    expect([...middle.panes.keys()]).toEqual(['preview']);
    expect(tileGeometry(layout, ids, 400, 650, 'terminal').main).toBeUndefined();
    expect(tileGeometry(layout, ids, 400, 650, '').panes.size).toBe(0);
    expect(tileGeometry(layout, ['changes'], 400, 650, 'preview', 'preview').active).toBe(
      'changes',
    );
  });
  it('uses viewport-relative drop distances and validates persisted split data', () => {
    const box = { x: 100, y: 200, width: 800, height: 200 };
    expect(dropEdge(box, 130, 300)).toBe('left');
    expect(dropEdge(box, 880, 300)).toBe('right');
    expect(dropEdge(box, 500, 215)).toBe('above');
    expect(dropEdge(box, 500, 395)).toBe('below');
    expect(readTileLayout(JSON.stringify(layout))).toEqual(layout);
    expect(
      readTileLayout('{"tree":{"key":1,"axis":"x","ratio":0.4,"first":"a","second":"a"}}'),
    ).toEqual({});
    expect(readTileLayout('{"tree":{"key":1,"axis":"x","ratio":-1}}')).toEqual({});
  });
});
