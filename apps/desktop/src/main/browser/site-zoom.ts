// Page zoom per site (design addendum B1.3.9). Chromium already applies a zoom to every tab of
// the same host in a partition (its host zoom map), but only in memory and per tab in our
// state; this keeps one value per partition and site, which the service gives every tab of
// that site, and saves the values of persistent partitions (`<userData>/browser/zoom.json`).
// A partition kept only for the session (`storage: session`) never reaches the file.

/** Zoom levels the panel steps through, in percent. */
export const ZOOM_STEPS = [
  25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500,
] as const;

export const ZOOM_LIMITS = {
  /** Sites remembered per partition; the oldest go first. */
  sites: 500,
} as const;

/** The zoom after `step` from `current` (a value between steps moves from 100). */
export function nextZoom(current: number, step: 'in' | 'out' | 'reset'): number {
  if (step === 'reset') return 100;
  const steps: readonly number[] = ZOOM_STEPS;
  const index = steps.indexOf(current);
  const at = index === -1 ? steps.indexOf(100) : index;
  const next = step === 'in' ? Math.min(at + 1, steps.length - 1) : Math.max(at - 1, 0);
  return steps[next] ?? 100;
}

/** The site of a web page (`host:port`), or undefined for pages that are not remembered. */
export function siteOf(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return parsed.host === '' ? undefined : parsed.host;
}

/** Where the saved values live (a file in the app, memory in tests). */
export interface ZoomStore {
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
}

export class SiteZoom {
  readonly #zooms = new Map<string, Map<string, number>>();
  /** Partitions whose values are saved. */
  readonly #persistent = new Set<string>();
  #writing: Promise<void> = Promise.resolve();

  constructor(private readonly store: ZoomStore) {}

  async load(): Promise<void> {
    let saved: unknown;
    try {
      const text = await this.store.read();
      if (text === undefined) return;
      saved = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof saved !== 'object' || saved === null || !('partitions' in saved)) return;
    const partitions = saved.partitions;
    if (typeof partitions !== 'object' || partitions === null) return;
    for (const [key, sites] of Object.entries(partitions)) {
      if (typeof sites !== 'object' || sites === null) continue;
      const map = new Map<string, number>();
      for (const [site, zoom] of Object.entries(sites as Record<string, unknown>)) {
        if (typeof zoom === 'number' && valid(zoom) && map.size < ZOOM_LIMITS.sites) {
          map.set(site, zoom);
        }
      }
      this.#zooms.set(key, map);
      this.#persistent.add(key);
    }
  }

  /** The zoom of `url`'s site in `partition` (100 when not remembered). */
  get(partition: string, url: string): number {
    const site = siteOf(url);
    return site === undefined ? 100 : (this.#zooms.get(partition)?.get(site) ?? 100);
  }

  /** Remembers `zoom` for `url`'s site; `persist` saves it with the partition. */
  set(partition: string, url: string, zoom: number, persist: boolean): void {
    const site = siteOf(url);
    if (site === undefined || !valid(zoom)) return;
    let map = this.#zooms.get(partition);
    if (map === undefined) {
      map = new Map();
      this.#zooms.set(partition, map);
    }
    map.delete(site);
    if (zoom !== 100) map.set(site, zoom);
    while (map.size > ZOOM_LIMITS.sites) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    if (!persist) return;
    this.#persistent.add(partition);
    this.#save();
  }

  /** Forgets every site of `partition` (clearing the workspace's browsing data). */
  forget(partition: string): void {
    this.#zooms.delete(partition);
    if (this.#persistent.delete(partition)) this.#save();
  }

  /** Resolves once the writes queued so far ended. */
  flushed(): Promise<void> {
    return this.#writing;
  }

  #save(): void {
    const partitions: Record<string, Record<string, number>> = {};
    for (const key of this.#persistent) {
      const map = this.#zooms.get(key);
      if (map !== undefined && map.size > 0) partitions[key] = Object.fromEntries(map);
    }
    const text = JSON.stringify({ version: 1, partitions });
    this.#writing = this.#writing
      .then(() => this.store.write(text))
      .catch((error: unknown) => {
        console.warn('[browser] cannot save the site zoom', error);
      });
  }
}

function valid(zoom: number): boolean {
  return (ZOOM_STEPS as readonly number[]).includes(zoom);
}
