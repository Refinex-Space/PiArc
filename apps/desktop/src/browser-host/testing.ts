// Test doubles for the browser-host SDK (PiArc; used only by `*.test.ts`). `FakeBindings` stands in
// for the `globalThis.ego` object (upstream tests build ad-hoc `FakeEgo` objects); `fakeCdp` turns
// an untyped handler into the typed `services.cdp` the drivers take.

import type {
  BrowserServerInfo,
  BrowserServersResult,
  SnapshotResult,
  TabInfo,
  TaskSpaceInfo,
} from '../shared/browser-host.js';
import type { CdpCall, CdpObject, CdpResult } from './sdk/cdp-types.js';
import type { EgoBindings, EgoProfile, EgoResult, EgoSnapshotOptions } from './sdk/ego-bindings.js';

/** One CDP command the SDK sent through `sendCDPMessage`. */
export interface CdpRequestMessage {
  readonly id: number;
  readonly method: string;
  readonly params: CdpObject;
  readonly sessionId?: string;
}

/**
 * Answers a CDP command: an object replies `{ id, result }`, an `Error` replies `{ id, error }`,
 * `undefined` leaves the command unanswered (the test replies later with `reply` or `fail`).
 */
export type CdpHandler = (
  request: CdpRequestMessage,
) => CdpObject | Error | undefined | Promise<CdpObject | Error | undefined>;

type Methods = Omit<EgoBindings, 'onCDPMessage' | 'onSendCDPMessageError' | 'sendCDPMessage'>;

export interface FakeBindingsOptions extends Partial<Methods> {
  readonly cdp?: CdpHandler;
}

/** An in-memory `EgoBindings`: records every call, answers CDP through `options.cdp`. */
export class FakeBindings implements EgoBindings {
  onCDPMessage: ((message: string) => void) | undefined = undefined;
  onSendCDPMessageError: ((message: string, errorCode: string) => void) | undefined = undefined;
  /** Every binding call, CDP sends included, as `[name, ...args]`. */
  readonly calls: [string, ...unknown[]][] = [];
  /** Every CDP command sent, in order. */
  readonly sent: CdpRequestMessage[] = [];
  /** The ledger text per Space (`ledgerLoad` / `ledgerSave`). */
  readonly ledgers = new Map<number, string>();
  selectedSpace: number | undefined = undefined;
  readonly #options: FakeBindingsOptions;

  constructor(options: FakeBindingsOptions = {}) {
    this.#options = options;
  }

  sendCDPMessage(message: string): void {
    this.calls.push(['sendCDPMessage', message]);
    const parsed: unknown = JSON.parse(message);
    if (typeof parsed !== 'object' || parsed === null) throw new TypeError('CDP message');
    const id: unknown = Reflect.get(parsed, 'id');
    const method: unknown = Reflect.get(parsed, 'method');
    const params: unknown = Reflect.get(parsed, 'params');
    const sessionId: unknown = Reflect.get(parsed, 'sessionId');
    if (typeof id !== 'number' || typeof method !== 'string') throw new TypeError('CDP message');
    const request: CdpRequestMessage = {
      id,
      method,
      params: typeof params === 'object' && params !== null ? (params as CdpObject) : {},
      ...(typeof sessionId === 'string' ? { sessionId } : {}),
    };
    this.sent.push(request);
    const handler = this.#options.cdp;
    if (!handler) return;
    void Promise.resolve(handler(request)).then((answer) => {
      if (answer instanceof Error) this.fail(request.id, answer.message);
      else if (answer !== undefined) this.reply(request.id, answer);
    });
  }

  /** Delivers `{ id, result }` asynchronously, as the native channel does. */
  reply(id: number, result: CdpObject = {}): void {
    this.deliver({ id, result });
  }

  /** Delivers `{ id, error: { message } }`. */
  fail(id: number, message: string): void {
    this.deliver({ id, error: { message } });
  }

  /** Delivers an event or any raw message. */
  emit(message: CdpObject): void {
    this.deliver(message);
  }

  /** Reports a local send failure through `onSendCDPMessageError`. */
  sendError(message: string, errorCode: string): void {
    queueMicrotask(() => this.onSendCDPMessageError?.(message, errorCode));
  }

  deliver(message: CdpObject): void {
    const text = JSON.stringify(message);
    queueMicrotask(() => this.onCDPMessage?.(text));
  }

  listProfiles(): Promise<EgoResult<{ readonly profiles: readonly EgoProfile[] }>> {
    this.calls.push(['listProfiles']);
    return this.#options.listProfiles?.() ?? Promise.resolve({ profiles: [] });
  }

  listTaskSpaces(): Promise<EgoResult<{ readonly taskSpaces: readonly TaskSpaceInfo[] }>> {
    this.calls.push(['listTaskSpaces']);
    return this.#options.listTaskSpaces?.() ?? Promise.resolve({ taskSpaces: [] });
  }

  createTaskSpace(name: string, profileId?: string): Promise<EgoResult<TaskSpaceInfo>> {
    this.calls.push(
      profileId === undefined ? ['createTaskSpace', name] : ['createTaskSpace', name, profileId],
    );
    return (
      this.#options.createTaskSpace?.(name, profileId) ??
      Promise.resolve({
        id: 1,
        name,
        taskId: name,
        ownership: 'agent',
        createdBy: 'agent',
        recentTabTitles: [],
      })
    );
  }

  claimTaskSpace(id: number, name?: string): Promise<EgoResult<TaskSpaceInfo>> {
    this.calls.push(name === undefined ? ['claimTaskSpace', id] : ['claimTaskSpace', id, name]);
    return (
      this.#options.claimTaskSpace?.(id, name) ??
      Promise.resolve({
        id,
        name: name ?? '',
        taskId: name ?? '',
        ownership: 'agent',
        createdBy: 'user',
        recentTabTitles: [],
      })
    );
  }

  useTaskSpace(id: number): number {
    this.calls.push(['useTaskSpace', id]);
    this.selectedSpace = id;
    return this.#options.useTaskSpace?.(id) ?? id;
  }

  closeTaskSpace(): Promise<EgoResult<string>> {
    return this.#status('closeTaskSpace', this.#options.closeTaskSpace);
  }

  completeTaskSpace(): Promise<EgoResult<string>> {
    return this.#status('completeTaskSpace', this.#options.completeTaskSpace);
  }

  handOffTaskSpace(): Promise<EgoResult<string>> {
    return this.#status('handOffTaskSpace', this.#options.handOffTaskSpace);
  }

  takeOverTaskSpace(): Promise<EgoResult<string>> {
    return this.#status('takeOverTaskSpace', this.#options.takeOverTaskSpace);
  }

  setAgentTaskState(state: string): Promise<EgoResult<string>> {
    this.calls.push(['setAgentTaskState', state]);
    return this.#options.setAgentTaskState?.(state) ?? Promise.resolve('state updated.');
  }

  animationHighlightMouseToPosition(
    x: number,
    y: number,
    targetId?: string,
  ): Promise<EgoResult<string>> {
    this.calls.push(['animationHighlightMouseToPosition', x, y, targetId]);
    return (
      this.#options.animationHighlightMouseToPosition?.(x, y, targetId) ??
      Promise.resolve('mouse highlight shown.')
    );
  }

  createTab(url: string): Promise<EgoResult<TabInfo>> {
    this.calls.push(['createTab', url]);
    return (
      this.#options.createTab?.(url) ??
      Promise.resolve({
        index: 0,
        targetId: 'target-1',
        url,
        title: '',
        active: true,
        openedBy: 'agent',
      })
    );
  }

  listTabs(): Promise<EgoResult<{ readonly tabs: readonly TabInfo[] }>> {
    this.calls.push(['listTabs']);
    return this.#options.listTabs?.() ?? Promise.resolve({ tabs: [] });
  }

  snapshot(options?: EgoSnapshotOptions): Promise<SnapshotResult> {
    this.calls.push(['snapshot', options]);
    return (
      this.#options.snapshot?.(options) ??
      Promise.resolve({ content: '', refs: [], truncated: false })
    );
  }

  ledgerLoad(space: number): Promise<EgoResult<string | null>> {
    this.calls.push(['ledgerLoad', space]);
    if (this.#options.ledgerLoad) return this.#options.ledgerLoad(space);
    return Promise.resolve(this.ledgers.get(space) ?? null);
  }

  ledgerSave(space: number, data: string): Promise<EgoResult<null>> {
    this.calls.push(['ledgerSave', space, data]);
    if (this.#options.ledgerSave) return this.#options.ledgerSave(space, data);
    if (data === '') this.ledgers.delete(space);
    else this.ledgers.set(space, data);
    return Promise.resolve(null);
  }

  stageUpload(paths: readonly string[]): Promise<EgoResult<readonly string[]>> {
    this.calls.push(['stageUpload', paths]);
    return (
      this.#options.stageUpload?.(paths) ??
      Promise.resolve(paths.map((path, index) => `/staged/${String(index)}-${basename(path)}`))
    );
  }

  saveFile(source: string, path: string): Promise<EgoResult<null>> {
    this.calls.push(['saveFile', source, path]);
    return this.#options.saveFile?.(source, path) ?? Promise.resolve(null);
  }

  attachImage(image: {
    readonly base64: string;
    readonly mediaType: 'image/png' | 'image/jpeg';
    readonly width: number;
    readonly height: number;
  }): Promise<EgoResult<number>> {
    this.calls.push(['attachImage', image]);
    return (
      this.#options.attachImage?.(image) ??
      Promise.resolve(this.calls.filter(([name]) => name === 'attachImage').length)
    );
  }

  requestAccess(hosts: readonly string[], reason: string): Promise<EgoResult<boolean>> {
    this.calls.push(['requestAccess', hosts, reason]);
    return this.#options.requestAccess?.(hosts, reason) ?? Promise.resolve(true);
  }

  servers(): Promise<EgoResult<BrowserServersResult>> {
    this.calls.push(['servers']);
    return (
      this.#options.servers?.() ??
      Promise.resolve({ trusted: true, servers: [], listening: [], problems: [] })
    );
  }

  startServer(name: string): Promise<EgoResult<BrowserServerInfo>> {
    this.calls.push(['startServer', name]);
    return (
      this.#options.startServer?.(name) ??
      Promise.resolve({ name, status: 'ready', url: 'http://localhost:3000/', port: 3000 })
    );
  }

  #status(
    name: string,
    override: (() => Promise<EgoResult<string>>) | undefined,
  ): Promise<EgoResult<string>> {
    this.calls.push([name]);
    return override?.() ?? Promise.resolve(`${name} done.`);
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * Installs `bindings` as `globalThis.ego` and answers a function that restores the previous
 * value (tests call it in `finally` or `afterEach`).
 */
export function installBindings(bindings: EgoBindings | undefined): () => void {
  const previous = globalThis.ego;
  globalThis.ego = bindings;
  return () => {
    globalThis.ego = previous;
  };
}

/** Builds the typed `services.cdp` from an untyped test handler. */
export function fakeCdp(
  handler: (
    method: string,
    params: CdpObject,
    sessionId: string | undefined,
    timeoutMs: number | undefined,
  ) => unknown,
): CdpCall {
  return async <M extends string>(
    method: M,
    params?: object,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<CdpResult<M>> => {
    const answer: unknown = await handler(method, { ...params }, sessionId, timeoutMs);
    return (answer ?? {}) as CdpResult<M>;
  };
}
