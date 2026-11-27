// Ported from ego-browser package/ego-browser/src/browser-runtime.ts (ego-lite commit 56589ea8,
// MIT, see LICENSE). PiArc: typed CDP messages (cdp-types.ts) and bindings (ego-bindings.ts); the
// incoming message envelope is validated before use; the response timeout override is
// state.responseTimeoutMs instead of EGO_BROWSER_RESPONSE_TIMEOUT_MS; no egoAutomated domain
// (ADR-0091); the non-standard targetInfo.parentId fallback is gone; v1-only drainBrowserEvents,
// isNetworkDomainEnabled and browserSnapshotRefsToRefMap are dropped.

import type { Protocol } from 'devtools-protocol';

import {
  isRecord,
  type CdpEvent,
  type CdpEventParams,
  type CdpObject,
  type CdpParams,
  type CdpResponse,
  type Wire,
} from './cdp-types.js';
import type { EgoBindings } from './ego-bindings.js';
import { buildEgoError, invokeEgo, isEgoUserControlError } from './ego-errors.js';
import { state } from './state.js';

const DEFAULT_RESPONSE_TIMEOUT_MS = 15000;

/**
 * How long one renderer-bound CDP command may go unanswered before the
 * runtime gives up on it. Read per call so a test can shorten the wait with
 * `state.responseTimeoutMs`; agents keep the default.
 */
export function responseTimeoutMs(): number {
  const configured = state.responseTimeoutMs;
  return configured !== undefined && Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_RESPONSE_TIMEOUT_MS;
}
// Page.enable, Network.enable, and Target.setAutoAttach answer within
// milliseconds on a responsive Page. A Page whose main-frame navigation has
// started but not committed, or whose renderer hangs, answers none of them
// until it recovers, so one caller never waits longer than this for setup.
const SESSION_SETUP_WAIT_MS = 2000;
const SESSION_TTL_MS = 2000;
// Upper bound for buffered CDP events. The runtime lives as long as the host
// page; without a cap, undrained events grow without bound.
const MAX_BUFFERED_EVENTS = 10000;
const SESSION_LOST = /Session (?:with given id )?not found|Target closed|No session/i;
const FRAME_LIFECYCLE_LOST =
  /Frame with the given frameId is not found|No frame with given id found|No target with given id/i;
const BROWSER_LEVEL = (method: string): boolean =>
  method.startsWith('Target.') || method.startsWith('Browser.');
const OOPIF_AUTO_ATTACH_PARAMS: CdpParams<'Target.setAutoAttach'> = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  // A browser can pause an excluded related target (dedicated worker,
  // AudioWorklet, ...) without attaching it, leaving no session through which
  // the harness can resume it. Attach every type; the attach handler resumes
  // and detaches everything except iframes.
  filter: [{}],
};
// A modal JavaScript dialog stalls every command the renderer has to answer,
// including Page.getFrameTree, Page.captureScreenshot, DOM.*, Accessibility.*,
// and even Page.enable. Only methods the browser process answers on its own
// keep working, so allow those and fail every other command fast instead of
// letting it run into the transport timeout.
const DIALOG_SAFE_METHOD = (method: string): boolean =>
  BROWSER_LEVEL(method) ||
  method === 'Page.handleJavaScriptDialog' ||
  method === 'Page.setDownloadBehavior';

/** The dialog a `Page.javascriptDialogOpening` event announced. */
export type PageDialog = CdpEventParams<'Page.javascriptDialogOpening'>;

interface PendingRequest {
  readonly method: string;
  readonly sessionId: string | undefined;
  resolve(response: CdpResponse<string>): void;
  reject(error: Error): void;
}

interface InflightNetworkRequest {
  requestId: string;
  frameId?: string;
  loaderId?: string;
  type?: string;
  url?: string;
}

let nextMessageId = 1;
const pending = new Map<number, PendingRequest>();
const browserEvents: CdpEvent[] = [];
const browserEventSubscribers = new Set<(event: CdpEvent) => void>();
const pageEventSubscribers = new Map<string, Set<(event: CdpEvent) => void>>();
const targetStates = new Map<string, TargetState>();
const sessionTargets = new Map<string, string>();
const childTargets = new Map<string, Set<string>>();
const parentTargets = new Map<string, string>();
let defaultTargetId: string | null = null;
let userControlProbeState: 'idle' | 'probing' | 'stopped' = 'idle';
let userControlStopError: (Error & { error_code?: string }) | null = null;
let userControlProbeGeneration = 0;
type EgoCdpCallbackRuntime = Pick<EgoBindings, 'onCDPMessage' | 'onSendCDPMessageError'>;
let callbackRuntime: EgoCdpCallbackRuntime | undefined;

export class CdpRequestTimeoutError extends Error {
  readonly code: 'EGO_CDP_REQUEST_TIMEOUT' | 'EGO_PAGE_UNRESPONSIVE' = 'EGO_CDP_REQUEST_TIMEOUT';
  readonly method: string;
  readonly timeoutMs: number;
  readonly sessionId: string | undefined;

  constructor(method: string, timeoutMs: number, sessionId?: string) {
    super(`CDP request timed out: ${method}`);
    this.name = 'CdpRequestTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
    this.sessionId = sessionId;
  }
}

/**
 * The Page's renderer did not answer a command it has to answer itself.
 * Chromium suspends every renderer-bound command while a main-frame navigation
 * has started but not committed; a hung renderer behaves the same way. It is
 * still a request timeout, so budget-driven retry loops that treat a timeout
 * at their deadline as their own timeout keep doing so.
 */
export class PageUnresponsiveError extends CdpRequestTimeoutError {
  override readonly code = 'EGO_PAGE_UNRESPONSIVE';
  readonly waitedMs: number;
  readonly targetId: string | undefined;
  /**
   * The pending navigation was stopped once the wait ran out and the Page
   * answers again; `currentUrl` is what its main frame showed afterwards.
   */
  stopped = false;
  currentUrl: string | undefined;

  constructor(method: string, waitedMs: number, targetId?: string, sessionId?: string) {
    super(method, waitedMs, sessionId);
    this.name = 'PageUnresponsiveError';
    this.message = `Page did not answer ${method} within ${String(waitedMs)}ms; its main-frame navigation has not committed or its renderer is unresponsive`;
    this.waitedMs = waitedMs;
    this.targetId = targetId;
  }
}

function errorCode(error: unknown): unknown {
  return isRecord(error) || error instanceof Error ? Reflect.get(error, 'code') : undefined;
}

export function isPageUnresponsiveError(error: unknown): error is PageUnresponsiveError {
  return (
    error instanceof PageUnresponsiveError ||
    (error instanceof Error && errorCode(error) === 'EGO_PAGE_UNRESPONSIVE')
  );
}

export function isCdpRequestTimeoutError(error: unknown): error is CdpRequestTimeoutError {
  return error instanceof CdpRequestTimeoutError || errorCode(error) === 'EGO_CDP_REQUEST_TIMEOUT';
}

/** A CDP command error carrying the session it was addressed to. */
export type CdpCommandError = Error & { sessionId?: string };

/** The CDP session that issued a failed command is gone. */
export function isSessionLostError(error: unknown): error is CdpCommandError {
  return error instanceof Error && SESSION_LOST.test(error.message);
}

/** A frame or iframe target vanished between enumeration and use. */
export function isFrameLifecycleError(error: unknown): error is CdpCommandError {
  return error instanceof Error && FRAME_LIFECYCLE_LOST.test(error.message);
}

/**
 * A frame or its session disappeared mid-operation. Callers that have not yet
 * dispatched input may rediscover frame sessions and retry.
 */
export function isRetryableFrameLifecycleError(error: unknown): error is CdpCommandError {
  return isSessionLostError(error) || isFrameLifecycleError(error);
}

/**
 * Signals that a modal JavaScript dialog prevented a CDP command from
 * completing. The dialog remains open; Page-level code decides whether to
 * expose it in an action receipt or surface this error to the caller.
 */
export class PageDialogOpenedError extends Error {
  readonly code = 'EGO_PAGE_DIALOG_OPENED';
  readonly method: string;
  readonly sessionId: string;
  readonly dialog: PageDialog;

  constructor(
    method: string,
    sessionId: string,
    dialog: PageDialog,
    { alreadyOpen = false }: { alreadyOpen?: boolean } = {},
  ) {
    const kind = dialog.type ? `JavaScript ${dialog.type} dialog` : 'JavaScript dialog';
    const text =
      typeof dialog.message === 'string' && dialog.message
        ? ` (${JSON.stringify(dialog.message)})`
        : '';
    const situation = alreadyOpen
      ? `${method} cannot run while a ${kind}${text} is open`
      : `a ${kind}${text} opened while ${method} was running`;
    super(
      `${situation}; handle it with page.acceptDialog() or page.dismissDialog() before continuing`,
    );
    this.name = 'PageDialogOpenedError';
    this.method = method;
    this.sessionId = sessionId;
    this.dialog = { ...dialog };
  }
}

export function isPageDialogOpenedError(error: unknown): error is PageDialogOpenedError {
  return error instanceof PageDialogOpenedError || errorCode(error) === 'EGO_PAGE_DIALOG_OPENED';
}

export interface FileChooserOpenedEvent {
  backendNodeId: number;
  frameId?: string;
  mode?: 'selectSingle' | 'selectMultiple';
}

export interface FileChooserInterception {
  ready: Promise<void>;
  event: Promise<FileChooserOpenedEvent>;
  peek(): FileChooserOpenedEvent | undefined;
  dispose(reason?: Error): Promise<void>;
}

interface FileChooserInterceptionState extends FileChooserInterception {
  cancelPromise: Promise<void> | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  reject(error: Error): void;
  resolve(value: FileChooserOpenedEvent): void;
}

interface TargetState {
  sessionId: string | null;
  sessionAt: number;
  sessionInflight: Promise<string> | null;
  events: CdpEvent[];
  pageEventsEnabled: boolean;
  pageEnableInflight: Promise<void> | null;
  networkDomainEnabled: boolean;
  networkEnableInflight: Promise<void> | null;
  autoAttachEnabled: boolean;
  autoAttachInflight: Promise<void> | null;
  inflightNetworkRequests: Map<string, InflightNetworkRequest>;
  ignoredFaviconRequestIds: Set<string>;
  lastNetworkActivityAt: number;
  pendingDialog: PageDialog | null;
  fileChooserInterception: FileChooserInterceptionState | null;
}

function targetState(targetId: string): TargetState {
  let target = targetStates.get(targetId);
  if (!target) {
    target = {
      sessionId: null,
      sessionAt: 0,
      sessionInflight: null,
      events: [],
      pageEventsEnabled: false,
      pageEnableInflight: null,
      networkDomainEnabled: false,
      networkEnableInflight: null,
      autoAttachEnabled: false,
      autoAttachInflight: null,
      inflightNetworkRequests: new Map(),
      ignoredFaviconRequestIds: new Set(),
      lastNetworkActivityAt: state.now(),
      pendingDialog: null,
      fileChooserInterception: null,
    };
    targetStates.set(targetId, target);
  }
  return target;
}

function registerSession(targetId: string, sessionId: string): void {
  const target = targetState(targetId);
  if (target.sessionId === sessionId) {
    target.sessionAt = Date.now();
    sessionTargets.set(sessionId, targetId);
    return;
  }
  if (target.sessionId && target.sessionId !== sessionId) {
    sessionTargets.delete(target.sessionId);
  }
  target.sessionId = sessionId;
  target.sessionAt = Date.now();
  target.pageEventsEnabled = false;
  target.pageEnableInflight = null;
  target.networkDomainEnabled = false;
  target.networkEnableInflight = null;
  target.autoAttachEnabled = false;
  target.autoAttachInflight = null;
  target.inflightNetworkRequests.clear();
  target.ignoredFaviconRequestIds.clear();
  target.lastNetworkActivityAt = state.now();
  target.pendingDialog = null;
  sessionTargets.set(sessionId, targetId);
}

function registerTargetParent(targetId: string, parentTargetId: string): void {
  const previousParent = parentTargets.get(targetId);
  if (previousParent === parentTargetId) {
    // A renderer swap can reattach the same frame target after a new document
    // request has already started in the parent session.
    migrateFrameRequests(targetId, parentTargetId);
    return;
  }
  if (previousParent) {
    const previousChildren = childTargets.get(previousParent);
    previousChildren?.delete(targetId);
    if (previousChildren?.size === 0) childTargets.delete(previousParent);
  }
  parentTargets.set(targetId, parentTargetId);
  let children = childTargets.get(parentTargetId);
  if (!children) {
    children = new Set();
    childTargets.set(parentTargetId, children);
  }
  children.add(targetId);
  migrateFrameRequests(targetId, parentTargetId);
}

function migrateFrameRequests(targetId: string, parentTargetId: string): void {
  const destination = targetState(targetId);
  const rootTargetId = pageRootTargetId(parentTargetId);
  for (const sourceTargetId of pageTreeTargetIds(rootTargetId)) {
    if (sourceTargetId === targetId) continue;
    const source = targetStates.get(sourceTargetId);
    if (!source) continue;
    for (const [requestId, request] of source.inflightNetworkRequests) {
      if (request.frameId !== targetId) continue;
      source.inflightNetworkRequests.delete(requestId);
      destination.inflightNetworkRequests.set(requestId, request);
      destination.lastNetworkActivityAt = Math.max(
        destination.lastNetworkActivityAt,
        source.lastNetworkActivityAt,
      );
    }
  }
}

function pageRootTargetId(targetId: string): string {
  let current = targetId;
  const visited = new Set<string>();
  let parent = parentTargets.get(current);
  while (parent !== undefined && !visited.has(current)) {
    visited.add(current);
    current = parent;
    parent = parentTargets.get(current);
  }
  return current;
}

function pageTreeTargetIds(rootTargetId: string): string[] {
  const result: string[] = [];
  const visit = (targetId: string) => {
    result.push(targetId);
    for (const childTargetId of childTargets.get(targetId) ?? []) {
      visit(childTargetId);
    }
  };
  visit(rootTargetId);
  return result;
}

function unregisterTargetParent(targetId: string): void {
  const parentTargetId = parentTargets.get(targetId);
  if (!parentTargetId) return;
  parentTargets.delete(targetId);
  const siblings = childTargets.get(parentTargetId);
  siblings?.delete(targetId);
  if (siblings?.size === 0) childTargets.delete(parentTargetId);
}

function clearTargetSession(targetId: string, { remove = false } = {}): void {
  const target = targetStates.get(targetId);
  if (!target) return;
  rejectFileChooserInterception(target, new Error('file chooser session was detached'));
  if (target.sessionId) {
    sessionTargets.delete(target.sessionId);
  }
  if (remove) {
    targetStates.delete(targetId);
    if (defaultTargetId === targetId) defaultTargetId = null;
    return;
  }
  target.sessionId = null;
  target.sessionAt = 0;
  target.sessionInflight = null;
  target.events.length = 0;
  target.pageEventsEnabled = false;
  target.pageEnableInflight = null;
  target.networkDomainEnabled = false;
  target.networkEnableInflight = null;
  target.autoAttachEnabled = false;
  target.autoAttachInflight = null;
  target.inflightNetworkRequests.clear();
  target.ignoredFaviconRequestIds.clear();
  target.lastNetworkActivityAt = state.now();
  target.pendingDialog = null;
  target.fileChooserInterception = null;
}

function clearTargetSessionTree(targetId: string, { remove = false } = {}): void {
  for (const childTargetId of [...(childTargets.get(targetId) ?? [])]) {
    clearTargetSessionTree(childTargetId, { remove: true });
  }
  clearTargetSession(targetId, { remove });
  if (remove) {
    childTargets.delete(targetId);
    unregisterTargetParent(targetId);
  }
}

/** `value` unless it is null, undefined or empty (upstream reads these with `||`). */
function present(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : value;
}

function capEvents(events: CdpEvent[]): void {
  if (events.length > MAX_BUFFERED_EVENTS) {
    events.splice(0, events.length - MAX_BUFFERED_EVENTS);
  }
}

export function isBrowserRuntime(): boolean {
  return typeof globalThis.ego?.sendCDPMessage === 'function';
}

export function browserEgo(): EgoBindings {
  if (!globalThis.ego) {
    throw new Error('browser runtime is not available');
  }
  return globalThis.ego;
}

/** Keep exceptions from crossing the native-to-JavaScript callback boundary. */
function guardNativeCallback(label: string, callback: () => void): void {
  try {
    callback();
  } catch (error) {
    try {
      console.error(`[ego-browser] ${label} failed:`, error);
    } catch {
      // Error reporting must not re-enter the native callback failure.
    }
  }
}

function dispatchCdpMessage(payload: string): void {
  guardNativeCallback('onCDPMessage', () => {
    handleMessage(payload);
  });
}

function dispatchCdpSendError(message: string, errorCode?: string): void {
  guardNativeCallback('onSendCDPMessageError', () => {
    handleSendError(message, errorCode);
  });
}

function bindRuntimeCallbacks(runtime: EgoCdpCallbackRuntime): void {
  if (callbackRuntime && callbackRuntime !== runtime) {
    releaseRuntimeCallbacks(callbackRuntime);
  }
  runtime.onCDPMessage = dispatchCdpMessage;
  runtime.onSendCDPMessageError = dispatchCdpSendError;
  callbackRuntime = runtime;
}

/** Release only callbacks installed by this runtime, preserving foreign owners. */
export function releaseRuntimeCallbacks(
  runtime: EgoCdpCallbackRuntime | undefined = callbackRuntime,
): void {
  if (!runtime) return;
  if (runtime.onCDPMessage === dispatchCdpMessage) {
    runtime.onCDPMessage = undefined;
  }
  if (runtime.onSendCDPMessageError === dispatchCdpSendError) {
    runtime.onSendCDPMessageError = undefined;
  }
  if (callbackRuntime === runtime) callbackRuntime = undefined;
}

/** Stop all runtime work before the host discards a run. */
export function disposeBrowserRuntime(
  runtime: EgoCdpCallbackRuntime | undefined = callbackRuntime,
): void {
  releaseRuntimeCallbacks(runtime);
  rejectAllPending(new Error('ego-browser runtime was disposed'));
  browserEventSubscribers.clear();
  pageEventSubscribers.clear();
  invalidateSession();
}

/** Subscribe to Target/Browser events without consuming the legacy event queue. */
export function subscribeBrowserEvents(listener: (event: CdpEvent) => void): () => void {
  if (typeof listener !== 'function') {
    throw new TypeError('browser event listener must be a function');
  }
  browserEventSubscribers.add(listener);
  return () => browserEventSubscribers.delete(listener);
}

/** Subscribe to session events for one browser target. */
export function subscribePageEvents(
  targetId: string,
  listener: (event: CdpEvent) => void,
): () => void {
  if (typeof targetId !== 'string' || targetId.length === 0) {
    throw new TypeError('page event subscription requires a targetId');
  }
  if (typeof listener !== 'function') {
    throw new TypeError('page event listener must be a function');
  }
  let listeners = pageEventSubscribers.get(targetId);
  if (!listeners) {
    listeners = new Set();
    pageEventSubscribers.set(targetId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) pageEventSubscribers.delete(targetId);
  };
}

function paramsObject(params: object | undefined): CdpObject {
  return params === undefined ? {} : { ...params };
}

function rawCdp<M extends string>(
  method: M,
  params: object = {},
  sessionId?: string,
  timeoutMs: number = responseTimeoutMs(),
): Promise<CdpResponse<M>> {
  const runtime = browserEgo();
  bindRuntimeCallbacks(runtime);
  const id = nextMessageId++;
  const payload = JSON.stringify({
    id,
    method,
    params,
    ...(sessionId ? { sessionId } : {}),
  });
  return new Promise<CdpResponse<M>>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // Commands sent outside browserCdp() skip its dialog check. Name the
      // dialog if one is what stalled this command.
      const dialog = sessionId && !DIALOG_SAFE_METHOD(method) ? pendingDialog(sessionId) : null;
      reject(
        sessionId && dialog
          ? new PageDialogOpenedError(method, sessionId, dialog, {
              alreadyOpen: true,
            })
          : new CdpRequestTimeoutError(method, timeoutMs, sessionId),
      );
    }, timeoutMs);
    pending.set(id, {
      method,
      sessionId,
      resolve: (response) => {
        clearTimeout(timer);
        // The envelope was validated when it arrived; its `result` follows the
        // protocol type of `method`.
        resolve(response);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    try {
      runtime.sendCDPMessage(payload);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(buildEgoError(error));
    }
  });
}

export async function browserCdp<M extends string>(
  method: M,
  params?: CdpParams<M>,
  sessionId?: string,
  timeoutMs: number = responseTimeoutMs(),
): Promise<CdpResponse<M>> {
  const body = paramsObject(params);
  // Test mock: cdpOverride bypasses everything including session injection.
  // Include the effective timeout so tests can verify timing contracts without
  // waiting for a real CDP deadline.
  if (state.cdpOverride) {
    return (await state.cdpOverride(method, body, sessionId, timeoutMs)) as CdpResponse<M>;
  }
  const explicit = sessionId !== undefined;
  let effective = sessionId;
  if (!explicit && !BROWSER_LEVEL(method)) {
    effective = await ensureSession();
  }
  const dialog = effective && !DIALOG_SAFE_METHOD(method) ? pendingDialog(effective) : null;
  if (effective && dialog) {
    throw new PageDialogOpenedError(method, effective, dialog, {
      alreadyOpen: true,
    });
  }
  try {
    const response = await rawCdp(method, body, effective, timeoutMs);
    recordCommandState(method, body, effective, response);
    return response;
  } catch (error) {
    const lost = error instanceof Error && SESSION_LOST.test(error.message);
    if (lost && !explicit && !BROWSER_LEVEL(method)) {
      const lostTargetId = effective ? sessionTargets.get(effective) : defaultTargetId;
      if (lostTargetId) clearTargetSession(lostTargetId);
      const fresh = await ensureSession(lostTargetId ?? undefined);
      const response = await rawCdp(method, body, fresh, timeoutMs);
      recordCommandState(method, body, fresh, response);
      return response;
    }
    throw error;
  }
}

function recordCommandState(
  method: string,
  params: CdpObject,
  sessionId: string | undefined,
  response: CdpResponse<string>,
): void {
  if (method === 'Target.attachToTarget') {
    const result = response.result;
    const attachedSessionId =
      typeof result?.sessionId === 'string' ? result.sessionId : response.sessionId;
    if (typeof params.targetId === 'string' && params.targetId && attachedSessionId) {
      registerSession(params.targetId, attachedSessionId);
    }
    return;
  }
  if (method === 'Target.detachFromTarget' && typeof params.sessionId === 'string') {
    const targetId = sessionTargets.get(params.sessionId);
    if (targetId) clearTargetSession(targetId);
    return;
  }
  if (!sessionId) return;
  const targetId = sessionTargets.get(sessionId);
  if (!targetId) return;
  const target = targetStates.get(targetId);
  if (!target) return;
  if (method === 'Network.enable') {
    if (!target.networkDomainEnabled) {
      target.lastNetworkActivityAt = state.now();
    }
    target.networkDomainEnabled = true;
  }
  if (method === 'Network.disable') {
    target.networkDomainEnabled = false;
    target.inflightNetworkRequests.clear();
    target.ignoredFaviconRequestIds.clear();
    target.lastNetworkActivityAt = state.now();
  }
  if (method === 'Target.setAutoAttach') {
    target.autoAttachEnabled = params.autoAttach === true;
  }
}

export async function ensureSession(
  requestedTargetId?: string,
  timeoutMs: number = responseTimeoutMs(),
): Promise<string> {
  const cachedTargetId =
    present(requestedTargetId) ?? present(state.preferredTargetId) ?? present(defaultTargetId);
  const cached = cachedTargetId ? targetStates.get(cachedTargetId) : undefined;
  // Session setup is best-effort and shared: an unanswered request keeps
  // running for later callers, while this caller's wait stays short so that
  // the command it actually came for gets the rest of its budget.
  const setupWaitMs = Math.min(Math.max(1, timeoutMs), SESSION_SETUP_WAIT_MS);
  const cachedSessionId = cached?.sessionId;
  if (cached && cachedSessionId && Date.now() - cached.sessionAt < SESSION_TTL_MS) {
    await Promise.all([
      enablePageEvents(cachedSessionId, setupWaitMs),
      enableNetworkTrackingForSession(cachedSessionId, false, setupWaitMs),
      enableOopifAutoAttach(cachedSessionId, setupWaitMs),
    ]);
    cached.sessionAt = Date.now();
    return cachedSessionId;
  }

  let targetId = requestedTargetId;
  if (!targetId) {
    const result = await invokeEgo('listTabs', () => browserEgo().listTabs());
    const tabs = result.tabs;
    const preferred = state.preferredTargetId
      ? tabs.find((tab) => tab.targetId === state.preferredTargetId)
      : undefined;
    const active = preferred ?? tabs.find((tab) => tab.active) ?? tabs[tabs.length - 1];
    if (!active) {
      throw new Error('no active tab to attach session');
    }
    targetId = active.targetId;
  }

  defaultTargetId = targetId;
  const target = targetState(targetId);
  if (target.sessionInflight) {
    return target.sessionInflight;
  }
  const attachTargetId = targetId;
  target.sessionInflight = (async () => {
    try {
      let sessionId = target.sessionId;
      if (!sessionId) {
        const attached = await rawCdp(
          'Target.attachToTarget',
          { targetId: attachTargetId, flatten: true },
          undefined,
          timeoutMs,
        );
        const attachedSessionId = attached.result?.sessionId ?? attached.sessionId;
        if (!attachedSessionId) {
          throw new Error('Target.attachToTarget returned no sessionId');
        }
        registerSession(attachTargetId, attachedSessionId);
        sessionId = attachedSessionId;
      }
      await Promise.all([
        enablePageEvents(sessionId, setupWaitMs),
        enableNetworkTrackingForSession(sessionId, false, setupWaitMs),
        enableOopifAutoAttach(sessionId, setupWaitMs),
      ]);
      target.sessionAt = Date.now();
      return target.sessionId ?? sessionId;
    } finally {
      target.sessionInflight = null;
    }
  })();
  return target.sessionInflight;
}

/** Frame id → session that owns it, plus each frame's parent frame id. */
export type FrameSessions = Map<string, string> & {
  parentFrameIds?: ReadonlyMap<string, string | undefined>;
};

type WireFrameTree = Wire<Protocol.Page.FrameTree>;
type WireTargetInfo = Wire<Protocol.Target.TargetInfo>;
type IframeTargetInfo = WireTargetInfo & { targetId: string };

/**
 * Attach sessions for every live OOPIF that belongs to one top-level Page.
 * Standard CDP reports an iframe target's parent as a frame id. The frame tree
 * and target metadata together recover the nearest Page/OOPIF target ancestor
 * without admitting unrelated iframe targets.
 */
export async function ensureFrameSessions(
  pageTargetId: string,
  timeoutMs: number = responseTimeoutMs(),
): Promise<FrameSessions> {
  if (typeof pageTargetId !== 'string' || pageTargetId.length === 0) {
    throw new TypeError('ensureFrameSessions requires a non-empty targetId');
  }
  const startedAt = state.now();
  const deadline = startedAt + Math.max(1, timeoutMs);
  const remaining = () => Math.max(1, deadline - state.now());
  const pageSessionId = await ensureSession(pageTargetId, remaining());
  let response: CdpResponse<'Target.getTargets'>;
  let frameTreeResponse: CdpResponse<'Page.getFrameTree'>;
  try {
    [response, frameTreeResponse] = await Promise.all([
      browserCdp('Target.getTargets', {}, undefined, remaining()),
      browserCdp('Page.getFrameTree', {}, pageSessionId, remaining()),
    ]);
  } catch (error) {
    // The browser process answers Target.getTargets on its own, so a frame
    // tree timeout means the Page's renderer did not answer within the budget
    // this call had left: name that instead of the last command sent.
    if (isCdpRequestTimeoutError(error) && error.method === 'Page.getFrameTree') {
      throw new PageUnresponsiveError(
        'Page.getFrameTree',
        state.now() - startedAt,
        pageTargetId,
        pageSessionId,
      );
    }
    throw error;
  }
  const targetInfos = response.result?.targetInfos ?? [];
  const frameTree = frameTreeResponse.result?.frameTree;
  const frameParents = new Map<string, string | undefined>();
  const collectFrameGraph = (
    tree: WireFrameTree | undefined,
    recursiveParentId: string | undefined,
  ) => {
    const frameId = tree?.frame?.id;
    if (typeof frameId !== 'string') return;
    const protocolParentId = tree?.frame?.parentId;
    frameParents.set(
      frameId,
      typeof protocolParentId === 'string' ? protocolParentId : recursiveParentId,
    );
    for (const child of tree?.childFrames ?? []) {
      collectFrameGraph(child, frameId);
    }
  };
  if (frameTree) collectFrameGraph(frameTree, undefined);
  const rootFrameId = frameTree?.frame?.id;

  const iframeInfos = targetInfos.filter(
    (info): info is IframeTargetInfo => info.type === 'iframe' && typeof info.targetId === 'string',
  );
  const iframeInfoByTarget = new Map(iframeInfos.map((info) => [info.targetId, info]));
  const reportedParentFrameId = (info: WireTargetInfo | undefined): string | undefined => {
    const parentFrameId = info?.parentFrameId;
    return typeof parentFrameId === 'string' ? parentFrameId : undefined;
  };
  const parentFrameIdOf = (frameId: string): string | undefined => {
    if (frameParents.has(frameId)) return frameParents.get(frameId);
    return reportedParentFrameId(iframeInfoByTarget.get(frameId));
  };
  const ancestryToPage = (frameId: string): { belongs: boolean; depth: number } => {
    let current: string | undefined = frameId;
    let depth = 0;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      if (current === pageTargetId || current === rootFrameId) {
        return { belongs: true, depth };
      }
      visited.add(current);
      current = parentFrameIdOf(current);
      depth += 1;
    }
    return { belongs: false, depth };
  };

  const descendants = iframeInfos
    .map((info) => ({ info, ancestry: ancestryToPage(info.targetId) }))
    .filter(({ ancestry }) => ancestry.belongs)
    .sort((left, right) => left.ancestry.depth - right.ancestry.depth)
    .map(({ info }) => info);
  const liveTargetIds = new Set(descendants.map((info) => info.targetId));
  const allLiveIframeTargetIds = new Set(iframeInfos.map((info) => info.targetId));
  const knownDescendants: string[] = [];
  const collectKnownDescendants = (parentTargetId: string) => {
    for (const childTargetId of childTargets.get(parentTargetId) ?? []) {
      knownDescendants.push(childTargetId);
      collectKnownDescendants(childTargetId);
    }
  };
  collectKnownDescendants(pageTargetId);
  for (const knownTargetId of [...knownDescendants].reverse()) {
    // Target.getTargets and Page.getFrameTree are separate snapshots. A live
    // target can momentarily be absent from the frame tree during a swap, so
    // only target disappearance is authoritative enough to discard a session.
    if (!allLiveIframeTargetIds.has(knownTargetId)) {
      clearTargetSessionTree(knownTargetId, { remove: true });
    }
  }
  for (const knownTargetId of knownDescendants) {
    if (allLiveIframeTargetIds.has(knownTargetId) && !liveTargetIds.has(knownTargetId)) {
      const info = iframeInfoByTarget.get(knownTargetId);
      if (info) {
        descendants.push(info);
        liveTargetIds.add(knownTargetId);
      }
    }
  }

  const nearestTargetParent = (info: IframeTargetInfo): string => {
    const ancestry = ancestryToPage(info.targetId);
    if (!ancestry.belongs) {
      const knownParentTargetId = parentTargets.get(info.targetId);
      if (knownParentTargetId) return knownParentTargetId;
    }
    let current = parentFrameIdOf(info.targetId);
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      if (current === pageTargetId || current === rootFrameId) {
        return pageTargetId;
      }
      if (liveTargetIds.has(current)) return current;
      visited.add(current);
      current = parentFrameIdOf(current);
    }
    return pageTargetId;
  };

  const sessionByTarget = new Map<string, string>([[pageTargetId, pageSessionId]]);
  const vanishedTargetIds = new Set<string>();
  for (const info of descendants) {
    let sessionId: string;
    try {
      sessionId = await ensureSession(info.targetId, remaining());
    } catch (error) {
      // Target.getTargets is a snapshot: an OOPIF can be destroyed between
      // enumeration and attach. Such a frame is no longer part of the page, so
      // drop it rather than fail (or restart) the whole discovery. Errors on
      // the Page target itself are raised by ensureSession above and are not
      // retried here.
      if (!isRetryableFrameLifecycleError(error)) throw error;
      vanishedTargetIds.add(info.targetId);
      liveTargetIds.delete(info.targetId);
      clearTargetSessionTree(info.targetId, { remove: true });
      continue;
    }
    registerTargetParent(info.targetId, nearestTargetParent(info));
    sessionByTarget.set(info.targetId, sessionId);
  }

  const sessions: FrameSessions = new Map<string, string>();
  const collectFrameSessions = (
    tree: WireFrameTree | undefined,
    inheritedSessionId: string,
    isRoot = false,
  ) => {
    const frameId = tree?.frame?.id;
    if (typeof frameId !== 'string' || vanishedTargetIds.has(frameId)) return;
    const sessionId = sessionByTarget.get(frameId) ?? inheritedSessionId;
    if (!isRoot) sessions.set(frameId, sessionId);
    for (const child of tree?.childFrames ?? []) {
      collectFrameSessions(child, sessionId);
    }
  };
  if (frameTree) collectFrameSessions(frameTree, pageSessionId, true);
  for (const info of descendants) {
    if (vanishedTargetIds.has(info.targetId)) continue;
    const sessionId = sessionByTarget.get(info.targetId);
    if (!sessions.has(info.targetId) && sessionId !== undefined) {
      sessions.set(info.targetId, sessionId);
    }
  }
  sessions.parentFrameIds = new Map(
    [...sessions.keys()].map((frameId) => [frameId, parentFrameIdOf(frameId)]),
  );
  return sessions;
}

export function invalidateSession(targetId?: string): void {
  if (targetId) {
    clearTargetSessionTree(targetId, { remove: true });
    return;
  }
  for (const knownTargetId of [...targetStates.keys()]) {
    clearTargetSession(knownTargetId, { remove: true });
  }
  browserEvents.length = 0;
  childTargets.clear();
  parentTargets.clear();
  defaultTargetId = null;
  resetUserControlProbe();
}

export function setPreferredTarget(targetId: string | null | undefined): void {
  state.preferredTargetId = present(targetId) ?? null;
}

export function clearPreferredTarget(): void {
  state.preferredTargetId = null;
}

/** Drain only events routed to one Page session. */
export function drainPageEvents(sessionId: string | undefined): CdpEvent[] {
  const targetId = sessionId ? sessionTargets.get(sessionId) : undefined;
  const target = targetId ? targetStates.get(targetId) : undefined;
  return target ? target.events.splice(0, target.events.length) : [];
}

/**
 * Return the JavaScript dialog blocking the Page that owns this session. An
 * OOPIF session reports its top-level Page's dialog: Chromium delivers every
 * dialog event on the Page session, and a dialog opened by any frame stalls
 * that frame's renderer.
 */
export function pendingDialog(sessionId: string | undefined): PageDialog | null {
  const targetId = sessionId
    ? sessionTargets.get(sessionId)
    : (state.preferredTargetId ?? defaultTargetId);
  const dialog = targetId ? targetStates.get(pageRootTargetId(targetId))?.pendingDialog : null;
  return dialog ? { ...dialog } : null;
}

/** Ensure Network events are available on every selected Page/OOPIF session. */
export async function ensureNetworkTracking(
  sessionIds: string[],
  timeoutMs: number = responseTimeoutMs(),
): Promise<void> {
  const unique = [...new Set(sessionIds.filter(Boolean))];
  await Promise.all(
    unique.map((sessionId) => enableNetworkTrackingForSession(sessionId, true, timeoutMs)),
  );
}

/** Read continuous network state without consuming the public Page event queue. */
export function networkActivity(sessionIds: string[]): {
  tracking: boolean;
  inflight: number;
  lastActivityAt: number;
  pendingRequests: string[];
} {
  let tracking = sessionIds.length > 0;
  let inflight = 0;
  let lastActivityAt = 0;
  const pendingRequests: string[] = [];
  const counted = new Set<string>();
  for (const sessionId of new Set(sessionIds)) {
    const targetId = sessionTargets.get(sessionId);
    const target = targetId ? targetStates.get(targetId) : undefined;
    if (!targetId || target?.sessionId !== sessionId || !target.networkDomainEnabled) {
      tracking = false;
      continue;
    }
    // A request migrates to a child frame target the moment that target
    // attaches, which can precede the caller's next frame enumeration. Count
    // the whole subtree so migration never hides an in-flight request.
    for (const treeTargetId of pageTreeTargetIds(targetId)) {
      if (counted.has(treeTargetId)) continue;
      counted.add(treeTargetId);
      const member = targetStates.get(treeTargetId);
      if (!member) continue;
      inflight += member.inflightNetworkRequests.size;
      lastActivityAt = Math.max(lastActivityAt, member.lastNetworkActivityAt);
      for (const request of member.inflightNetworkRequests.values()) {
        pendingRequests.push(
          `${present(request.type) ?? 'Other'} ${present(request.url) ?? request.requestId}`,
        );
      }
    }
  }
  return { tracking, inflight, lastActivityAt, pendingRequests };
}

/** Refresh and return the main and known OOPIF sessions for one Page. */
export async function pageNetworkSessions(
  sessionId: string,
  timeoutMs: number = responseTimeoutMs(),
): Promise<string[]> {
  const targetId = sessionTargets.get(sessionId);
  if (!targetId) {
    throw new Error('cannot resolve Page network sessions from a detached session');
  }
  const frameSessions = await ensureFrameSessions(targetId, timeoutMs);
  const currentMainSession = targetStates.get(targetId)?.sessionId;
  if (!currentMainSession) {
    throw new Error('Page session was detached while refreshing network state');
  }
  return [...new Set([currentMainSession, ...frameSessions.values()])];
}

/**
 * Suppress the operating-system file picker and observe the next chooser in
 * one Page session. The caller owns the short-lived interception and must
 * dispose it after setting files or completing an input action.
 */
export function prepareFileChooser(
  sessionId: string,
  { timeoutMs, cancel }: { timeoutMs: number; cancel: boolean },
): FileChooserInterception {
  const targetId = sessionTargets.get(sessionId);
  const target = targetId ? targetStates.get(targetId) : undefined;
  if (!target) {
    throw new Error('cannot intercept a file chooser without a Page session');
  }
  if (target.fileChooserInterception) {
    throw new Error('this Page is already waiting for a file chooser');
  }

  let observed: FileChooserOpenedEvent | undefined;
  let resolveEvent: (event: FileChooserOpenedEvent) => void = () => undefined;
  let rejectEvent: (error: Error) => void = () => undefined;
  const event = new Promise<FileChooserOpenedEvent>((resolve, reject) => {
    resolveEvent = resolve;
    rejectEvent = reject;
  });
  // A safety interceptor normally consumes peek() instead of awaiting event.
  // Attach a rejection observer so disposal never creates an unhandled promise.
  event.catch(() => undefined);

  const interception: FileChooserInterceptionState = {
    cancelPromise: undefined,
    timer: undefined,
    ready: Promise.resolve(),
    event,
    reject: (error) => {
      rejectEvent(error);
    },
    resolve(value: FileChooserOpenedEvent) {
      if (observed) return;
      observed = value;
      clearTimeout(interception.timer);
      resolveEvent(value);
      if (cancel) {
        // An empty file list completes the intercepted chooser without opening
        // the native picker or changing the input's current selection.
        interception.cancelPromise = rawCdp(
          'DOM.setFileInputFiles',
          { files: [], backendNodeId: value.backendNodeId },
          sessionId,
        ).then(
          () => undefined,
          () => undefined,
        );
      }
    },
    peek() {
      return observed;
    },
    async dispose(reason?: Error) {
      if (target.fileChooserInterception !== interception) return;
      target.fileChooserInterception = null;
      clearTimeout(interception.timer);
      if (!observed && reason) rejectEvent(reason);
      await interception.ready.catch(() => undefined);
      await interception.cancelPromise;
      const disable = rawCdp(
        'Page.setInterceptFileChooserDialog',
        { enabled: false },
        sessionId,
      ).catch(() => undefined);
      if (target.pendingDialog) {
        // Chromium can hold this housekeeping response until the modal dialog
        // closes. Send it now, but do not keep the triggering action's gate
        // occupied; Page.handleJavaScriptDialog must be able to run next.
        return;
      }
      await disable;
    },
  };
  target.fileChooserInterception = interception;
  interception.ready = rawCdp('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId)
    .then(() => {
      interception.timer = setTimeout(() => {
        const error = Object.assign(
          new Error(`page.waitForFileChooser timed out after ${String(timeoutMs)}ms`),
          { code: 'EGO_FILE_CHOOSER_TIMEOUT' },
        );
        if (target.fileChooserInterception === interception) {
          target.fileChooserInterception = null;
          rejectEvent(error);
          void rawCdp('Page.setInterceptFileChooserDialog', { enabled: false }, sessionId).catch(
            () => undefined,
          );
        }
      }, timeoutMs);
    })
    .catch((error: unknown) => {
      if (target.fileChooserInterception === interception) {
        target.fileChooserInterception = null;
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      rejectEvent(failure);
      throw failure;
    });
  return interception;
}

async function enablePageEvents(
  sessionId: string,
  timeoutMs: number = responseTimeoutMs(),
): Promise<void> {
  const targetId = sessionId ? sessionTargets.get(sessionId) : undefined;
  const target = targetId ? targetStates.get(targetId) : undefined;
  if (target?.sessionId !== sessionId || target.pageEventsEnabled) {
    return;
  }
  try {
    await sharedSetupCommand(
      target,
      'pageEnableInflight',
      'Page.enable',
      {},
      sessionId,
      timeoutMs,
      () => {
        target.pageEventsEnabled = true;
      },
    );
  } catch {
    // Dialog tracking is best-effort. Do not make all helpers fail on targets
    // that reject Page.enable, such as unusual internal pages, or that cannot
    // answer yet because a navigation has not committed.
  }
}

async function enableNetworkTrackingForSession(
  sessionId: string,
  required = false,
  timeoutMs: number = responseTimeoutMs(),
): Promise<void> {
  const targetId = sessionId ? sessionTargets.get(sessionId) : undefined;
  const target = targetId ? targetStates.get(targetId) : undefined;
  if (target?.sessionId !== sessionId) {
    if (required) {
      throw new Error('cannot track network activity for a detached Page session');
    }
    return;
  }
  if (target.networkDomainEnabled) return;

  try {
    await sharedSetupCommand(
      target,
      'networkEnableInflight',
      'Network.enable',
      {},
      sessionId,
      timeoutMs,
      () => {
        // Events and an OOPIF request migration can race ahead of this
        // response. Network.disable and session replacement already clear
        // stale state, so enabling must preserve everything observed for the
        // current session.
        if (!target.networkDomainEnabled) {
          target.lastNetworkActivityAt = state.now();
          target.networkDomainEnabled = true;
        }
      },
    );
  } catch (error) {
    if (required) throw error;
  }
  if (required && !isTrackingNetwork(target)) {
    throw new Error('network tracking was interrupted by a detached Page session');
  }
}

/** Read through a function so the flag's narrowing does not survive the awaits above. */
function isTrackingNetwork(target: TargetState): boolean {
  return target.networkDomainEnabled;
}

async function enableOopifAutoAttach(
  sessionId: string,
  timeoutMs: number = responseTimeoutMs(),
): Promise<void> {
  const targetId = sessionId ? sessionTargets.get(sessionId) : undefined;
  const target = targetId ? targetStates.get(targetId) : undefined;
  if (target?.sessionId !== sessionId || target.autoAttachEnabled) {
    return;
  }
  try {
    await sharedSetupCommand(
      target,
      'autoAttachInflight',
      'Target.setAutoAttach',
      OOPIF_AUTO_ATTACH_PARAMS,
      sessionId,
      timeoutMs,
      () => {
        target.autoAttachEnabled = true;
      },
    );
  } catch {
    // Page APIs still work on bridges without auto-attach. Frame discovery can
    // attach explicitly later, but exact network-idle tracking needs support.
  }
}

type SetupInflightKey = 'pageEnableInflight' | 'networkEnableInflight' | 'autoAttachInflight';

/**
 * Send one session-setup command at most once at a time per session, and
 * bound this caller's wait without cancelling the request. The request keeps
 * the full transport timeout, so a Page that answers late (after its pending
 * navigation commits) still records the enabled state for later callers
 * instead of each caller sending the command again and waiting again.
 */
function sharedSetupCommand(
  target: TargetState,
  key: SetupInflightKey,
  method: string,
  params: object,
  sessionId: string,
  timeoutMs: number,
  onSuccess: () => void,
): Promise<void> {
  let inflight = target[key];
  if (!inflight) {
    const request = rawCdp(method, params, sessionId).then(() => {
      if (target.sessionId === sessionId) onSuccess();
    });
    inflight = request;
    target[key] = request;
    const clear = () => {
      if (target[key] === request) target[key] = null;
    };
    void request.then(clear, clear);
  }
  return waitForSharedCdpRequest(inflight, method, sessionId, timeoutMs);
}

/** Bound one caller's wait without cancelling the shared CDP request. */
function waitForSharedCdpRequest(
  request: Promise<void>,
  method: string,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  const callerTimeoutMs = Math.max(1, timeoutMs);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Mirror rawCdp's timeout: name a dialog if one is what stalled it.
      const dialog = DIALOG_SAFE_METHOD(method) ? null : pendingDialog(sessionId);
      reject(
        dialog
          ? new PageDialogOpenedError(method, sessionId, dialog, {
              alreadyOpen: true,
            })
          : new CdpRequestTimeoutError(method, callerTimeoutMs, sessionId),
      );
    }, callerTimeoutMs);
    request.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function initializeAutoAttachedTarget(sessionId: string, waitingForDebugger: boolean): void {
  // Invoke every initializer before awaiting any result. Chromium can pause an
  // OOPIF at attachment, so waiting for Network.enable before sending resume
  // would deadlock if the protocol response depends on renderer progress.
  const pageEvents = enablePageEvents(sessionId);
  const networkEvents = enableNetworkTrackingForSession(sessionId);
  const nestedFrames = enableOopifAutoAttach(sessionId);
  const resume = waitingForDebugger
    ? rawCdp('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined)
    : Promise.resolve();
  void Promise.allSettled([pageEvents, networkEvents, nestedFrames, resume]);
}

/**
 * Resume a non-frame target (worker, worklet, ...) paused by auto-attach and
 * drop its session, so the harness never holds a debugger on targets it does
 * not drive.
 */
function releaseAutoAttachedTarget(
  sessionId: string,
  parentSessionId: string,
  waitingForDebugger: boolean,
): void {
  // Detach is answered by the browser and could overtake a resume still on its
  // way to the renderer, so only detach after the resume has been answered.
  const resume = waitingForDebugger
    ? rawCdp('Runtime.runIfWaitingForDebugger', {}, sessionId)
    : Promise.resolve();
  void resume
    .catch(() => undefined)
    .then(() => rawCdp('Target.detachFromTarget', { sessionId }, parentSessionId))
    .catch(() => undefined);
}

function finishNetworkRequest(targetId: string, requestId: string): void {
  const now = state.now();
  const rootTargetId = pageRootTargetId(targetId);
  for (const pageTargetId of pageTreeTargetIds(rootTargetId)) {
    const pageTarget = targetStates.get(pageTargetId);
    if (!pageTarget) continue;
    if (pageTarget.inflightNetworkRequests.delete(requestId)) {
      pageTarget.lastNetworkActivityAt = now;
    }
  }
}

function isIgnoredFaviconRequest(targetId: string, requestId: string): boolean {
  const rootTargetId = pageRootTargetId(targetId);
  return pageTreeTargetIds(rootTargetId).some(
    (pageTargetId) =>
      targetStates.get(pageTargetId)?.ignoredFaviconRequestIds.has(requestId) === true,
  );
}

function clearIgnoredFaviconRequest(targetId: string, requestId: string): boolean {
  const rootTargetId = pageRootTargetId(targetId);
  let deleted = false;
  for (const pageTargetId of pageTreeTargetIds(rootTargetId)) {
    deleted =
      Boolean(targetStates.get(pageTargetId)?.ignoredFaviconRequestIds.delete(requestId)) ||
      deleted;
  }
  return deleted;
}

function recordNetworkEvent(targetId: string, target: TargetState, data: CdpEvent): void {
  // A response to Network.disable can be followed by a queued terminal event.
  // Ignore it once tracking is off, while still accepting events that race the
  // response to our own Network.enable request.
  if (!target.networkDomainEnabled && !target.networkEnableInflight) return;

  if (data.method === 'Network.requestWillBeSent') {
    const params = data.params;
    const requestId = params?.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) return;
    const url = params?.request?.url;
    // Chromium can omit the terminal event for its automatic favicon request.
    // Playwright excludes favicons from network-idle accounting for the same
    // reason, so they must never leave a permanent in-flight entry here.
    if (
      (typeof url === 'string' && url.endsWith('/favicon.ico')) ||
      isIgnoredFaviconRequest(targetId, requestId)
    ) {
      target.ignoredFaviconRequestIds.add(requestId);
      if (target.inflightNetworkRequests.delete(requestId)) {
        target.lastNetworkActivityAt = state.now();
      }
      return;
    }
    target.networkDomainEnabled = true;
    target.inflightNetworkRequests.set(requestId, {
      requestId,
      ...(typeof params?.frameId === 'string' ? { frameId: params.frameId } : {}),
      ...(typeof params?.loaderId === 'string' ? { loaderId: params.loaderId } : {}),
      ...(typeof params?.type === 'string' ? { type: params.type } : {}),
      ...(typeof url === 'string' ? { url } : {}),
    });
    target.lastNetworkActivityAt = state.now();
    return;
  }
  if (data.method === 'Network.loadingFinished' || data.method === 'Network.loadingFailed') {
    const requestId = data.params?.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) return;
    target.networkDomainEnabled = true;
    if (clearIgnoredFaviconRequest(targetId, requestId)) return;
    finishNetworkRequest(targetId, requestId);
    target.lastNetworkActivityAt = state.now();
  }
}

// Local send failures for ego.sendCDPMessage() arrive here instead of as a CDP
// response. The callback carries no request id, so task-level failures reject
// every pending request. User-control failures first probe the native task state:
// the CDP callback does not carry the permission reason, while ordinary native
// calls may do so.
function handleSendError(message: string, error_code: string | undefined): void {
  if (pending.size === 0) return;

  if (error_code !== 'EGO_TASK_SPACE_USER_IN_CONTROL') {
    rejectAllPending(buildEgoError({ error: message, error_code }));
    return;
  }
  if (userControlProbeState === 'stopped' && userControlStopError) {
    rejectAllPending(userControlStopError);
    return;
  }
  if (userControlProbeState === 'probing') return;

  userControlProbeState = 'probing';
  const generation = ++userControlProbeGeneration;
  void probeUserControlReason(message, error_code, generation);
}

async function probeUserControlReason(
  message: string,
  error_code: string,
  generation: number,
): Promise<void> {
  const fallback = { error: message, error_code };
  const runtime = browserEgo();
  if (typeof runtime.setAgentTaskState !== 'function') {
    stopForUserControl(fallback, generation);
    return;
  }

  try {
    const result: unknown = await runtime.setAgentTaskState('Waiting for the user');
    if (generation !== userControlProbeGeneration) return;
    if (isEgoUserControlError(result)) {
      stopForUserControl(result, generation);
      return;
    }
    if (isRecord(result) && 'error' in result) {
      stopForUserControl(fallback, generation);
      return;
    }

    // Control came back between the failed send and the probe. The original
    // command still failed, but it must not create a new global hard stop.
    userControlProbeState = 'idle';
    userControlStopError = null;
    rejectAllPending(nativeSendError(message, error_code));
  } catch (error) {
    if (generation !== userControlProbeGeneration) return;
    stopForUserControl(isEgoUserControlError(error) ? error : fallback, generation);
  }
}

function stopForUserControl(errorLike: unknown, generation: number): void {
  if (generation !== userControlProbeGeneration) return;
  userControlStopError = buildEgoError(errorLike);
  userControlProbeState = 'stopped';
  rejectAllPending(userControlStopError);
}

function rejectAllPending(error: Error): void {
  const entries = [...pending.values()];
  pending.clear();
  for (const entry of entries) entry.reject(error);
}

function nativeSendError(message: string, error_code: string): Error & { error_code?: string } {
  const error: Error & { error_code?: string } = new Error(
    message || error_code || 'CDP send failed',
  );
  if (error_code) error.error_code = error_code;
  return error;
}

function resetUserControlProbe(): void {
  userControlProbeGeneration += 1;
  userControlProbeState = 'idle';
  userControlStopError = null;
}

/** The text of a CDP `error` member (`{ code, message }` or anything else). */
function cdpErrorText(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string' && error.message) {
    return error.message;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/**
 * Validate the envelope of one incoming message: a command response carries a
 * numeric `id`, an event a string `method` and an object `params`. The payload
 * inside follows the protocol (cdp-types.ts).
 */
function parseMessage(
  message: string,
): { response: CdpObject & { id: unknown } } | { event: CdpEvent } | null {
  let data: unknown;
  try {
    data = JSON.parse(message);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  if (Object.hasOwn(data, 'id')) {
    return { response: { ...data, id: data.id } };
  }
  if (
    typeof data.method !== 'string' ||
    (data.params !== undefined && !isRecord(data.params)) ||
    (data.sessionId !== undefined && typeof data.sessionId !== 'string')
  ) {
    return null;
  }
  return { event: data as CdpEvent };
}

function handleMessage(message: string): void {
  const parsed = parseMessage(message);
  if (!parsed) return;
  if ('response' in parsed) {
    const data = parsed.response;
    const entry = typeof data.id === 'number' ? pending.get(data.id) : undefined;
    if (!entry || typeof data.id !== 'number') {
      return;
    }
    pending.delete(data.id);
    if (data.error) {
      const error: CdpCommandError = new Error(cdpErrorText(data.error));
      if (entry.sessionId) error.sessionId = entry.sessionId;
      entry.reject(error);
      return;
    }
    if (userControlProbeState === 'stopped') {
      // A successful command proves control has returned. Re-arm detection so a
      // later, separate takeover can run its own reason probe.
      resetUserControlProbe();
    }
    entry.resolve({
      ...(isRecord(data.result) ? { result: data.result } : {}),
      ...(typeof data.sessionId === 'string' ? { sessionId: data.sessionId } : {}),
    });
    return;
  }
  const data = parsed.event;
  if (data.method === 'Target.detachedFromTarget') {
    // The detached session names its target; the deprecated `targetId` field is not read.
    const detachedSessionId = data.params?.sessionId;
    const targetId = detachedSessionId ? sessionTargets.get(detachedSessionId) : undefined;
    if (targetId) {
      clearTargetSessionTree(targetId, { remove: false });
    }
  } else if (data.method === 'Target.targetDestroyed') {
    const targetId = data.params?.targetId;
    if (targetId) {
      clearTargetSessionTree(targetId, { remove: true });
    }
  } else if (data.method === 'Target.attachedToTarget') {
    const params = data.params;
    const sessionId = params?.sessionId;
    const targetId = params?.targetInfo?.targetId;
    const targetType = params?.targetInfo?.type;
    const reportedParentFrameId = params?.targetInfo?.parentFrameId;
    const waitingForDebugger = params?.waitingForDebugger === true;
    // Target.attachedToTarget is emitted on the nearest owning target session.
    // Prefer that target edge over parentFrameId, which may name a same-process
    // frame and is not itself a debuggable target.
    const sourceSessionId = data.sessionId;
    const sourceTargetId = sourceSessionId ? sessionTargets.get(sourceSessionId) : undefined;
    const parentTargetId = sourceTargetId ?? reportedParentFrameId;
    if (sessionId && targetId) registerSession(targetId, sessionId);
    if (targetId && parentTargetId && targetId !== parentTargetId) {
      registerTargetParent(targetId, parentTargetId);
    }
    if (sessionId && targetType === 'iframe') {
      initializeAutoAttachedTarget(sessionId, waitingForDebugger);
    } else if (sessionId && sourceSessionId && sourceTargetId && targetType !== 'page') {
      // Auto-attached by one of this runtime's sessions: a worker, worklet, or
      // other related target the harness does not drive.
      releaseAutoAttachedTarget(sessionId, sourceSessionId, waitingForDebugger);
    } else if (sessionId && waitingForDebugger) {
      // A foreign auto-attach configuration may still deliver other related
      // target types. Never leave an unrelated target paused by this runtime.
      void rawCdp('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
    }
  }
  const sessionId = data.sessionId;
  const targetId = sessionId ? sessionTargets.get(sessionId) : undefined;
  const target = targetId ? targetStates.get(targetId) : undefined;
  if (targetId && target) {
    recordNetworkEvent(targetId, target, data);
  }
  if (data.method === 'Page.javascriptDialogOpening') {
    if (targetId && target) {
      // A Page event proves the domain is enabled even if the Page.enable
      // response is stalled behind this dialog and rejected below.
      target.pageEventsEnabled = true;
      const root = targetStates.get(pageRootTargetId(targetId));
      if (root) {
        const dialog: PageDialog = data.params ?? {};
        root.pendingDialog = dialog;
        rejectCommandsBlockedByDialog(targetId, dialog);
      }
    }
  } else if (data.method === 'Page.javascriptDialogClosed') {
    const root = targetId ? targetStates.get(pageRootTargetId(targetId)) : undefined;
    if (root) root.pendingDialog = null;
  } else if (data.method === 'Page.fileChooserOpened') {
    const opened = data.params;
    if (opened && typeof opened.backendNodeId === 'number') {
      target?.fileChooserInterception?.resolve({
        backendNodeId: opened.backendNodeId,
        ...(typeof opened.frameId === 'string' ? { frameId: opened.frameId } : {}),
        ...(opened.mode ? { mode: opened.mode } : {}),
      });
    }
  }
  if (BROWSER_LEVEL(data.method)) {
    for (const listener of [...browserEventSubscribers]) {
      guardNativeCallback('browser event subscriber', () => {
        listener(data);
      });
    }
  }
  if (targetId) {
    for (const listener of [...(pageEventSubscribers.get(targetId) ?? [])]) {
      guardNativeCallback('page event subscriber', () => {
        listener(data);
      });
    }
  }
  const events = target ? target.events : browserEvents;
  events.push(data);
  capEvents(events);
}

function rejectCommandsBlockedByDialog(targetId: string, dialog: PageDialog): void {
  // The dialog stalls whichever renderer opened it, and CDP does not say which
  // frame session that is. Treat the whole Page tree as blocked.
  const sessionIds = new Set(
    pageTreeTargetIds(pageRootTargetId(targetId))
      .map((id) => targetStates.get(id)?.sessionId)
      .filter((id): id is string => Boolean(id)),
  );
  for (const [id, entry] of pending) {
    if (!entry.sessionId || !sessionIds.has(entry.sessionId) || DIALOG_SAFE_METHOD(entry.method)) {
      continue;
    }
    pending.delete(id);
    entry.reject(new PageDialogOpenedError(entry.method, entry.sessionId, dialog));
  }
}

function rejectFileChooserInterception(target: TargetState, error: Error): void {
  const interception = target.fileChooserInterception;
  if (!interception) return;
  target.fileChooserInterception = null;
  clearTimeout(interception.timer);
  interception.reject(error);
}
