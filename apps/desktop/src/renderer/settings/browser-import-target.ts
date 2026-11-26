// The site information menu's "Import this site's sign-ins from Chrome" (B5.1) names the
// workspace and the page's host for the settings page in this workbench; read once.
const KEY = 'piarc.browserImportTarget';

export interface BrowserImportTarget {
  readonly workspace?: string;
  readonly host: string;
}

/** Names the workspace and host the next browser page opens its import for. */
export function rememberImportTarget(target: BrowserImportTarget): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(target));
  } catch {
    // Storage unavailable: the page opens without the import.
  }
}

/** The target named for this page, once: reading it clears it. */
export function takeImportTarget(): BrowserImportTarget | undefined {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return undefined;
    const host: unknown = Reflect.get(value, 'host');
    const workspace: unknown = Reflect.get(value, 'workspace');
    if (typeof host !== 'string' || host === '') return undefined;
    return typeof workspace === 'string' && workspace !== '' ? { host, workspace } : { host };
  } catch {
    return undefined;
  }
}
