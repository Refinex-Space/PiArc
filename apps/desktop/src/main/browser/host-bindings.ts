// The script host's bindings (ADR-0089 rule 3, ADR-0091): every call the SDK makes from the
// host page arrives here as one `BrowserHostRequest`. The model's script runs in that page
// and can call `window.piarcBrowserHost` itself, so each request is checked like any other
// untrusted input before it touches a Space, a page or a file.

import type { WebContents } from 'electron';

import type { BrowserImage } from '@piarc/protocol';

import {
  BROWSER_HOST_CDP_CHANNEL,
  type BrowserErrorCode,
  type BrowserHostFailure,
  type BrowserHostResult,
  type BrowserServerInfo,
  type BrowserServersResult,
  type SnapshotOptions,
  type SnapshotResult,
} from '../../shared/browser-host.js';
import type { AgentDownload } from './agent-downloads.js';
import { SpaceError, type AgentSpaces, type SpaceCaller } from './agent-spaces.js';
import { CdpProxy } from './cdp-proxy.js';

/**
 * Images one run may attach (ADR-0093, B2.6.7): the base64 a request may carry, the long edge
 * and the encoded size of what the model gets (3.75 MiB is 5 MiB of base64).
 */
export const IMAGE_LIMITS = {
  count: 8,
  input: 16 * 1024 * 1024,
  side: 1568,
  bytes: 3.75 * 1024 * 1024,
} as const;
/** JPEG qualities tried, in order, for an image over `IMAGE_LIMITS.bytes`. */
const JPEG_QUALITIES = [85, 70, 55, 40] as const;

/** What `fitImage` needs of a decoded image (Electron's `NativeImage` has it). */
export interface DecodedImage {
  getSize(): { width: number; height: number };
  resize(options: { width: number; height: number; quality: 'good' }): DecodedImage;
  toPNG(): Buffer;
  toJPEG(quality: number): Buffer;
}

/**
 * The image the model gets (B2.6.7): the long edge scaled down to 1,568 px and re-encoded as
 * its own type from the decoded pixels (the size the script claims is not used), then as JPEG
 * of lower quality until it fits; undefined for an empty image or one that never fits.
 */
export function fitImage(
  image: DecodedImage,
  mediaType: 'image/png' | 'image/jpeg',
): BrowserImage | undefined {
  const { width, height } = image.getSize();
  if (width <= 0 || height <= 0) return undefined;
  const scale = Math.min(1, IMAGE_LIMITS.side / Math.max(width, height));
  const fitted =
    scale < 1
      ? image.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: 'good',
        })
      : image;
  const size = fitted.getSize();
  let type = mediaType;
  let bytes = mediaType === 'image/png' ? fitted.toPNG() : fitted.toJPEG(JPEG_QUALITIES[0]);
  for (const quality of JPEG_QUALITIES) {
    if (bytes.length <= IMAGE_LIMITS.bytes) break;
    type = 'image/jpeg';
    bytes = fitted.toJPEG(quality);
  }
  if (bytes.length > IMAGE_LIMITS.bytes) return undefined;
  return { mediaType: type, data: bytes.toString('base64'), ...size };
}
const LEDGER_CHARS = 1024 * 1024;
const CDP_MESSAGE_CHARS = 8 * 1024 * 1024;
const MAX_PATHS = 20;
const REASON_CHARS = 500;
const SERVER_NAME_CHARS = 200;

/** Refused DevTools methods a run keeps for its audit row: the names come from the script. */
const REFUSED_LIMIT = 100;
const METHOD_CHARS = 128;

/** Permission requests a run keeps for its result: the origins come from pages. */
const PERMISSION_LIMIT = 20;
const ORIGIN_CHARS = 200;

/** Notes a permission request refused on one of the run's pages (B1.3.2). */
export function notePermission(refused: Set<string>, permission: string, origin: string): void {
  if (refused.size < PERMISSION_LIMIT) {
    refused.add(`${permission.slice(0, 64)} (${origin.slice(0, ORIGIN_CHARS)})`);
  }
}

/** What the run's output ends with when its pages were refused permissions (B1.3.2). */
export function permissionNote(refused: ReadonlySet<string>): string {
  if (refused.size === 0) return '';
  // i18n-exempt: the model reads it in the tool result; the user never sees it.
  return `\n[PiArc] Pages in your task space asked for ${[...refused].join(', ')}. Agent tabs get no permissions, so each was refused; if the page needs one, hand the task space to the user.`;
}

/** Notes one refused method for the run's audit row (B2.6.5). */
export function noteRefused(refused: Set<string>, method: string): void {
  if (refused.size < REFUSED_LIMIT) refused.add(method.slice(0, METHOD_CHARS));
}

/** One run in a host. */
export interface HostRun {
  readonly runId: string;
  readonly caller: SpaceCaller;
  /** The `Browser` call's session and id (site cards bind to them). */
  readonly callSessionId: string;
  readonly toolCallId: string;
  /** Hosts the user allowed for this run only (site cards' "allow once"). */
  readonly allowedHosts: Set<string>;
  readonly host: WebContents;
  readonly images: BrowserImage[];
  readonly refusedMethods: Set<string>;
  readonly blockedHosts: Set<string>;
  readonly visitedHosts: Set<string>;
  /** Permission requests refused on the run's pages, for its result (B1.3.2). */
  readonly refusedPermissions: Set<string>;
  readonly proxies: Map<number, CdpProxy>;
  /** Files staged for this run's uploads (absolute paths). */
  readonly staged: Set<string>;
  /** Downloads this run's pages started, by guid (agent-downloads.ts). */
  readonly downloads: Map<string, AgentDownload>;
  finished(result: BrowserHostResult): void;
}

/** Ports the bindings use besides the Spaces. */
export interface BindingPorts {
  snapshot(contents: WebContents, options: SnapshotOptions): Promise<SnapshotResult>;
  /** Copies `paths` for an upload through Core's read decision; answers the copies. */
  stageUpload(run: HostRun, paths: readonly string[]): Promise<readonly string[]>;
  /** Saves a finished download of the run to `path` through Core's write decision. */
  saveFile(run: HostRun, source: string, path: string): Promise<void>;
  /** Asks the user to let the agent reach `hosts`; whether they did. */
  requestAccess(run: HostRun, hosts: readonly string[], reason: string): Promise<boolean>;
  /** The project's launch configurations and the session's local services (ADR-0092). */
  servers(run: HostRun): Promise<BrowserServersResult>;
  /** Starts configuration `name` for the agent; the first start of its fingerprint asks. */
  startServer(run: HostRun, name: string): Promise<BrowserServerInfo>;
  /** Shows the agent's cursor and action label in a page (B2.5.1). */
  highlight(contents: WebContents, x: number, y: number, label: string | undefined): void;
  /** Decodes PNG or JPEG bytes (`nativeImage`); undefined when they are not an image. */
  decodeImage(bytes: Buffer): DecodedImage | undefined;
  readonly browserVersion: Record<string, string>;
}

function failure(code: BrowserErrorCode, error: string, reason?: string): BrowserHostFailure {
  return { error, error_code: code, ...(reason === undefined ? {} : { reason }) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function int(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

class BadRequest extends Error {}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new BadRequest(`invalid ${what}`);
  return value;
}

function paths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATHS) {
    throw new BadRequest(`paths: 1-${String(MAX_PATHS)} file paths`);
  }
  return value.map((item) => need(text(item, 4096), 'path'));
}

function snapshotOptions(value: unknown): SnapshotOptions {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new BadRequest('invalid snapshot options');
  const scope = value.scope;
  if (
    scope !== undefined &&
    scope !== 'full_page' &&
    scope !== 'only_within_viewport' &&
    scope !== 'subtree'
  ) {
    throw new BadRequest('invalid snapshot scope');
  }
  const flag = (name: string): Record<string, boolean> => {
    const raw = value[name];
    if (raw === undefined) return {};
    if (typeof raw !== 'boolean') throw new BadRequest(`invalid ${name}`);
    return { [name]: raw };
  };
  return {
    ...(scope === undefined ? {} : { scope }),
    ...(value.root === undefined ? {} : { root: need(int(value.root), 'snapshot root') }),
    ...(value.rootFrame === undefined
      ? {}
      : { rootFrame: need(text(value.rootFrame, 256), 'frame') }),
    ...flag('includeActionMarks'),
    ...flag('interactiveOnly'),
    ...flag('includeStableLocator'),
    ...(value.maxResultLength === undefined
      ? {}
      : { maxResultLength: need(int(value.maxResultLength), 'maxResultLength') }),
  };
}

export class HostBindings {
  constructor(
    private readonly spaces: AgentSpaces,
    private readonly ports: BindingPorts,
  ) {}

  /** Answers one request of `run`'s host; failures come back as ego's error objects. */
  async call(run: HostRun, request: unknown): Promise<unknown> {
    try {
      if (!isRecord(request) || typeof request.op !== 'string') {
        throw new BadRequest('not a binding request');
      }
      return await this.#dispatch(run, request.op, request);
    } catch (error) {
      if (error instanceof SpaceError) return failure(error.code, error.message, error.reason);
      if (error instanceof BadRequest) return failure('EGO_INVALID_ARGUMENT', error.message);
      return failure(
        'EGO_OPERATION_FAILED',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** The run ended: its CDP connections stop. */
  close(run: HostRun): void {
    for (const proxy of run.proxies.values()) proxy.dispose();
    run.proxies.clear();
  }

  async #dispatch(run: HostRun, op: string, r: Record<string, unknown>): Promise<unknown> {
    const caller = run.caller;
    const space = () => need(int(r.space), 'space');
    switch (op) {
      case 'listProfiles':
        return { profiles: [{ id: 'default', name: 'PiArc', isDefault: true }] };
      case 'listTaskSpaces':
        return { taskSpaces: await this.spaces.list(caller) };
      case 'createTaskSpace':
        return this.spaces.create(caller, need(text(r.name, 200), 'name'));
      case 'claimTaskSpace':
        return this.spaces.claim(
          caller,
          need(int(r.id), 'id'),
          r.name === undefined ? undefined : need(text(r.name, 200), 'name'),
        );
      case 'closeTaskSpace':
        return this.spaces.close(caller, space());
      case 'completeTaskSpace':
        return this.spaces.complete(caller, space());
      case 'handOffTaskSpace':
        return this.spaces.handOff(caller, space(), text(r.reason, REASON_CHARS) ?? '');
      case 'takeOverTaskSpace':
        return this.spaces.takeOver(caller, space());
      case 'setAgentTaskState':
        return this.spaces.setState(caller, space(), need(text(r.state, 1000), 'state'));
      case 'highlight':
        return this.#highlight(run, r);
      case 'createTab':
        return this.spaces.createTab(caller, space(), need(text(r.url, 8192), 'url'));
      case 'listTabs':
        return { tabs: await this.spaces.listTabs(caller, space()) };
      case 'snapshot': {
        const { contents } = await this.spaces.tab(
          caller,
          space(),
          need(text(r.targetId, 256), 'targetId'),
        );
        return this.ports.snapshot(contents, snapshotOptions(r.options));
      }
      case 'cdp':
        return this.#cdp(run, space(), need(text(r.message, CDP_MESSAGE_CHARS), 'message'));
      case 'ledgerLoad':
        return this.spaces.ledger(caller, space());
      case 'ledgerSave':
        this.spaces.saveLedger(caller, space(), need(text(r.data, LEDGER_CHARS), 'data'));
        return null;
      case 'stageUpload':
        return this.ports.stageUpload(run, paths(r.paths));
      case 'saveFile':
        await this.ports.saveFile(
          run,
          need(text(r.source, 4096), 'source'),
          need(text(r.path, 4096), 'path'),
        );
        return null;
      case 'attachImage':
        return this.#attach(run, r);
      case 'requestAccess': {
        const hosts = paths(r.hosts);
        return this.ports.requestAccess(run, hosts, text(r.reason, REASON_CHARS) ?? '');
      }
      case 'servers':
        return this.ports.servers(run);
      case 'startServer':
        return this.ports.startServer(run, need(text(r.name, SERVER_NAME_CHARS), 'name'));
      case 'finish':
        this.#finish(run, r.result);
        return null;
      default:
        throw new BadRequest(`unknown binding ${op}`);
    }
  }

  async #highlight(run: HostRun, r: Record<string, unknown>): Promise<string> {
    const id = need(int(r.space), 'space');
    const x = need(finite(r.x), 'x');
    const y = need(finite(r.y), 'y');
    const label = r.label === undefined ? undefined : need(text(r.label, 120), 'label');
    const { contents } = await this.spaces.tab(
      run.caller,
      id,
      need(text(r.targetId, 256), 'targetId'),
    );
    if (label !== undefined) await this.spaces.setState(run.caller, id, label);
    this.ports.highlight(contents, x, y, label);
    return `${String(id)} mouse highlight shown.`;
  }

  async #cdp(run: HostRun, space: number, message: string): Promise<null> {
    // A Space the user took over refuses the send itself (ego's onSendCDPMessageError).
    await this.spaces.control(run.caller, space);
    let proxy = run.proxies.get(space);
    if (proxy === undefined) {
      const proxySpace = await this.spaces.proxySpace(run.caller, space, {
        stagedFile: (path) => run.staged.has(path),
        refused: (method) => {
          noteRefused(run.refusedMethods, method);
        },
        cancelDownload: (guid) => {
          const download = run.downloads.get(guid);
          if (download === undefined) return false;
          download.item.cancel();
          return true;
        },
      });
      proxy = new CdpProxy(
        proxySpace,
        (answer) => {
          if (!run.host.isDestroyed()) run.host.send(BROWSER_HOST_CDP_CHANNEL, answer);
        },
        this.ports.browserVersion,
      );
      run.proxies.set(space, proxy);
    }
    void proxy.handle(message);
    return null;
  }

  #attach(run: HostRun, r: Record<string, unknown>): number {
    const mediaType = r.mediaType;
    if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') {
      throw new BadRequest('images are PNG or JPEG');
    }
    const data = need(text(r.base64, IMAGE_LIMITS.input), 'image (at most 16 MiB of base64)');
    if (run.images.length >= IMAGE_LIMITS.count) {
      throw new SpaceError(
        'PIARC_LIMIT',
        `At most ${String(IMAGE_LIMITS.count)} screenshots per call; split the work into more calls`,
      );
    }
    const decoded = this.ports.decodeImage(Buffer.from(data, 'base64'));
    const image = decoded === undefined ? undefined : fitImage(decoded, mediaType);
    if (image === undefined) throw new BadRequest('image (not a PNG or JPEG the browser can read)');
    run.images.push(image);
    return run.images.length;
  }

  #finish(run: HostRun, value: unknown): void {
    if (!isRecord(value) || value.runId !== run.runId || typeof value.output !== 'string') {
      throw new BadRequest('invalid run result');
    }
    const error = isRecord(value.error)
      ? {
          name: text(value.error.name, 200) ?? 'Error',
          message: text(value.error.message, 20_000) ?? '',
          ...(typeof value.error.code === 'string' ? { code: value.error.code.slice(0, 100) } : {}),
        }
      : undefined;
    run.finished({
      runId: run.runId,
      output: value.output,
      ...(error === undefined ? {} : { error }),
    });
  }
}
