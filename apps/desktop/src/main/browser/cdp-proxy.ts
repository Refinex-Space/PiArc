// A browser-level DevTools connection for one agent Space (ADR-0089, design addendum §4.4).
// The browser SDK speaks CDP as if it were connected to a whole browser: it lists targets,
// attaches to them with flattened sessions and sends page commands with a `sessionId`. Electron
// gives a debugger per page instead, so this proxy answers the `Target` and `Browser` methods
// itself for the Space's own tabs (other Spaces and the user's tabs do not exist here), hands
// each attached tab a virtual session id, maps the page's own child sessions (out-of-process
// frames) to virtual ids too, and passes page commands through `cdp-policy.ts`.
//
// The session bookkeeping follows the shape of VS Code's browser view CDP proxy
// (src/vs/platform/browserView/common/cdp/proxy.ts, MIT License, Copyright (c) Microsoft
// Corporation); the code is PiArc's.

import {
  agentEmulation,
  browserCommand,
  pageCommand,
  pageEvent,
  type AgentEmulation,
} from './cdp-policy.js';

/** One page's debugger, as Electron's `webContents.debugger` offers it. */
export interface PageDebugger {
  sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown>;
  on(
    event: 'message',
    listener: (event: unknown, method: string, params: unknown, sessionId: string) => void,
  ): void;
  removeListener(
    event: 'message',
    listener: (event: unknown, method: string, params: unknown, sessionId: string) => void,
  ): void;
}

/** A tab of the Space as the proxy sees it. */
export interface ProxyTab {
  /** The page's own CDP target id (the main frame's id). */
  readonly targetId: string;
  readonly url: string;
  readonly title: string;
  readonly openerId?: string;
}

/** What the proxy needs from the Space. */
export interface ProxySpace {
  tabs(): readonly ProxyTab[];
  /** The tab's debugger (its page is created when needed). */
  debuggerOf(targetId: string): Promise<PageDebugger>;
  createTab(url: string): Promise<ProxyTab>;
  closeTab(targetId: string): Promise<boolean>;
  activate(targetId: string): void;
  /** Tab list changes; returns the unsubscribe function. */
  watch(listener: (change: TabChange) => void): () => void;
  /** Whether `path` is a file staged for this run's uploads. */
  stagedFile(path: string): boolean;
  /** A refused method, for the run's audit row. */
  refused(method: string): void;
  /** The agent ran script in the page of `targetId` (B2.5.4). */
  tainted(targetId: string): void;
  /** The agent set (or cleared, null) the device of the page of `targetId` (B1.4.2). */
  emulated(targetId: string, emulation: AgentEmulation | null): void;
  /** Cancels a download of the run (`Browser.cancelDownload`); whether there was one. */
  cancelDownload(guid: string): boolean;
}

export type TabChange =
  | { readonly kind: 'created'; readonly tab: ProxyTab }
  | { readonly kind: 'changed'; readonly tab: ProxyTab }
  | { readonly kind: 'destroyed'; readonly targetId: string };

interface Attached {
  readonly targetId: string;
  /** The page's own session id of an out-of-process frame; absent for the page itself. */
  readonly child?: string;
}

interface Message {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
}

const CONTEXT_ID = 'piarc-space';
/** Device emulation of a page, which the panel applies itself (B1.4.2). */
const EMULATION_METHODS: ReadonlySet<string> = new Set([
  'Emulation.setDeviceMetricsOverride',
  'Emulation.clearDeviceMetricsOverride',
]);
/** Methods that run the agent's code in the page (B2.5.4). */
const RUNS_SCRIPT: ReadonlySet<string> = new Set([
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Runtime.compileScript',
  'Runtime.runScript',
]);
/** CDP's "server error" code, which Chromium uses for refused and failed commands. */
const SERVER_ERROR = -32000;

class CdpFailure extends Error {
  constructor(
    message: string,
    readonly code = SERVER_ERROR,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The message, or undefined when it is not a CDP command. */
export function parseMessage(text: string): Message | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.id !== 'number' || typeof value.method !== 'string') {
    return undefined;
  }
  if (value.params !== undefined && !isRecord(value.params)) return undefined;
  if (value.sessionId !== undefined && typeof value.sessionId !== 'string') return undefined;
  return {
    id: value.id,
    method: value.method,
    ...(value.params === undefined ? {} : { params: value.params }),
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
  };
}

export class CdpProxy {
  readonly #sessions = new Map<string, Attached>();
  readonly #listeners = new Map<string, (e: unknown, m: string, p: unknown, s: string) => void>();
  readonly #debuggers = new Map<string, PageDebugger>();
  #next = 1;
  #discover = false;
  #autoAttach = false;
  readonly #unwatch: () => void;
  #closed = false;

  constructor(
    private readonly space: ProxySpace,
    private readonly send: (message: string) => void,
    private readonly browserVersion: Record<string, string>,
  ) {
    this.#unwatch = space.watch((change) => {
      void this.#tabChanged(change);
    });
  }

  /** Handles one message from the SDK; the answer goes out through `send`. */
  async handle(text: string): Promise<void> {
    const message = parseMessage(text);
    if (message === undefined) return;
    try {
      const result =
        message.sessionId === undefined
          ? await this.#browser(message)
          : await this.#page(message, message.sessionId);
      this.#emit({ id: message.id, result, ...this.#session(message) });
    } catch (error) {
      const failure =
        error instanceof CdpFailure
          ? error
          : new CdpFailure(error instanceof Error ? error.message : String(error));
      this.#emit({
        id: message.id,
        error: { code: failure.code, message: failure.message },
        ...this.#session(message),
      });
    }
  }

  /** An event of the page `targetId` that PiArc reports itself (downloads), to its sessions. */
  emitPage(targetId: string, method: string, params: Record<string, unknown>): void {
    for (const [sessionId, attached] of this.#sessions) {
      if (attached.targetId === targetId && attached.child === undefined) {
        this.#emit({ method, params, sessionId });
      }
    }
  }

  /** Stops forwarding: the run ended. */
  dispose(): void {
    this.#closed = true;
    this.#unwatch();
    for (const [targetId, listener] of this.#listeners) {
      this.#debuggers.get(targetId)?.removeListener('message', listener);
    }
    this.#listeners.clear();
    this.#debuggers.clear();
    this.#sessions.clear();
  }

  #session(message: Message): { sessionId?: string } {
    return message.sessionId === undefined ? {} : { sessionId: message.sessionId };
  }

  #emit(message: object): void {
    if (!this.#closed) this.send(JSON.stringify(message));
  }

  #info(tab: ProxyTab): Record<string, unknown> {
    const attached = [...this.#sessions.values()].some(
      (s) => s.targetId === tab.targetId && s.child === undefined,
    );
    return {
      targetId: tab.targetId,
      type: 'page',
      title: tab.title,
      url: tab.url,
      attached,
      canAccessOpener: false,
      browserContextId: CONTEXT_ID,
      ...(tab.openerId === undefined ? {} : { openerId: tab.openerId }),
    };
  }

  #tab(targetId: unknown): ProxyTab {
    const tab = this.space.tabs().find((t) => t.targetId === targetId);
    if (tab === undefined) throw new CdpFailure('No target with given id found');
    return tab;
  }

  async #browser(message: Message): Promise<unknown> {
    const verdict = browserCommand(message.method);
    if (!verdict.allowed) {
      this.space.refused(message.method);
      throw new CdpFailure(`PIARC_CDP_METHOD_REFUSED: ${verdict.reason}`);
    }
    const params = message.params ?? {};
    switch (message.method) {
      case 'Browser.getVersion':
        return this.browserVersion;
      case 'Browser.cancelDownload':
        if (typeof params.guid !== 'string' || !this.space.cancelDownload(params.guid)) {
          throw new CdpFailure('No download with given guid');
        }
        return {};
      case 'Target.getTargets':
        return { targetInfos: this.space.tabs().map((tab) => this.#info(tab)) };
      case 'Target.getTargetInfo':
        return { targetInfo: this.#info(this.#tab(params.targetId)) };
      case 'Target.attachToTarget':
        return { sessionId: await this.#attach(this.#tab(params.targetId).targetId, false) };
      case 'Target.detachFromTarget':
        this.#detach(params.sessionId);
        return {};
      case 'Target.setDiscoverTargets':
        return this.#setDiscover(params.discover === true);
      case 'Target.setAutoAttach':
        this.#autoAttach = params.autoAttach === true;
        return {};
      case 'Target.activateTarget':
        this.space.activate(this.#tab(params.targetId).targetId);
        return {};
      case 'Target.closeTarget':
        return { success: await this.space.closeTab(this.#tab(params.targetId).targetId) };
      case 'Target.createTarget': {
        const url =
          typeof params.url === 'string' && params.url !== '' ? params.url : 'about:blank';
        return { targetId: (await this.space.createTab(url)).targetId };
      }
      default:
        throw new CdpFailure(`'${message.method}' wasn't found`, -32601);
    }
  }

  #setDiscover(discover: boolean): object {
    const was = this.#discover;
    this.#discover = discover;
    if (discover && !was) {
      for (const tab of this.space.tabs()) {
        this.#emit({ method: 'Target.targetCreated', params: { targetInfo: this.#info(tab) } });
      }
    }
    return {};
  }

  async #page(message: Message, sessionId: string): Promise<unknown> {
    const attached = this.#sessions.get(sessionId);
    if (attached === undefined) throw new CdpFailure('Session with given id not found.', -32001);
    const verdict = pageCommand(message.method, message.params, (p) => this.space.stagedFile(p));
    if (!verdict.allowed) {
      this.space.refused(message.method);
      throw new CdpFailure(`PIARC_CDP_METHOD_REFUSED: ${verdict.reason}`);
    }
    let params = message.params;
    if (message.method === 'Target.detachFromTarget' && params !== undefined) {
      // A frame session by its virtual id.
      const child = this.#sessions.get(String(params.sessionId));
      if (child?.child === undefined) throw new CdpFailure('No session with given id', -32001);
      params = { ...params, sessionId: child.child };
    }
    if (message.method === 'Target.setAutoAttach') {
      // Frames attach flattened, and never wait for a debugger the SDK may not resume.
      params = { ...params, flatten: true, waitForDebuggerOnStart: false };
    }
    if (attached.child === undefined && EMULATION_METHODS.has(message.method)) {
      return this.#emulate(attached.targetId, message);
    }
    const debug = await this.space.debuggerOf(attached.targetId);
    if (RUNS_SCRIPT.has(message.method)) this.space.tainted(attached.targetId);
    return debug.sendCommand(message.method, params, attached.child);
  }

  /** The page's device goes through the panel's emulation, marked as the agent's (B1.4.2). */
  #emulate(targetId: string, message: Message): Record<string, never> {
    if (message.method === 'Emulation.clearDeviceMetricsOverride') {
      this.space.emulated(targetId, null);
      return {};
    }
    const emulation = agentEmulation(message.params);
    if (typeof emulation === 'string') throw new CdpFailure(`PIARC_EMULATION: ${emulation}`);
    this.space.emulated(targetId, emulation);
    return {};
  }

  async #attach(targetId: string, auto: boolean): Promise<string> {
    const debug = await this.space.debuggerOf(targetId);
    this.#listen(targetId, debug);
    const sessionId = this.#newSession({ targetId });
    if (auto) {
      const tab = this.space.tabs().find((t) => t.targetId === targetId);
      if (tab !== undefined) {
        this.#emit({
          method: 'Target.attachedToTarget',
          params: { sessionId, targetInfo: this.#info(tab), waitingForDebugger: false },
        });
      }
    }
    return sessionId;
  }

  #newSession(attached: Attached): string {
    const sessionId = `PIARC${String(this.#next++).padStart(8, '0')}`;
    this.#sessions.set(sessionId, attached);
    return sessionId;
  }

  #detach(sessionId: unknown): void {
    const attached = typeof sessionId === 'string' ? this.#sessions.get(sessionId) : undefined;
    if (attached === undefined) throw new CdpFailure('No session with given id', -32001);
    this.#sessions.delete(String(sessionId));
    if (attached.child === undefined) {
      // Frames go with their page.
      for (const [id, other] of this.#sessions) {
        if (other.targetId === attached.targetId) this.#sessions.delete(id);
      }
    }
  }

  #listen(targetId: string, debug: PageDebugger): void {
    if (this.#listeners.has(targetId)) return;
    const listener = (_event: unknown, method: string, params: unknown, child: string) => {
      this.#forward(targetId, method, params, child);
    };
    debug.on('message', listener);
    this.#listeners.set(targetId, listener);
    this.#debuggers.set(targetId, debug);
  }

  /** A page event: to every virtual session of that page (or of that frame). */
  #forward(targetId: string, method: string, params: unknown, child: string): void {
    const from = child === '' ? undefined : child;
    // Cookie values never reach the script (THR-17): such events are dropped or stripped.
    const visible = pageEvent(method, params);
    if (visible === undefined) return;
    let payload = visible;
    if (method === 'Target.attachedToTarget' && isRecord(params)) {
      const frame = typeof params.sessionId === 'string' ? params.sessionId : undefined;
      if (frame !== undefined) {
        payload = { ...params, sessionId: this.#newSession({ targetId, child: frame }) };
      }
    }
    if (method === 'Target.detachedFromTarget' && isRecord(params)) {
      const frame = params.sessionId;
      for (const [id, attached] of this.#sessions) {
        if (attached.targetId === targetId && attached.child === frame) {
          this.#sessions.delete(id);
          payload = { ...params, sessionId: id };
        }
      }
    }
    for (const [id, attached] of this.#sessions) {
      if (attached.targetId !== targetId || attached.child !== from) continue;
      this.#emit({ method, params: payload, sessionId: id });
      if (from === undefined) break;
    }
  }

  async #tabChanged(change: TabChange): Promise<void> {
    if (change.kind === 'destroyed') {
      for (const [id, attached] of this.#sessions) {
        if (attached.targetId !== change.targetId) continue;
        this.#sessions.delete(id);
        if (attached.child === undefined) {
          this.#emit({
            method: 'Target.detachedFromTarget',
            params: { sessionId: id, targetId: change.targetId },
          });
        }
      }
      const listener = this.#listeners.get(change.targetId);
      if (listener !== undefined) {
        this.#debuggers.get(change.targetId)?.removeListener('message', listener);
      }
      this.#listeners.delete(change.targetId);
      this.#debuggers.delete(change.targetId);
      if (this.#discover) {
        this.#emit({ method: 'Target.targetDestroyed', params: { targetId: change.targetId } });
      }
      return;
    }
    if (this.#discover) {
      const method =
        change.kind === 'created' ? 'Target.targetCreated' : 'Target.targetInfoChanged';
      this.#emit({ method, params: { targetInfo: this.#info(change.tab) } });
    }
    if (change.kind === 'created' && this.#autoAttach) {
      await this.#attach(change.tab.targetId, true).catch(() => undefined);
    }
  }
}
