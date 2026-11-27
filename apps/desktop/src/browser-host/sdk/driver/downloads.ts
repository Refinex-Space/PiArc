// Ported from ego-browser package/ego-browser/src/driver/downloads.ts (ego-lite commit 56589ea8,
// MIT, see LICENSE). PiArc: no file system. The main process owns the download directory (the
// session's staging area, B2.6.6), so there is no Page.setDownloadBehavior, no shared directory,
// no waiter markers and no file polling: completion comes from Page.downloadProgress, `saveAs`
// goes through the saveFile binding (Core's write policy), `path()` answers the staging name the
// main process reports, and `delete()` only marks the download deleted.

import { browserEgo } from '../browser-runtime.js';
import type { CdpCall, CdpEvent } from '../cdp-types.js';
import { invokeEgo } from '../ego-errors.js';

interface DownloadServices {
  cdp: CdpCall;
  subscribePageEvents(targetId: string, listener: (event: CdpEvent) => void): () => void;
  /** Saves a finished download (its guid) to `path`; the saveFile binding by default. */
  saveFile?: (source: string, path: string) => Promise<void>;
}

type DownloadCompletion = { path: string; failure: null } | { failure: string };

export interface DownloadArtifact {
  readonly url: string;
  readonly suggestedFilename: string;
  readonly finished: Promise<void>;
  saveAs(path: string): Promise<void>;
  path(): Promise<string>;
  failure(): Promise<string | null>;
  cancel(): Promise<void>;
  delete(): Promise<void>;
}

export interface DownloadInterception {
  ready(sessionId: string): Promise<void>;
  event: Promise<DownloadArtifact>;
  dispose(reason?: Error): Promise<void>;
}

// Upstream points every Page at one shared directory with
// Page.setDownloadBehavior("allowAndName") and coordinates waiters across
// processes. In PiArc the main process routes every download of an agent tab
// into the session's staging area under its guid before Chromium starts it,
// and reports the staged name in the completed Page.downloadProgress event.
const activeInterceptions = new Set<() => void>();
const activeDownloadTargets = new Set<string>();

/**
 * Arm one Page session for its next download.
 */
export function preparePageDownload(
  services: DownloadServices,
  targetId: string,
  { timeoutMs }: { timeoutMs: number },
): DownloadInterception {
  if (activeDownloadTargets.has(targetId)) {
    throw new Error(`${targetId} is already waiting for a download`);
  }
  activeDownloadTargets.add(targetId);
  let guid: string | undefined;
  let disposed = false;
  let settled = false;
  let resolveEvent: (artifact: DownloadArtifact) => void = () => undefined;
  let rejectEvent: (error: Error) => void = () => undefined;
  let resolveCompletion: (completion: DownloadCompletion) => void = () => undefined;
  const event = new Promise<DownloadArtifact>((resolve, reject) => {
    resolveEvent = resolve;
    rejectEvent = reject;
  });
  void event.catch(() => undefined);
  const completion = new Promise<DownloadCompletion>((resolve) => {
    resolveCompletion = resolve;
  });

  const finish = (result: DownloadCompletion) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unsubscribe();
    activeInterceptions.delete(disposeSynchronously);
    activeDownloadTargets.delete(targetId);
    resolveCompletion(result);
  };
  const onEvent = (message: CdpEvent) => {
    if (message.method === 'Page.downloadWillBegin' && !guid) {
      const params = message.params;
      if (
        typeof params?.guid !== 'string' ||
        typeof params.url !== 'string' ||
        typeof params.suggestedFilename !== 'string'
      ) {
        return;
      }
      guid = params.guid;
      clearTimeout(timer);
      resolveEvent(
        new PageDownloadArtifact(
          services,
          targetId,
          params.guid,
          params.url,
          params.suggestedFilename,
          completion,
        ),
      );
      return;
    }
    if (message.method !== 'Page.downloadProgress') return;
    const params = message.params;
    if (!guid || params?.guid !== guid) return;
    if (params.state === 'completed') {
      finish({ path: reportedFilePath(params) ?? guid, failure: null });
    } else if (params.state === 'canceled') {
      finish({ failure: 'canceled' });
    }
  };
  const unsubscribe = services.subscribePageEvents(targetId, onEvent);
  const disposeSynchronously = () => {
    if (disposed || settled) return;
    disposed = true;
    clearTimeout(timer);
    unsubscribe();
    activeDownloadTargets.delete(targetId);
    rejectEvent(new Error('download waiter was disposed'));
    resolveCompletion({ failure: 'download waiter was disposed' });
  };
  activeInterceptions.add(disposeSynchronously);
  const timer = setTimeout(() => {
    if (guid || disposed || settled) return;
    disposed = true;
    unsubscribe();
    activeInterceptions.delete(disposeSynchronously);
    activeDownloadTargets.delete(targetId);
    rejectEvent(new Error(`page.waitForEvent("download") timed out after ${String(timeoutMs)}ms`));
    resolveCompletion({ failure: 'download did not start' });
  }, timeoutMs);

  return {
    // Upstream configures the Page's download behavior here; the main process
    // already routes the Page's downloads, so only the waiter state is checked.
    ready() {
      if (disposed || settled) {
        return Promise.reject(new Error('download waiter is no longer active'));
      }
      return Promise.resolve();
    },
    event,
    dispose(reason = new Error('download waiter was disposed')) {
      if (disposed || settled) return Promise.resolve();
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      activeInterceptions.delete(disposeSynchronously);
      activeDownloadTargets.delete(targetId);
      rejectEvent(reason);
      resolveCompletion({ failure: reason.message });
      return Promise.resolve();
    },
  };
}

class PageDownloadArtifact implements DownloadArtifact {
  readonly url: string;
  readonly suggestedFilename: string;
  readonly finished: Promise<void>;
  readonly #services: DownloadServices;
  readonly #targetId: string;
  readonly #guid: string;
  readonly #completion: Promise<DownloadCompletion>;
  #completionResult?: DownloadCompletion;
  #deleted = false;

  constructor(
    services: DownloadServices,
    targetId: string,
    guid: string,
    url: string,
    suggestedFilename: string,
    completion: Promise<DownloadCompletion>,
  ) {
    this.#services = services;
    this.#targetId = targetId;
    this.#guid = guid;
    this.url = url;
    this.suggestedFilename = suggestedFilename;
    this.#completion = completion;
    this.finished = completion.then((result) => {
      this.#completionResult = result;
    });
  }

  async saveAs(path: string): Promise<void> {
    assertAbsolutePath(path, 'download.saveAs');
    await this.path();
    if (this.#deleted) {
      throw new Error('download.saveAs: this download was deleted');
    }
    // Core writes the staged file to `path` under its write policy; missing
    // parent directories are created there.
    const guid = this.#guid;
    if (this.#services.saveFile) {
      await this.#services.saveFile(guid, path);
      return;
    }
    await invokeEgo('download.saveAs', () => browserEgo().saveFile(guid, path));
  }

  async path(): Promise<string> {
    const result = await this.#completion;
    if (!('path' in result)) {
      throw new Error(`download failed: ${result.failure}`);
    }
    return result.path;
  }

  async failure(): Promise<string | null> {
    return (await this.#completion).failure;
  }

  async cancel(): Promise<void> {
    if (this.#isComplete()) return;
    try {
      const targetInfo = await this.#services.cdp('Target.getTargetInfo', {
        targetId: this.#targetId,
      });
      const browserContextId = targetInfo.targetInfo?.browserContextId;
      await this.#services.cdp('Browser.cancelDownload', {
        guid: this.#guid,
        ...(typeof browserContextId === 'string' ? { browserContextId } : {}),
      });
    } catch (error) {
      // The download may have finished while the cancel was in flight.
      if (this.#isComplete()) return;
      throw error;
    }
  }

  #isComplete(): boolean {
    return this.#completionResult !== undefined;
  }

  /**
   * The staged file lives in the session's staging area, which the main
   * process owns and clears with the session; the SDK cannot remove it. The
   * download is only marked deleted so a later `saveAs` fails as upstream's
   * would after its file was removed.
   */
  async delete(): Promise<void> {
    await this.#completion;
    this.#deleted = true;
  }
}

/** The staged name the main process adds to a completed Page.downloadProgress event. */
function reportedFilePath(params: object): string | undefined {
  const filePath: unknown = 'filePath' in params ? params.filePath : undefined;
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : undefined;
}

function isAbsolutePath(path: string): boolean {
  // POSIX `/…`, Windows `C:\…` or `C:/…`, and UNC `\\server\share`.
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

function assertAbsolutePath(path: unknown, method: string): void {
  if (typeof path !== 'string' || path.length === 0 || !isAbsolutePath(path)) {
    throw new TypeError(`${method} requires an absolute file path`);
  }
}

/** Stop pending download waits when a run ends. */
export function disposeDownloadArtifacts(): void {
  for (const dispose of [...activeInterceptions]) dispose();
  activeInterceptions.clear();
  activeDownloadTargets.clear();
}
