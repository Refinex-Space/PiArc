// Where the memory page should open (T47, design addendum sections 4.1 and 4.4): `/memory` and a
// memory row's "Open in settings" in the main window name the session's workspace (and the note)
// before opening the settings window, which takes it once. Both windows share the app's origin,
// so the hand-over is the origin's localStorage; losing it only opens the page on the most
// recently used workspace.

const KEY = 'piarc.memoryTarget';

export interface MemoryTarget {
  readonly workspace: string;
  readonly note?: string;
}

/** Names the workspace (and note) the next memory page shows. */
export function rememberMemoryTarget(target: MemoryTarget): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(target));
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
    const target = parse(window.localStorage.getItem(KEY));
    window.localStorage.removeItem(KEY);
    return target;
  } catch {
    return undefined;
  }
}
