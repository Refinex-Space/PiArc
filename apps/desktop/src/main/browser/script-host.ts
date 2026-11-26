// The agent's script hosts (ADR-0089 rule 3, design addendum B2.2): every `Browser` call runs
// in a fresh sandboxed page of the host partition, which has no network, no storage that
// outlives PiArc and no Node.js. One host is kept warm. The main process answers only the host
// of the run in progress (`isHost`), ends the run at its timeout by crashing the host's
// renderer (an endless loop never yields), and throws the host away afterwards.

import { WebContentsView, type Session, type WebContents } from 'electron';

import type { BrowserRunAnswer } from '@piarc/protocol';

import { BROWSER_HOST_RUN_CHANNEL, type BrowserHostRun } from '../../shared/browser-host.js';
import type { AgentSpaces } from './agent-spaces.js';
import { permissionNote, type HostBindings, type HostRun } from './host-bindings.js';
import { HOST_PARTITION, type BrowserPartitions } from './partitions.js';

/** The host page's scheme (registered as privileged in main.ts). */
export const HOST_SCHEME = 'piarc-browser-host';
/** What a run keeps of its printed output when it never finishes. */
const PARTIAL_OUTPUT_CHARS = 1024 * 1024;
/** How long a host may take to load its page. */
const LOAD_TIMEOUT_MS = 15_000;

/** A run Core asked for (a `core/browser` run event). */
export interface AgentRun {
  readonly runId: string;
  /** The main session: its Spaces. */
  readonly sessionId: string;
  /** The session's workspace (Core's index may not list a session in its first turn). */
  readonly workspace?: string;
  /** The session of the `Browser` call (a subagent's own) and the call: site cards bind to it. */
  readonly callSessionId: string;
  readonly toolCallId: string;
  readonly agentType?: string;
  readonly script: string;
  readonly timeoutMs: number;
}

export interface ScriptHostDeps {
  readonly partitions: BrowserPartitions;
  readonly bindings: HostBindings;
  readonly spaces: AgentSpaces;
  /** The host page (`piarc-browser-host://host/index.html`, or the dev server's page). */
  readonly pageUrl: string;
  /** The host preload (absolute path). */
  readonly preload: string;
  /** Sets up the host partition the first time (protocol, request blocking, permissions). */
  setUpSession(session: Session): void;
  /** Development builds may open DevTools on a host; release builds may not. */
  readonly devTools: boolean;
}

interface Active extends HostRun {
  readonly view: WebContentsView;
  output: string;
  ended: boolean;
}

export class ScriptHosts {
  readonly #active = new Map<number, Active>();
  readonly #byRun = new Map<string, Active>();
  readonly #endings = new Map<string, (answer: BrowserRunAnswer | undefined) => void>();
  readonly #stops = new Map<string, () => void>();
  #spare: Promise<WebContentsView> | undefined;
  #disposed = false;

  constructor(private readonly deps: ScriptHostDeps) {}

  /** Whether `contents` is the host of a run in progress (the IPC channel's check). */
  isHost(contents: WebContents): boolean {
    const active = this.#active.get(contents.id);
    return active !== undefined && !active.ended;
  }

  /** A binding call from a host. */
  async call(sender: WebContents, request: unknown): Promise<unknown> {
    const active = this.#active.get(sender.id);
    if (active === undefined || active.ended) throw new Error('The run has ended');
    if (
      typeof request === 'object' &&
      request !== null &&
      'op' in request &&
      request.op === 'print' &&
      'text' in request &&
      typeof request.text === 'string'
    ) {
      if (active.output.length < PARTIAL_OUTPUT_CHARS) active.output += request.text;
      return null;
    }
    return this.deps.bindings.call(active, request);
  }

  /** Runs one script; resolves with the client's answer, or undefined when it was cancelled. */
  async run(run: AgentRun): Promise<BrowserRunAnswer | undefined> {
    const view = await this.#take();
    const host = view.webContents;
    return new Promise<BrowserRunAnswer | undefined>((resolve) => {
      const active: Active = {
        runId: run.runId,
        caller: {
          sessionId: run.sessionId,
          ...(run.workspace === undefined ? {} : { workspace: run.workspace }),
          ...(run.agentType === undefined ? {} : { agentType: run.agentType }),
          touched: new Set(),
        },
        host,
        view,
        callSessionId: run.callSessionId,
        toolCallId: run.toolCallId,
        images: [],
        refusedMethods: new Set(),
        blockedHosts: new Set(),
        visitedHosts: new Set(),
        refusedPermissions: new Set(),
        allowedHosts: new Set(),
        proxies: new Map(),
        staged: new Set(),
        downloads: new Map(),
        output: '',
        ended: false,
        finished: (result) => {
          end({
            output: result.output,
            ...(result.error === undefined ? {} : { error: result.error }),
          });
        },
      };
      const end = (outcome: Pick<BrowserRunAnswer, 'output' | 'error'> | undefined) => {
        if (active.ended) return;
        active.ended = true;
        clearTimeout(timer);
        this.#endings.delete(run.runId);
        this.#stops.delete(run.runId);
        this.#byRun.delete(run.runId);
        this.deps.bindings.close(active);
        this.deps.spaces.settle(active.caller).catch((error: unknown) => {
          console.warn('[browser] could not end the run in its spaces', error);
        });
        this.#discard(view);
        if (outcome === undefined) {
          resolve(undefined);
          return;
        }
        resolve({
          ...outcome,
          output: outcome.output + permissionNote(active.refusedPermissions),
          ...(active.images.length === 0 ? {} : { images: active.images }),
          ...(active.blockedHosts.size === 0 ? {} : { blockedHosts: [...active.blockedHosts] }),
          // For the audit row only: Core keeps both out of the model's result.
          ...(active.visitedHosts.size === 0 ? {} : { visitedHosts: [...active.visitedHosts] }),
          ...(active.refusedMethods.size === 0
            ? {}
            : { refusedMethods: [...active.refusedMethods] }),
        });
      };
      this.#active.set(host.id, active);
      this.#byRun.set(run.runId, active);
      this.#endings.set(run.runId, (answer) => {
        end(answer);
      });
      this.#stops.set(run.runId, () => {
        end({
          output: active.output,
          error: {
            name: 'Error',
            // i18n-exempt: the model reads it in the tool result; the user never sees it.
            message:
              'The user stopped this browser call. Do not repeat it; ask the user how to go on.',
            code: 'PIARC_STOPPED',
          },
        });
      });
      host.once('render-process-gone', (_event, details) => {
        end({
          output: active.output,
          error: {
            name: 'Error',
            message: `The script host stopped (${details.reason}); the script did not finish`,
            code: 'PIARC_RUN_ENDED',
          },
        });
      });
      const timer = setTimeout(() => {
        const output = active.output;
        end({
          output,
          error: {
            name: 'TimeoutError',
            message: `The script did not finish within ${String(run.timeoutMs)} ms`,
            code: 'PIARC_TIMEOUT',
          },
        });
      }, run.timeoutMs);
      const message: BrowserHostRun = {
        runId: run.runId,
        script: run.script,
        timeoutMs: run.timeoutMs,
      };
      host.send(BROWSER_HOST_RUN_CHANNEL, message);
    });
  }

  /** The run in progress that uses Space `space` of session `sessionId`, if any. */
  runFor(sessionId: string, space: string): HostRun | undefined {
    for (const active of this.#byRun.values()) {
      if (
        !active.ended &&
        active.caller.sessionId === sessionId &&
        active.caller.touched.has(space)
      ) {
        return active;
      }
    }
    return undefined;
  }

  /**
   * The user stopped the run from the panel (B2.5.2): it ends now and Core gets an answer that
   * says so; the turn goes on.
   */
  stop(run: HostRun): void {
    this.#stops.get(run.runId)?.();
  }

  /** Core cancelled the run (interrupt, session closed, Core's own timeout). */
  cancel(runId: string): void {
    this.#endings.get(runId)?.(undefined);
  }

  /** Ends every run and the spare host (app quit). */
  dispose(): void {
    this.#disposed = true;
    for (const end of [...this.#endings.values()]) end(undefined);
    void this.#spare?.then(
      (view) => {
        this.#discard(view);
      },
      () => {
        // The spare never loaded (the app is quitting): nothing to close.
      },
    );
    this.#spare = undefined;
  }

  /** The warm host, replaced by a new one in the background. */
  async #take(): Promise<WebContentsView> {
    const spare = this.#spare ?? this.#create();
    this.#spare = undefined;
    let view: WebContentsView;
    try {
      view = await spare;
    } catch {
      view = await this.#create();
    }
    if (view.webContents.isDestroyed()) view = await this.#create();
    if (!this.#disposed) {
      this.#spare = this.#create();
      this.#spare.catch(() => {
        this.#spare = undefined;
      });
    }
    return view;
  }

  async #create(): Promise<WebContentsView> {
    this.deps.partitions.host((session) => {
      this.deps.setUpSession(session);
    });
    const view = new WebContentsView({
      webPreferences: {
        partition: HOST_PARTITION,
        preload: this.deps.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
        // Scripts wait on timers while the host is never on screen.
        backgroundThrottling: false,
        devTools: this.deps.devTools,
        images: false,
        webgl: false,
        plugins: false,
      },
    });
    const contents = view.webContents;
    contents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    contents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame || event.url !== this.deps.pageUrl) event.preventDefault();
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    const loaded = contents.loadURL(this.deps.pageUrl);
    let cancelTimeout = (): void => undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('The script host did not load'));
      }, LOAD_TIMEOUT_MS);
      cancelTimeout = () => {
        clearTimeout(timer);
      };
    });
    try {
      await Promise.race([loaded, timeout]);
    } catch (error) {
      this.#discard(view);
      throw error;
    } finally {
      cancelTimeout();
    }
    return view;
  }

  #discard(view: WebContentsView): void {
    if (tornDown(view.webContents)) return;
    const contents = view.webContents;
    this.#active.delete(contents.id);
    if (contents.isDestroyed()) return;
    try {
      contents.forcefullyCrashRenderer();
    } catch {
      // Already gone.
    }
    contents.close();
  }
}

/**
 * Whether a view's page is gone without a trace: Electron drops `webContents` from a view it
 * tore down (the app quitting), although its type says it is always there.
 */
function tornDown(contents: WebContents | undefined): contents is undefined {
  return contents === undefined;
}
