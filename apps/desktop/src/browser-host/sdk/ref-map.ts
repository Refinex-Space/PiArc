// Ported from ego-browser package/ego-browser/src/ref-map.ts (ego-lite commit 56589ea8, MIT, see
// LICENSE). PiArc: typed entries (`RefEntry`); behavior unchanged.

/** Where a ref's frame came from: the Page itself, a frame, or an id that could not be tied. */
export type FrameProvenance = 'page' | 'frame' | 'unknown';

export interface RefEntry {
  backendNodeId: number | undefined;
  role: string | undefined;
  name: string | undefined;
  nth: number | undefined;
  frameId: string | undefined;
  frameProvenance?: FrameProvenance;
}

export class RefMap {
  map: Map<string, RefEntry>;
  readonly allowFallback: boolean;

  constructor({ allowFallback = true }: { allowFallback?: boolean } = {}) {
    this.map = new Map();
    this.allowFallback = allowFallback;
  }

  add(
    refId: string,
    backendNodeId: number | undefined,
    role: string | undefined,
    name: string | undefined,
    nth?: number,
  ): void {
    this.addWithFrame(refId, backendNodeId, role, name, nth, undefined);
  }

  addWithFrame(
    refId: string,
    backendNodeId: number | undefined,
    role: string | undefined,
    name: string | undefined,
    nth?: number,
    frameId?: string,
    frameProvenance?: FrameProvenance,
  ): void {
    this.map.set(refId, {
      backendNodeId,
      role,
      name,
      nth,
      frameId,
      ...(frameProvenance ? { frameProvenance } : {}),
    });
  }

  get(refId: string): RefEntry | undefined {
    return this.map.get(refId);
  }

  clear(): void {
    this.map.clear();
  }
}

export function parseRef(input: unknown): string | null {
  const text = typeof input === 'string' ? input : typeof input === 'number' ? String(input) : '';
  const trimmed = text.trim();
  for (const candidate of [
    trimmed.startsWith('@') ? trimmed.slice(1) : null,
    trimmed.startsWith('ref=') ? trimmed.slice(4) : null,
    trimmed,
  ]) {
    if (candidate && /^\d+$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}
