// Adapted from Markdown Studio e6ebd0c, web/core/features/viewers/imageZoom.ts and
// markdown/media/MediaViewerDialog.tsx (Apache-2.0). Geometry uses CSS pixels in the owning window.
export interface MediaSize {
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}
export type Fitting = 'window' | 'width' | null;
export interface Camera extends Point {
  zoom: number;
  turns: number;
  fit: Fitting;
}
export const MAX_ZOOM = 64;
export const MIN_ZOOM = 1 / 32;
const inset = 24;
export function rotated(size: MediaSize, turns: number): MediaSize {
  return turns % 2 ? { width: size.height, height: size.width } : size;
}
function available(v: number) {
  return Math.max(1, v - 2 * Math.min(inset, v / 8));
}
export function stepZoom(z: number, direction: 1 | -1) {
  const next = direction === 1 ? z * 1.25 : z / 1.25;
  if ((z < 1 && next > 1) || (z > 1 && next < 1)) return 1;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
}
function constrainAxis(pos: number, content: number, viewport: number) {
  const lo = content <= viewport ? 0 : viewport - content - inset,
    hi = content <= viewport ? viewport - content : inset;
  return Math.min(hi, Math.max(lo, pos));
}
export function constrain(camera: Camera, natural: MediaSize, viewport: MediaSize): Camera {
  const b = rotated(natural, camera.turns);
  return {
    ...camera,
    x: constrainAxis(camera.x, b.width * camera.zoom, viewport.width),
    y: constrainAxis(camera.y, b.height * camera.zoom, viewport.height),
  };
}
export function place(
  natural: MediaSize,
  viewport: MediaSize,
  turns: number,
  fit: Fitting,
  cap: number,
  manualZoom = 1,
): Camera {
  const b = rotated(natural, turns);
  const width = available(viewport.width) / b.width,
    height = available(viewport.height) / b.height;
  const zoom =
    fit === 'window'
      ? Math.min(cap, width, height)
      : fit === 'width'
        ? Math.min(MAX_ZOOM, width)
        : manualZoom;
  return {
    fit,
    turns,
    zoom,
    x: (viewport.width - b.width * zoom) / 2,
    y: b.height * zoom <= viewport.height ? (viewport.height - b.height * zoom) / 2 : inset,
  };
}
export function zoomAround(
  camera: Camera,
  z: number,
  from: Point,
  to: Point,
  natural: MediaSize,
  viewport: MediaSize,
): Camera {
  const zoom = Math.max(Math.min(MIN_ZOOM, camera.zoom), Math.min(MAX_ZOOM, z)),
    ratio = zoom / camera.zoom;
  return constrain(
    {
      ...camera,
      fit: null,
      zoom,
      x: to.x - (from.x - camera.x) * ratio,
      y: to.y - (from.y - camera.y) * ratio,
    },
    natural,
    viewport,
  );
}
/** An SVG percentage width has no intrinsic CSS-pixel width. Only the root viewBox
 * numbers are used as sizing metadata; the document itself stays a passive image. */
export function diagramSize(svg: string): MediaSize | undefined {
  const root = /^<svg\b[^>]*>/u.exec(svg)?.[0],
    viewBox = root && /\sviewBox\s*=\s*(["'])(.*?)\1/u.exec(root)?.[2];
  if (!viewBox) return;
  const parts = viewBox
      .trim()
      .split(/[\s,]+/u)
      .map(Number),
    w = parts[2],
    h = parts[3];
  if (
    parts.length === 4 &&
    parts.every(Number.isFinite) &&
    w &&
    h &&
    w > 0 &&
    h > 0 &&
    w <= 1_000_000 &&
    h <= 1_000_000
  )
    return { width: w, height: h };
  return undefined;
}
