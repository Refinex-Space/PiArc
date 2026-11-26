// Recent pages per workspace (design addendum B1.1.1, B1.2.3): what the user opened in their own
// tabs, newest first, for the start page and the address bar's suggestions. Kept in
// `<userData>/browser/recents.json`, written atomically (temporary file and rename) a moment
// after the last change. Workspace files are kept as `./path` so another session of the same
// workspace opens them through its own workspace URL.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { BrowserRecent } from '../../shared/browser.js';

/** Pages kept per workspace (the start page shows the first few). */
export const KEPT_RECENTS = 50;
/** Workspaces kept; the least recently used goes first. */
export const KEPT_WORKSPACES = 100;
const TITLE_CHARS = 300;
const URL_CHARS = 2048;
const SAVE_DELAY_MS = 1000;

/** `list` with `entry` first: one entry per address, a known title kept over an empty one. */
export function remember(
  list: readonly BrowserRecent[],
  entry: BrowserRecent,
  kept = KEPT_RECENTS,
): BrowserRecent[] {
  const previous = list.find((item) => item.url === entry.url);
  const title = (entry.title === '' ? (previous?.title ?? '') : entry.title).slice(0, TITLE_CHARS);
  return [{ url: entry.url, title }, ...list.filter((item) => item.url !== entry.url)].slice(
    0,
    kept,
  );
}

/** Whether `url` is worth keeping: a web page without credentials, or a workspace file. */
export function recordable(url: string): boolean {
  if (url.length > URL_CHARS) return false;
  if (url.startsWith('./')) return true;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

function isRecent(value: unknown): value is BrowserRecent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'url' in value &&
    typeof value.url === 'string' &&
    'title' in value &&
    typeof value.title === 'string'
  );
}

/** The workspaces of a saved file; malformed entries are dropped. */
export function parseRecents(value: unknown): Map<string, BrowserRecent[]> {
  const workspaces = new Map<string, BrowserRecent[]>();
  if (typeof value !== 'object' || value === null || !('workspaces' in value)) return workspaces;
  const saved = value.workspaces;
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return workspaces;
  for (const [workspace, list] of Object.entries(saved)) {
    if (!Array.isArray(list)) continue;
    const entries: readonly unknown[] = list;
    const recents = entries
      .filter(isRecent)
      .filter((entry) => recordable(entry.url))
      .slice(0, KEPT_RECENTS);
    if (recents.length > 0) workspaces.set(workspace, recents);
  }
  return workspaces;
}

export class BrowserRecents {
  #workspaces: Map<string, BrowserRecent[]> | undefined;
  #loading: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(private readonly file: string) {}

  /** The workspace's recent pages, newest first. */
  async list(workspace: string, limit: number): Promise<BrowserRecent[]> {
    await this.#load();
    return (this.#workspaces?.get(workspace) ?? []).slice(0, limit);
  }

  /** The user opened `url` (titled `title`) in a tab of `workspace`. */
  record(workspace: string, url: string, title: string): void {
    if (!recordable(url)) return;
    void this.#load().then(() => {
      const workspaces = this.#workspaces ?? new Map<string, BrowserRecent[]>();
      this.#workspaces = workspaces;
      const list = workspaces.get(workspace) ?? [];
      if (list[0]?.url === url && (title === '' || list[0].title === title)) return;
      workspaces.delete(workspace);
      workspaces.set(workspace, remember(list, { url, title }));
      while (workspaces.size > KEPT_WORKSPACES) {
        const oldest = workspaces.keys().next();
        if (oldest.done === true) break;
        workspaces.delete(oldest.value);
      }
      this.#schedule();
    });
  }

  /** Writes pending changes now (quitting). */
  async flush(): Promise<void> {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#save();
  }

  async #load(): Promise<void> {
    if (this.#workspaces !== undefined) return;
    this.#loading ??= readFile(this.file, 'utf8')
      .then((text) => {
        this.#workspaces ??= parseRecents(JSON.parse(text));
      })
      .catch(() => {
        this.#workspaces ??= new Map();
      });
    await this.#loading;
  }

  #schedule(): void {
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      void this.#save();
    }, SAVE_DELAY_MS);
    this.#timer.unref();
  }

  async #save(): Promise<void> {
    const workspaces = Object.fromEntries(this.#workspaces ?? new Map<string, BrowserRecent[]>());
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, workspaces }));
      await rename(temporary, this.file);
    } catch (error) {
      console.warn('[browser] cannot save the recent pages', error);
    }
  }
}
