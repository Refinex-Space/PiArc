// Split geometry is independent of React: a tool keeps its identity when a split moves or folds.
export type Axis = 'x' | 'y';
export type Edge = 'left' | 'right' | 'above' | 'below';
export type Tree = string | Split;
interface Split {
  readonly key: number;
  readonly axis: Axis;
  readonly ratio: number;
  readonly first: Tree;
  readonly second: Tree;
}
export interface TileLayout {
  readonly tree?: Tree | undefined;
  readonly mainRatio?: number | undefined;
}
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface Boundary {
  readonly name: string;
  readonly key: 'main' | number;
  readonly axis: Axis;
  readonly rect: Rect;
  readonly origin: number;
  readonly extent: number;
  readonly value: number;
  readonly min: number;
  readonly max: number;
}

const MIN_WIDTH = 250;
const MIN_HEIGHT = 110;
const MAIN_MIN = 320;
const LINE = 1;

function highestKey(tree: Tree): number {
  return typeof tree === 'string'
    ? 0
    : Math.max(tree.key, highestKey(tree.first), highestKey(tree.second));
}
export function leafIds(tree: Tree | undefined): string[] {
  if (tree === undefined) return [];
  return typeof tree === 'string' ? [tree] : [...leafIds(tree.first), ...leafIds(tree.second)];
}

/** Collapse a removed/detached tile's branch without disturbing surviving split keys or proportions. */
export function visibleTree(tree: Tree | undefined, keep: ReadonlySet<string>): Tree | undefined {
  if (tree === undefined || typeof tree === 'string')
    return tree !== undefined && keep.has(tree) ? tree : undefined;
  const first = visibleTree(tree.first, keep);
  const second = visibleTree(tree.second, keep);
  if (first === undefined) return second;
  if (second === undefined) return first;
  return first === tree.first && second === tree.second ? tree : { ...tree, first, second };
}
function replace(tree: Tree, id: string, next: Tree): Tree {
  if (typeof tree === 'string') return tree === id ? next : tree;
  const first = replace(tree.first, id, next);
  const second = replace(tree.second, id, next);
  return first === tree.first && second === tree.second ? tree : { ...tree, first, second };
}
function columns(tree: Tree): number {
  if (typeof tree === 'string') return 1;
  const a = columns(tree.first),
    b = columns(tree.second);
  return tree.axis === 'x' ? a + b : Math.max(a, b);
}
function addTile(tree: Tree | undefined, id: string): Tree {
  if (tree === undefined) return id;
  let right = tree;
  while (typeof right !== 'string' && right.axis === 'x') right = right.second;
  const key = highestKey(tree) + 1;
  if (typeof right === 'string')
    return replace(tree, right, { key, axis: 'y', ratio: 0.5, first: right, second: id });
  const n = columns(tree);
  return { key, axis: 'x', ratio: n / (n + 1), first: tree, second: id };
}

/** Previously closed tools retain their positions until a newly opened tool needs the space. */
export function withOpenTools(layout: TileLayout, ids: readonly string[]): TileLayout {
  const known = new Set(leafIds(layout.tree));
  const added = ids.filter((id) => !known.has(id));
  if (added.length === 0) return layout;
  let tree = visibleTree(layout.tree, new Set(ids));
  for (const id of added) tree = addTile(tree, id);
  return { ...layout, tree };
}

export function moveTile(tree: Tree, from: string, to: string, edge: Edge): Tree {
  const ids = new Set(leafIds(tree));
  if (from === to || !ids.has(from) || !ids.has(to)) return tree;
  ids.delete(from);
  const remaining = visibleTree(tree, ids);
  if (remaining === undefined) return tree;
  const before = edge === 'left' || edge === 'above';
  return replace(remaining, to, {
    key: highestKey(tree) + 1,
    axis: edge === 'left' || edge === 'right' ? 'x' : 'y',
    ratio: 0.5,
    first: before ? from : to,
    second: before ? to : from,
  });
}

function reweight(tree: Tree, key: number, ratio: number): Tree {
  if (typeof tree === 'string') return tree;
  if (tree.key === key) return { ...tree, ratio };
  const first = reweight(tree.first, key, ratio);
  const second = reweight(tree.second, key, ratio);
  return first === tree.first && second === tree.second ? tree : { ...tree, first, second };
}
export function resizeTiles(layout: TileLayout, boundary: Boundary, position: number): TileLayout {
  const value = Math.max(boundary.min, Math.min(boundary.max, position));
  const ratio = value / Math.max(1, boundary.extent);
  if (boundary.key === 'main') return { ...layout, mainRatio: ratio };
  return layout.tree ? { ...layout, tree: reweight(layout.tree, boundary.key, ratio) } : layout;
}

function minimum(tree: Tree, axis: Axis): number {
  if (typeof tree === 'string') return axis === 'x' ? MIN_WIDTH : MIN_HEIGHT;
  const a = minimum(tree.first, axis),
    b = minimum(tree.second, axis);
  return axis === tree.axis ? a + b + LINE : Math.max(a, b);
}

export function tileGeometry(
  layout: TileLayout,
  docked: readonly string[],
  width: number,
  height: number,
  focused: string | undefined,
  maximized?: string,
) {
  const full: Rect = { x: 0, y: 0, width, height };
  const panes = new Map<string, Rect>();
  const boundaries: Boundary[] = [];
  const tree = visibleTree(layout.tree, new Set(docked));
  const compact =
    tree !== undefined &&
    (width < MAIN_MIN + LINE + minimum(tree, 'x') || height < minimum(tree, 'y'));
  const single = width < MAIN_MIN + MIN_WIDTH + LINE;
  const active = focused && docked.includes(focused) ? focused : docked.at(-1);
  let main: Rect | undefined = full;
  if (tree === undefined) return { main, panes, boundaries, compact, single, active };
  if (maximized && docked.includes(maximized)) {
    main = undefined;
    panes.set(maximized, full);
  } else if (single) {
    // An empty focus is the explicit "Conversation" selection in the compact pane switcher.
    if (active && focused !== '') {
      main = undefined;
      panes.set(active, full);
    }
  } else {
    const split = (
      rect: Rect,
      axis: Axis,
      ratio: number,
      minFirst: number,
      minSecond: number,
      key: Boundary['key'],
      name: string,
    ): [Rect, Rect] => {
      const horizontal = axis === 'x';
      const extent = (horizontal ? rect.width : rect.height) - LINE;
      const min = Math.min(extent, minFirst);
      const max = Math.max(min, extent - minSecond);
      const value = Math.round(Math.max(min, Math.min(max, extent * ratio)));
      const first = horizontal ? { ...rect, width: value } : { ...rect, height: value };
      const second = horizontal
        ? { ...rect, x: rect.x + value + LINE, width: extent - value }
        : { ...rect, y: rect.y + value + LINE, height: extent - value };
      const line = horizontal
        ? { ...rect, x: rect.x + value, width: LINE }
        : { ...rect, y: rect.y + value, height: LINE };
      boundaries.push({
        axis,
        key,
        name,
        rect: line,
        origin: horizontal ? rect.x : rect.y,
        extent,
        min,
        max,
        value,
      });
      return [first, second];
    };
    const first = leafIds(tree)[0] ?? '';
    const weight = ['files', 'changes', 'preview'].includes(first) ? 1.5 : 0.5;
    const naturalRatio = 1 / (1 + weight * (compact ? 1 : columns(tree)));
    const [primary, tools] = split(
      full,
      'x',
      layout.mainRatio ?? naturalRatio,
      MAIN_MIN,
      compact ? MIN_WIDTH : minimum(tree, 'x'),
      'main',
      'main',
    );
    main = primary;
    const place = (node: Tree, rect: Rect, path: string) => {
      if (typeof node === 'string') {
        panes.set(node, rect);
        return;
      }
      const [a, b] = split(
        rect,
        node.axis,
        node.ratio,
        minimum(node.first, node.axis),
        minimum(node.second, node.axis),
        node.key,
        path,
      );
      place(node.first, a, path + '-a');
      place(node.second, b, path + '-b');
    };
    if (compact && active) panes.set(active, tools);
    else place(tree, tools, 'tools');
  }
  return { main, panes, boundaries, compact, single, active };
}

export function dropEdge(rect: Rect, x: number, y: number): Edge {
  const horizontal = (x - rect.x) / Math.max(1, rect.width);
  const vertical = (y - rect.y) / Math.max(1, rect.height);
  if (Math.min(horizontal, 1 - horizontal) < Math.min(vertical, 1 - vertical))
    return horizontal < 0.5 ? 'left' : 'right';
  return vertical < 0.5 ? 'above' : 'below';
}

/** Only recover bounded, well-formed layouts from this window's session storage. */
export function readTileLayout(json: string | null): TileLayout {
  if (!json || json.length > 16384) return {};
  try {
    const data: unknown = JSON.parse(json);
    const keys = new Set<number>(),
      ids = new Set<string>();
    const ratio = (v: unknown): v is number =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1;
    const valid = (v: unknown, depth: number): v is Tree => {
      if (depth > 24) return false;
      if (typeof v === 'string') {
        if (!v || ids.has(v)) return false;
        ids.add(v);
        return true;
      }
      if (
        !v ||
        typeof v !== 'object' ||
        !('axis' in v) ||
        !('ratio' in v) ||
        !('key' in v) ||
        !('first' in v) ||
        !('second' in v) ||
        (v.axis !== 'x' && v.axis !== 'y') ||
        !ratio(v.ratio) ||
        typeof v.key !== 'number' ||
        !Number.isSafeInteger(v.key) ||
        keys.has(v.key)
      )
        return false;
      keys.add(v.key);
      return valid(v.first, depth + 1) && valid(v.second, depth + 1);
    };
    if (!data || typeof data !== 'object' || !('tree' in data) || !valid(data.tree, 0)) return {};
    return {
      tree: data.tree,
      ...('mainRatio' in data && ratio(data.mainRatio) ? { mainRatio: data.mainRatio } : {}),
    };
  } catch {
    return {};
  }
}
