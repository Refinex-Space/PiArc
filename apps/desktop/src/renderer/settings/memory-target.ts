// A memory row or /memory names the destination in this workbench. Its pending target
// survives a reload and cannot be consumed by another open workbench.
const KEY = 'piarc.memoryTarget';

export interface MemoryTarget {
  readonly workspace: string;
  readonly note?: string;
}

/** Names the workspace (and note) the next memory page shows. */
export function rememberMemoryTarget(target: MemoryTarget): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(target));
  } catch {
    // Storage unavailable: the page opens on the most recent workspace instead.
  }
}

function parse(raw: string | null): MemoryTarget | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return undefined;
    const workspace: unknown = Reflect.get(value, 'workspace');
    const note: unknown = Reflect.get(value, 'note');
    if (typeof workspace !== 'string' || workspace === '') return undefined;
    return typeof note === 'string' && note !== '' ? { workspace, note } : { workspace };
  } catch {
    return undefined;
  }
}

/** The target named for this page, once: reading it clears it. */
export function takeMemoryTarget(): MemoryTarget | undefined {
  try {
    const target = parse(window.sessionStorage.getItem(KEY));
    window.sessionStorage.removeItem(KEY);
    return target;
  } catch {
    return undefined;
  }
}
