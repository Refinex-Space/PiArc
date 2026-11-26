// Downloads of the agent's pages (ADR-0089, design addendum B2.6.6). While a `Browser` call runs
// in a Space, its tabs' downloads go to the session's temporary directory without a dialog
// (`<session tmp>/browser/downloads/<guid>-<name>`, at most 20 per call, 512 MiB each), and the
// SDK hears about them the way Chromium reports them to a browser connection
// (`Page.downloadWillBegin`, `Page.downloadProgress`; the completed event names the file).
// A download leaves that directory only through Core (`browserFiles` save, `download.saveAs`).

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { DownloadItem, WebContents } from 'electron';

import type { GatedPage } from './agent-gate.js';
import type { HostRun } from './host-bindings.js';

/** Downloads one call may start, and the size of one. */
export const DOWNLOAD_LIMITS = { count: 20, bytes: 512 * 1024 * 1024 } as const;

export interface AgentDownload {
  readonly item: DownloadItem;
  /** Where the browser writes it. */
  readonly file: string;
  state: 'inProgress' | 'completed' | 'canceled';
  /** Settles with the final state once the browser is done with it. */
  readonly done: Promise<'completed' | 'canceled'>;
}

/**
 * Whether `download` completed, waiting up to `waitMs` for one in progress: the SDK's
 * `saveAs()` may come right after the download event, before the last bytes (B2.6.6).
 */
export async function finishedDownload(download: AgentDownload, waitMs: number): Promise<boolean> {
  if (download.state !== 'inProgress') return download.state === 'completed';
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => {
      resolve('late');
    }, waitMs);
  });
  const state = await Promise.race([download.done, late]);
  clearTimeout(timer);
  return state === 'completed';
}

export interface DownloadDeps {
  pageOf(webContentsId: number): GatedPage | undefined;
  runFor(sessionId: string, space: string): HostRun | undefined;
  /** Core's downloads directory of the call's session. */
  directory(sessionId: string): string;
  /** The page's CDP target id. */
  targetIdOf(contents: WebContents): Promise<string>;
}

/** A download name safe as one path segment. */
export function safeName(name: string): string {
  const cleaned = name.replace(/[\p{Cc}\\/:*?"<>|]/gu, '_').replace(/^\.+/u, '');
  const trimmed = cleaned.slice(-120);
  return trimmed === '' ? 'download' : trimmed;
}

/**
 * A path in `dir` for a download named `name` that no file has yet: `name (1).ext`, `name (2)`
 * and so on, the way browsers number them (the user's downloads, B1.3.6).
 */
export function freePath(dir: string, name: string, exists: (file: string) => boolean): string {
  const safe = safeName(name);
  const dot = safe.indexOf('.', 1);
  const stem = dot === -1 ? safe : safe.slice(0, dot);
  const ext = dot === -1 ? '' : safe.slice(dot);
  for (let n = 0; n < 10_000; n += 1) {
    const file = path.join(dir, n === 0 ? safe : `${stem} (${String(n)})${ext}`);
    if (!exists(file)) return file;
  }
  return path.join(dir, `${stem} (${randomUUID()})${ext}`);
}

/** The numeric task space id of a Space id (`agent-<n>`). */
export function spaceNumber(space: string): number | undefined {
  const match = /^agent-(\d+)$/u.exec(space);
  return match === null ? undefined : Number(match[1]);
}

export class AgentDownloads {
  constructor(private readonly deps: DownloadDeps) {}

  /** Takes `item` when an agent's call runs in the page's Space; false leaves it to the user. */
  take(contents: WebContents, item: DownloadItem): boolean {
    const page = this.deps.pageOf(contents.id);
    if (page?.agentControlled !== true) return false;
    const run = this.deps.runFor(page.sessionId, page.space);
    if (run === undefined) return false;
    if (run.downloads.size >= DOWNLOAD_LIMITS.count) {
      item.cancel();
      return true;
    }
    const guid = randomUUID();
    const name = safeName(item.getFilename());
    const file = path.join(this.deps.directory(run.callSessionId), `${guid}-${name}`);
    item.setSavePath(file);
    let settle: (state: 'completed' | 'canceled') => void = () => undefined;
    const done = new Promise<'completed' | 'canceled'>((resolve) => {
      settle = resolve;
    });
    const download: AgentDownload = { item, file, state: 'inProgress', done };
    run.downloads.set(guid, download);
    const space = spaceNumber(page.space);
    const emit = (method: string, params: Record<string, unknown>) => {
      void this.deps.targetIdOf(contents).then(
        (targetId) => {
          if (space !== undefined) run.proxies.get(space)?.emitPage(targetId, method, params);
        },
        () => undefined,
      );
    };
    void this.deps.targetIdOf(contents).then(
      (targetId) => {
        emit('Page.downloadWillBegin', {
          frameId: targetId,
          guid,
          url: item.getURL(),
          suggestedFilename: name,
        });
      },
      () => undefined,
    );
    item.on('updated', () => {
      const received = item.getReceivedBytes();
      if (received > DOWNLOAD_LIMITS.bytes || item.getTotalBytes() > DOWNLOAD_LIMITS.bytes) {
        item.cancel();
        return;
      }
      emit('Page.downloadProgress', {
        guid,
        totalBytes: item.getTotalBytes(),
        receivedBytes: received,
        state: 'inProgress',
      });
    });
    item.once('done', (_event, state) => {
      download.state = state === 'completed' ? 'completed' : 'canceled';
      settle(download.state);
      emit('Page.downloadProgress', {
        guid,
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes(),
        state: download.state,
        ...(download.state === 'completed' ? { filePath: file } : {}),
      });
    });
    return true;
  }
}
