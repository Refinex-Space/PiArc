// Ported from ego-browser package/ego-browser/src/page-model.test.mjs (ego-lite commit 56589ea8,
// MIT, see LICENSE): its `withFixture` / `createFixture` fake services and helpers, typed and
// shared by the page-model test files (PiArc splits upstream's 8k-line test into slices). PiArc:
// ledgers live in an in-memory storage instead of a temp directory; `screenshot` answers an
// attachment instead of a path; there is no clipboard service; `stageUpload` answers the paths
// it was given (recorded in `stagedUploads`); the agent cursor's target is recorded in
// `cursorTargets` so `calls` keeps upstream's shape. The viewport-metrics stub is gone with the
// SDK's viewport-overflow hint (the main process's snapshot prints it).

import { expect } from 'vitest';

import { fakeCdp } from '../testing.js';
import type {
  FileChooserInterception,
  FileChooserOpenedEvent,
  PageDialog,
} from './browser-runtime.js';
import type { CdpEvent, CdpObject } from './cdp-types.js';
import { isRecord } from './cdp-types.js';
import type { EgoSnapshotOptions } from './ego-bindings.js';
import { NativeOperationGate } from './native-gate.js';
import { flushSink, resetSink } from './output-sink.js';
import { PageLedgerStore, type PageLedgerStorage } from './page-ledger.js';
import { createTaskSpaceHandle, type TabInventoryItem } from './page-model.js';
import { PageRefRegistry } from './page-ref-registry.js';

/** The services a test passes to `createTaskSpaceHandle` (page-model keeps the type private). */
export type PageModelOverrides = NonNullable<Parameters<typeof createTaskSpaceHandle>[1]>;
export type TaskSpaceHandle = ReturnType<typeof createTaskSpaceHandle>;
export type PageHandle = ReturnType<TaskSpaceHandle['page']>;
export type UnmanagedPageHandle = Parameters<TaskSpaceHandle['adopt']>[0];

/** One recorded call: `[name, ...args]`, the shape upstream asserts with `deepEqual`. */
export type FixtureCall = [string, ...unknown[]];

/** A recorded `services.cdp` call (`calls` entries named `cdp`), typed for assertions. */
export interface RecordedCdpCall {
  readonly method: string;
  readonly params: CdpObject;
  readonly sessionId: string | undefined;
  readonly timeoutMs: number | undefined;
}

export interface FixtureTab {
  targetId: string;
  url: string;
  title: string;
  active: boolean;
  openerId?: string;
}

interface DialogInput {
  type?: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message?: string;
  url?: string;
  defaultPrompt?: string;
}

interface FileChooserWaiter extends FileChooserInterception {
  emit(value: FileChooserOpenedEvent): void;
}

interface FillConfiguration {
  kind?: string;
  initialText?: string;
  ignoreInsertions?: number;
  transform?: ((text: string, before: string, count: number) => string) | null;
}

interface SelectOption {
  value: string;
  label: string;
}

/** Text of a string-typed parameter (upstream calls `.includes` on it directly). */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** `params.arguments[0].value` of a `Runtime.callFunctionOn`. */
function firstArgumentValue(params: CdpObject): unknown {
  const args = params.arguments;
  if (!Array.isArray(args)) return undefined;
  const first: unknown = args[0];
  return isRecord(first) ? first.value : undefined;
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** An in-memory ledger storage shared by every store of one fixture (upstream: a temp dir). */
export function memoryLedgerStorage(): PageLedgerStorage & {
  readonly documents: Map<number, string>;
} {
  const documents = new Map<number, string>();
  return {
    documents,
    load(spaceId) {
      return Promise.resolve(documents.get(spaceId) ?? null);
    },
    save(spaceId, data) {
      if (data === '') documents.delete(spaceId);
      else documents.set(spaceId, data);
      return Promise.resolve();
    },
  };
}

export async function withFixture<T>(fn: (fixture: Fixture) => Promise<T>): Promise<T> {
  return fn(createFixture());
}

export type Fixture = ReturnType<typeof createFixture>;

export function createFixture() {
  const calls: FixtureCall[] = [];
  const tabs = new Map<string, FixtureTab>();
  const ledgerStorage = memoryLedgerStorage();
  let nextTarget = 1;
  let selectedSpace: number | null = null;
  let activeTarget: string | null = null;
  let popupOnNextClick: string | null = null;
  let fileChooserOnNextClick: FileChooserOpenedEvent | null = null;
  let activeFileChooserWaiter: FileChooserWaiter | null = null;
  let systemFileChooserOpened = false;
  let timeoutNextMouseDispatch = false;
  let loseSessionOnNextMouseRelease = false;
  let loseFrameOnNextResolution: { message: string; sessionId?: string } | null = null;
  let dialogOnNextClick: PageDialog | null = null;
  let dialogOnNextFileSet: PageDialog | null = null;
  const pendingDialogs = new Map<string, PageDialog>();
  let rejectedClickPointsRemaining = 0;
  let interceptedClickPointsRemaining = 0;
  let scrollClickPointsRemaining = 0;
  let trapClickPoints = false;
  let wheelDispatchDurationMs = 0;
  let fillElementKind = 'input';
  let fillText = '';
  let fillTransform: FillConfiguration['transform'] = null;
  let fillInsertionCount = 0;
  let ignoredFillInsertionsRemaining = 0;
  let focusResult: unknown = { focused: true };
  let unsafeFillActivationTarget: string | null = null;
  let selectedValues: (string | undefined)[] = [];
  let selectOptions: SelectOption[] = [
    { value: 'nl', label: 'Netherlands' },
    { value: 'one', label: 'One' },
    { value: 'two', label: 'Two' },
  ];
  let navigateOnNextClickUrl: string | null = null;
  let elementPresent = true;
  let elementVisible = true;
  let documentReadyState = 'complete';
  let domContentLoaded = true;
  let timeoutNextLifecycleEvaluate = false;
  let timeoutNextUrlEvaluate = false;
  let waitFunctionResults: boolean[] = [];
  let fetchFailure: string | null = null;
  let nowMs = 1_000;
  const pageEvents = new Map<string, CdpEvent[]>();
  const networkSessions = new Set<string>();
  const networkRequests = new Map<string, Set<string>>();
  const networkLastActivityAt = new Map<string, number>();
  const sessionOverrides = new Map<string, string>();
  const sessionTargets = new Map<string, string>();
  const snapshotOptions: EgoSnapshotOptions[] = [];
  const browserEventListeners = new Set<(event: CdpEvent) => void>();
  const sleepDurations: number[] = [];
  const stagedUploads: (readonly string[])[] = [];
  const cursorTargets: (string | undefined)[] = [];
  let targetDiscovery = true;
  let domActivity: unknown = null;
  let fileInputClicked = false;

  function tabOf(targetId: string): FixtureTab {
    const tab = tabs.get(targetId);
    if (!tab) throw new TypeError(`no fixture tab ${targetId}`);
    return tab;
  }

  function dispatchBrowserEvent(event: CdpEvent) {
    for (const listener of [...browserEventListeners]) listener(event);
  }

  function openPendingPopup() {
    if (!popupOnNextClick) return;
    const targetId = `target-${String(nextTarget++)}`;
    tabs.set(targetId, {
      targetId,
      url: popupOnNextClick,
      title: 'Popup',
      active: false,
    });
    popupOnNextClick = null;
    dispatchBrowserEvent({
      method: 'Target.targetCreated',
      params: {
        targetInfo: { targetId, type: 'page', url: tabOf(targetId).url },
      },
    });
  }
  function ensureTargetSession(targetId: string): Promise<string> {
    expect(tabs.has(targetId), `unknown target ${targetId}`).toBe(true);
    calls.push(['ensureSession', targetId]);
    const sessionId = sessionOverrides.get(targetId) ?? `session:${targetId}`;
    sessionTargets.set(sessionId, targetId);
    return Promise.resolve(sessionId);
  }
  function targetForSession(sessionId: string | undefined): string {
    return (
      (sessionId === undefined ? undefined : sessionTargets.get(sessionId)) ??
      (sessionId ?? '').slice('session:'.length)
    );
  }
  function dialogError(method: string, dialog: PageDialog): Error {
    return Object.assign(new Error(`a JavaScript dialog opened while ${method} was running`), {
      code: 'EGO_PAGE_DIALOG_OPENED',
      dialog,
    });
  }
  const gate = new NativeOperationGate({
    selectSpace(spaceId) {
      selectedSpace = spaceId;
      calls.push(['selectSpace', spaceId]);
      return Promise.resolve();
    },
    ensureSession: ensureTargetSession,
  });

  function fetchAnswer(binary: boolean): CdpObject {
    if (fetchFailure) {
      const message = fetchFailure;
      fetchFailure = null;
      return {
        result: {
          type: 'object',
          value: { fetchError: message },
        },
      };
    }
    return {
      result: {
        type: 'object',
        value: {
          ok: false,
          status: 418,
          statusText: "I'm a Teapot",
          url: 'https://example.test/api/teapot',
          headers: {
            'content-type': 'text/plain',
            'x-fixture': 'page-fetch',
          },
          ...(binary ? { bodyBase64: btoa('\x89PNG\r\n\x1a\n') } : { body: 'short and stout' }),
        },
      },
    };
  }

  function runtimeEvaluate(
    params: CdpObject,
    sessionId: string | undefined,
    timeoutMs: number | undefined,
  ): CdpObject {
    const expression = text(params.expression);
    if (expression.includes('__egoBrowserFileInputProbe')) {
      const reading = expression.includes('probe.seen === true');
      calls.push([reading ? 'fileInputProbeRead' : 'fileInputProbeInstall', sessionId]);
      return {
        result: {
          type: 'boolean',
          value: reading ? fileInputClicked : true,
        },
      };
    }
    if (loseFrameOnNextResolution) {
      const failure = loseFrameOnNextResolution;
      loseFrameOnNextResolution = null;
      const error: Error & { sessionId?: string } = new Error(failure.message);
      if (failure.sessionId) error.sessionId = failure.sessionId;
      throw error;
    }
    const targetId = targetForSession(sessionId);
    const tab = tabs.get(targetId);
    if (expression.includes('__egoPageEvaluate')) {
      if (expression.includes('missingClosureForE2E')) {
        return {
          result: {
            type: 'object',
            subtype: 'error',
            description: 'ReferenceError: missingClosureForE2E is not defined',
          },
          exceptionDetails: {
            text: 'Uncaught',
            lineNumber: 0,
            columnNumber: 0,
          },
        };
      }
      const match = /JSON\.parse\(("(?:\\.|[^"\\])*")\)/.exec(expression);
      const encoded = match?.[1];
      const argument: unknown =
        encoded === undefined ? undefined : JSON.parse(text(JSON.parse(encoded)));
      if (expression.includes('window.fetch')) {
        return fetchAnswer(field(argument, 'responseType') === 'base64');
      }
      return {
        result: {
          type: 'object',
          value: argument ?? null,
        },
      };
    }
    if (expression.includes('__egoActionableMatches')) {
      return params.returnByValue === false
        ? {
            result: {
              type: 'object',
              objectId: elementVisible ? `element:${targetId}` : undefined,
            },
          }
        : { result: { type: 'number', value: elementVisible ? 1 : 0 } };
    }
    if (expression.includes('__egoWaitForFunction')) {
      return {
        result: {
          type: 'object',
          value: {
            matched: waitFunctionResults.shift() ?? false,
            url: tab?.url,
            title: tab?.title,
          },
        },
      };
    }
    if (
      timeoutNextLifecycleEvaluate &&
      (expression === 'document.readyState' || expression.includes('domContentLoadedEventEnd'))
    ) {
      timeoutNextLifecycleEvaluate = false;
      nowMs += timeoutMs ?? 0;
      throw new Error('CDP request timed out: Runtime.evaluate');
    }
    if (expression === 'globalThis') {
      return {
        result: {
          type: 'object',
          objectId: `global:${targetId}`,
        },
      };
    }
    if (expression === 'location.href') {
      if (timeoutNextUrlEvaluate) {
        timeoutNextUrlEvaluate = false;
        nowMs += timeoutMs ?? 0;
        throw new Error('CDP request timed out: Runtime.evaluate');
      }
      return { result: { type: 'string', value: tab?.url } };
    }
    if (expression === 'document.title') {
      return { result: { type: 'string', value: tab?.title } };
    }
    if (expression === 'document.readyState') {
      return { result: { type: 'string', value: documentReadyState } };
    }
    if (expression.includes('domContentLoadedEventEnd')) {
      return {
        result: {
          type: 'object',
          value: {
            readyState: documentReadyState,
            domContentLoaded,
          },
        },
      };
    }
    if (expression.includes('performance.timeOrigin')) {
      return {
        result: {
          type: 'object',
          value: {
            readyState: 'complete',
            url: tab?.url,
            timeOrigin: Date.now() + 1_000,
          },
        },
      };
    }
    if (expression.includes('__egoNavigationState')) {
      return {
        result: {
          type: 'object',
          value: {
            url: tab?.url,
            readyState: documentReadyState,
          },
        },
      };
    }
    if (/return __egoQueryAllOpenShadow\([^;]+\)\.length;/.test(expression)) {
      return {
        result: { type: 'number', value: elementPresent ? 1 : 0 },
      };
    }
    if (expression.includes('ORDERED_NODE_SNAPSHOT_TYPE')) {
      return {
        result: { type: 'number', value: elementPresent ? 1 : 0 },
      };
    }
    if (expression.includes('innerWidth')) {
      return {
        result: {
          type: 'object',
          value: {
            url: tab?.url,
            title: tab?.title,
            w: targetId === 'target-1' ? 801 : 802,
            h: 600,
            sx: 0,
            sy: 0,
            pw: 1200,
            ph: 900,
          },
        },
      };
    }
    if (expression.includes('__egoBrowserDomActivity')) {
      calls.push(['domActivityProbe', sessionId]);
      return domActivity
        ? { result: { type: 'object', value: domActivity } }
        : { result: { type: 'string', value: 'complete' } };
    }
    if (params.returnByValue === false) {
      if (!elementPresent) {
        return { result: { type: 'undefined' } };
      }
      return {
        result: {
          type: 'object',
          objectId: `element:${targetId}`,
        },
      };
    }
    return { result: { type: 'string', value: 'complete' } };
  }

  function callFunctionOn(params: CdpObject, sessionId: string | undefined): CdpObject {
    const declaration = text(params.functionDeclaration);
    if (declaration.includes('missingClosureForE2E')) {
      return {
        result: {
          type: 'object',
          subtype: 'error',
          description: 'ReferenceError: missingClosureForE2E is not defined',
        },
        exceptionDetails: {
          text: 'Uncaught',
          lineNumber: 0,
          columnNumber: 0,
        },
      };
    }
    if (declaration.includes('focusElementForAction')) {
      return {
        result: { type: 'object', value: focusResult },
      };
    }
    if (declaration.includes('safeFillActivationTarget')) {
      return {
        result: {
          type: 'object',
          value: unsafeFillActivationTarget
            ? { error: unsafeFillActivationTarget }
            : { safe: true },
        },
      };
    }
    if (declaration.includes('resolveFileInputForUpload')) {
      const targetId = targetForSession(sessionId);
      return {
        result: {
          type: 'object',
          objectId: `file-input:${targetId}`,
        },
      };
    }
    if (declaration.includes('resolveFillTargetForAction')) {
      const targetId = targetForSession(sessionId);
      return {
        result: {
          type: 'object',
          objectId: `element:${targetId}`,
        },
      };
    }
    if (declaration.includes('fillPreparation')) {
      return {
        result: {
          type: 'object',
          value: {
            status: 'needsinput',
            kind: fillElementKind,
            cursorPoint: { x: 40, y: 60 },
            before: fillText,
          },
        },
      };
    }
    if (declaration.includes('selectOptionsForAction')) {
      const requested = firstArgumentValue(params);
      const choices: unknown[] = Array.isArray(requested) ? requested : [];
      selectedValues = choices.map((choice) => {
        const option =
          typeof choice === 'string'
            ? selectOptions.find(
                (candidate) => candidate.value === choice || candidate.label === choice,
              )
            : selectOptions.find(
                (candidate, index) =>
                  (field(choice, 'value') === undefined ||
                    candidate.value === field(choice, 'value')) &&
                  (field(choice, 'label') === undefined ||
                    candidate.label === field(choice, 'label')) &&
                  (field(choice, 'index') === undefined || index === field(choice, 'index')),
              );
        return option?.value;
      });
      return {
        result: { type: 'object', value: { selected: selectedValues } },
      };
    }
    if (declaration.includes('readFilledValue')) {
      return {
        result: {
          type: 'object',
          value: {
            actual: fillText,
            type: fillElementKind === 'input' ? 'text' : '',
          },
        },
      };
    }
    if (declaration.includes('checkVisibility')) {
      return { result: { type: 'boolean', value: elementVisible } };
    }
    if (declaration.includes('window.scrollBy')) {
      const delta = firstArgumentValue(params);
      return {
        result: {
          type: 'object',
          value: {
            x: field(delta, 'deltaX') ?? 0,
            y: field(delta, 'deltaY') ?? 0,
          },
        },
      };
    }
    if (declaration.includes('window.fetch')) {
      return fetchAnswer(field(firstArgumentValue(params), 'responseType') === 'base64');
    }
    if (declaration.includes('getBoundingClientRect')) {
      if (trapClickPoints) {
        // The wheel point sits on an element that swallows wheel events:
        // the target never moves, so every evaluation asks for the same
        // scroll until a programmatic scroll finally brings it in.
        return {
          result: {
            type: 'object',
            value: {
              scroll: { x: 80, y: 599, deltaX: 0, deltaY: 900 },
            },
          },
        };
      }
      if (scrollClickPointsRemaining > 0) {
        scrollClickPointsRemaining -= 1;
        return {
          result: {
            type: 'object',
            value: {
              scroll: { x: 80, y: 300, deltaX: 0, deltaY: 600 },
            },
          },
        };
      }
      if (interceptedClickPointsRemaining > 0 && declaration.includes('elementFromPoint')) {
        interceptedClickPointsRemaining -= 1;
        return {
          result: {
            type: 'object',
            value: {
              error: '<button id="overlay"> intercepts pointer events',
            },
          },
        };
      }
      if (rejectedClickPointsRemaining > 0) {
        rejectedClickPointsRemaining -= 1;
        return {
          result: {
            type: 'object',
            value: { error: 'element is not visible in the viewport' },
          },
        };
      }
      return {
        result: { type: 'object', value: { x: 40, y: 60 } },
      };
    }
    if (declaration.includes('const probe = { seen')) {
      return { result: { type: 'boolean', value: true } };
    }
    if (declaration.includes('target.dispatchEvent')) {
      openPendingPopup();
      return {
        result: {
          type: 'object',
          value: { seen: false, fallback: true },
        },
      };
    }
    return {
      result: {
        type: 'object',
        value: firstArgumentValue(params) ?? null,
      },
    };
  }

  function dispatchMouseEvent(params: CdpObject, sessionId: string | undefined): CdpObject {
    if (params.type === 'mouseWheel') nowMs += wheelDispatchDurationMs;
    if (timeoutNextMouseDispatch) {
      timeoutNextMouseDispatch = false;
      throw new Error('CDP request timed out: Input.dispatchMouseEvent');
    }
    if (params.type === 'mouseReleased') {
      if (loseSessionOnNextMouseRelease) {
        loseSessionOnNextMouseRelease = false;
        throw new Error('Session with given id not found');
      }
      if (dialogOnNextClick) {
        const dialog = dialogOnNextClick;
        dialogOnNextClick = null;
        pendingDialogs.set(sessionId ?? '', dialog);
        throw dialogError('Input.dispatchMouseEvent', dialog);
      }
      if (fileChooserOnNextClick) {
        if (activeFileChooserWaiter) {
          activeFileChooserWaiter.emit(fileChooserOnNextClick);
        } else {
          systemFileChooserOpened = true;
        }
        fileChooserOnNextClick = null;
      }
      if (navigateOnNextClickUrl) {
        const tab = tabOf(targetForSession(sessionId));
        tab.url = navigateOnNextClickUrl;
        tab.title = navigateOnNextClickUrl;
        navigateOnNextClickUrl = null;
      }
      openPendingPopup();
    }
    return {};
  }

  // Synchronous: `fakeCdp` turns a throw into the rejected command, as upstream's async handler.
  function handleCdp(
    method: string,
    params: CdpObject,
    sessionId: string | undefined,
    timeoutMs: number | undefined,
  ): CdpObject {
    const call: FixtureCall = ['cdp', method, params, sessionId];
    if (timeoutMs !== undefined) call.push(timeoutMs);
    calls.push(call);
    if (method === 'Page.getFrameTree')
      return {
        frameTree: {
          frame: { id: 'frame-1', loaderId: 'main-document' },
          childFrames: ['frame-same', 'frame-oopif', 'frame-child'].map((id) => ({
            frame: { id, loaderId: `document:${id}` },
          })),
        },
      };
    if (method === 'Page.navigate') {
      const tab = tabOf(targetForSession(sessionId));
      tab.url = text(params.url);
      tab.title = text(params.url);
      return { frameId: 'frame-1' };
    }
    if (method === 'Runtime.evaluate') return runtimeEvaluate(params, sessionId, timeoutMs);
    if (method === 'Runtime.callFunctionOn') return callFunctionOn(params, sessionId);
    if (method === 'DOM.resolveNode') {
      const targetId = targetForSession(sessionId);
      return {
        object: {
          type: 'object',
          objectId: `element:${targetId}:${String(params.backendNodeId)}`,
        },
      };
    }
    if (method === 'Runtime.releaseObject') return {};
    if (method === 'Input.insertText') {
      if (ignoredFillInsertionsRemaining > 0) {
        ignoredFillInsertionsRemaining -= 1;
      } else {
        fillInsertionCount += 1;
        fillText = fillTransform
          ? fillTransform(text(params.text), fillText, fillInsertionCount)
          : text(params.text);
      }
      return {};
    }
    if (method === 'Input.dispatchKeyEvent') {
      if (params.type === 'rawKeyDown' && params.key === 'Delete') {
        fillText = '';
      }
      return {};
    }
    if (method === 'DOM.setFileInputFiles') {
      if (dialogOnNextFileSet) {
        const dialog = dialogOnNextFileSet;
        dialogOnNextFileSet = null;
        pendingDialogs.set(sessionId ?? '', dialog);
        throw dialogError('DOM.setFileInputFiles', dialog);
      }
      return {};
    }
    if (method === 'Network.enable') {
      const session = sessionId ?? '';
      if (!networkSessions.has(session)) {
        networkRequests.set(session, new Set());
        networkLastActivityAt.set(session, nowMs);
      }
      networkSessions.add(session);
      return {};
    }
    if (method === 'Network.disable') {
      const session = sessionId ?? '';
      networkSessions.delete(session);
      networkRequests.delete(session);
      networkLastActivityAt.delete(session);
      return {};
    }
    if (method === 'Browser.getVersion') {
      return { product: 'Ego Lite/Test' };
    }
    if (method === 'DOM.scrollIntoViewIfNeeded') {
      trapClickPoints = false;
      return {};
    }
    if (method === 'Input.dispatchMouseEvent') return dispatchMouseEvent(params, sessionId);
    if (method === 'Target.activateTarget') {
      activeTarget = text(params.targetId);
      return { success: true };
    }
    if (method === 'Target.setDiscoverTargets') return {};
    if (method === 'Page.handleJavaScriptDialog') {
      if (!pendingDialogs.has(sessionId ?? '')) {
        throw new Error('No dialog is showing');
      }
      pendingDialogs.delete(sessionId ?? '');
      return {};
    }
    if (method === 'Target.closeTarget') {
      tabs.delete(text(params.targetId));
      if (activeTarget === params.targetId) activeTarget = null;
      return { success: true };
    }
    if (method === 'Target.detachFromTarget') return {};
    throw new Error(`unexpected CDP method ${method}`);
  }

  const services = {
    gate,
    pageRefs: new PageRefRegistry(),
    createTab(url: string) {
      expect(selectedSpace).toBe(7);
      const targetId = `target-${String(nextTarget++)}`;
      tabs.set(targetId, { targetId, url, title: url, active: true });
      activeTarget = targetId;
      calls.push(['createTab', url, targetId]);
      return Promise.resolve(targetId);
    },
    listTabs() {
      expect(selectedSpace).toBe(7);
      return Promise.resolve(
        [...tabs.values()].map((tab) => ({
          ...tab,
          active: tab.targetId === activeTarget,
        })),
      );
    },
    cdp: fakeCdp(handleCdp),
    showAgentMousePosition(x: number, y: number, targetId?: string) {
      calls.push(['showAgentMousePosition', x, y]);
      cursorTargets.push(targetId);
      return Promise.resolve();
    },
    stageUpload(paths: readonly string[]) {
      stagedUploads.push([...paths]);
      return Promise.resolve(paths);
    },
    snapshot(options: EgoSnapshotOptions = {}) {
      const tab = activeTarget === null ? undefined : tabs.get(activeTarget);
      snapshotOptions.push({ ...options });
      calls.push(['snapshot', activeTarget]);
      return Promise.resolve({
        content: `snapshot:${String(tab?.url)}`,
        refs: [
          {
            backendNodeId: 21,
            role: 'button',
            name: 'Run action',
          },
        ],
      });
    },
    screenshot(options: CdpObject, sessionId: string) {
      calls.push(['screenshot', options, sessionId]);
      return Promise.resolve({ image: 1, width: 800, height: 600 });
    },
    pendingDialog(sessionId: string) {
      return pendingDialogs.get(sessionId) ?? null;
    },
    prepareFileChooser(
      sessionId: string,
      { timeoutMs, cancel }: { timeoutMs: number; cancel: boolean },
    ): FileChooserWaiter {
      calls.push(['prepareFileChooser', sessionId, { timeoutMs, cancel }]);
      let observed: FileChooserOpenedEvent | undefined;
      let resolveEvent: (value: FileChooserOpenedEvent) => void = () => undefined;
      let rejectEvent: (reason: Error) => void = () => undefined;
      const event = new Promise<FileChooserOpenedEvent>((resolve, reject) => {
        resolveEvent = resolve;
        rejectEvent = reject;
      });
      const waiter: FileChooserWaiter = {
        ready: Promise.resolve(),
        event,
        peek: () => observed,
        emit(value) {
          observed = value;
          resolveEvent(value);
        },
        dispose(reason?: Error) {
          calls.push(['disposeFileChooser', sessionId, reason?.message]);
          if (activeFileChooserWaiter === waiter) {
            activeFileChooserWaiter = null;
          }
          if (!observed && reason) rejectEvent(reason);
          return Promise.resolve();
        },
      };
      activeFileChooserWaiter = waiter;
      return waiter;
    },
    drainEvents(sessionId: string) {
      const events = pageEvents.get(sessionId) ?? [];
      pageEvents.set(sessionId, []);
      return events;
    },
    async ensureNetworkTracking(sessionIds: string[]) {
      for (const sessionId of new Set(sessionIds)) {
        if (!networkSessions.has(sessionId)) {
          await services.cdp('Network.enable', {}, sessionId);
        }
      }
    },
    pageNetworkSessions(sessionId: string) {
      return Promise.resolve([sessionId]);
    },
    networkActivity(sessionIds: string[]) {
      let tracking = sessionIds.length > 0;
      let inflight = 0;
      let lastActivityAt = 0;
      for (const sessionId of new Set(sessionIds)) {
        if (!networkSessions.has(sessionId)) {
          tracking = false;
          continue;
        }
        inflight += networkRequests.get(sessionId)?.size ?? 0;
        lastActivityAt = Math.max(lastActivityAt, networkLastActivityAt.get(sessionId) ?? 0);
      }
      return { tracking, inflight, lastActivityAt };
    },
    ensureSession: ensureTargetSession,
    ensureFrameSessions() {
      return Promise.resolve(new Map<string, string>());
    },
    invalidateSession(targetId: string) {
      calls.push(['invalidateSession', targetId]);
    },
    setPreferredTarget(targetId: string) {
      calls.push(['setPreferredTarget', targetId]);
    },
    supportsBackgroundPageDiscovery: () => true,
    ensureTargetDiscovery(spaceId: number) {
      calls.push(['ensureTargetDiscovery', spaceId]);
      return Promise.resolve(targetDiscovery);
    },
    subscribeBrowserEvents(listener: (event: CdpEvent) => void) {
      browserEventListeners.add(listener);
      return () => {
        browserEventListeners.delete(listener);
      };
    },
    now: () => nowMs,
    sleep: (ms: number) => {
      sleepDurations.push(ms);
      nowMs += ms;
      return Promise.resolve();
    },
  } satisfies PageModelOverrides;

  return {
    activeTarget: () => activeTarget,
    calls,
    gate,
    /** PiArc: replaces upstream's `rootDir`; stores share it across rounds. */
    ledgerStorage,
    services,
    sleepDurations,
    snapshotOptions,
    /** PiArc: every `stageUpload` call's paths. */
    stagedUploads,
    /** PiArc: the target each agent-cursor call named. */
    cursorTargets,
    tabs,
    addExternalTab(
      targetId: string,
      url: string,
      { active = false, ...details }: { active?: boolean; openerId?: string; title?: string } = {},
    ) {
      tabs.set(targetId, { targetId, url, title: url, active, ...details });
      if (active) activeTarget = targetId;
    },
    openPopupOnNextClick(url: string) {
      popupOnNextClick = url;
    },
    setTargetDiscovery(enabled: boolean) {
      targetDiscovery = enabled;
    },
    setDomActivity(value: unknown) {
      domActivity = value;
    },
    setFileInputClicked(value: boolean) {
      fileInputClicked = value;
    },
    emitFileChooser(value: FileChooserOpenedEvent = { backendNodeId: 91 }) {
      activeFileChooserWaiter?.emit(value);
    },
    markNetworkTracked(
      sessionId: string,
      { lastActivityAt = 0 }: { lastActivityAt?: number } = {},
    ) {
      networkSessions.add(sessionId);
      networkLastActivityAt.set(sessionId, lastActivityAt);
    },
    openFileChooserOnNextClick(options: Partial<FileChooserOpenedEvent> = {}) {
      fileChooserOnNextClick = {
        backendNodeId: options.backendNodeId ?? 71,
        frameId: options.frameId ?? 'frame-1',
        mode: options.mode ?? 'selectSingle',
      };
    },
    systemFileChooserOpened: () => systemFileChooserOpened,
    timeoutNextMouseDispatch() {
      timeoutNextMouseDispatch = true;
    },
    loseSessionOnNextMouseRelease() {
      loseSessionOnNextMouseRelease = true;
    },
    loseFrameOnNextResolution(failure: { message: string; sessionId?: string }) {
      loseFrameOnNextResolution = failure;
    },
    openDialogOnNextClick(dialog: DialogInput = {}) {
      dialogOnNextClick = {
        type: dialog.type ?? 'alert',
        message: dialog.message ?? 'Confirm action',
        url: dialog.url ?? 'https://example.test/dialog',
        ...(dialog.defaultPrompt === undefined ? {} : { defaultPrompt: dialog.defaultPrompt }),
      };
    },
    openDialogOnNextFileSet(dialog: DialogInput = {}) {
      dialogOnNextFileSet = {
        type: dialog.type ?? 'confirm',
        message: dialog.message ?? 'Replace the current project?',
        url: dialog.url ?? 'https://example.test/upload',
        ...(dialog.defaultPrompt === undefined ? {} : { defaultPrompt: dialog.defaultPrompt }),
      };
    },
    rejectNextClickPoint() {
      rejectedClickPointsRemaining = 1;
    },
    rejectClickPoints(count: number) {
      rejectedClickPointsRemaining = count;
    },
    interceptNextClickPoint() {
      interceptedClickPointsRemaining = 1;
    },
    interceptClickPoints(count: number) {
      interceptedClickPointsRemaining = count;
    },
    scrollNextClickPoint(count = 1) {
      scrollClickPointsRemaining = count;
    },
    trapClickPoints() {
      trapClickPoints = true;
    },
    setWheelDispatchDuration(ms: number) {
      wheelDispatchDurationMs = ms;
    },
    navigateOnNextClick(url: string) {
      navigateOnNextClickUrl = url;
    },
    configureFill({
      kind = 'input',
      initialText = '',
      ignoreInsertions = 0,
      transform = null,
    }: FillConfiguration) {
      fillElementKind = kind;
      fillText = initialText;
      fillTransform = transform;
      fillInsertionCount = 0;
      ignoredFillInsertionsRemaining = ignoreInsertions;
    },
    configureFocusResult(result: unknown) {
      focusResult = result;
    },
    configureUnsafeFillActivation(target: string | null) {
      unsafeFillActivationTarget = target;
    },
    configureSelectOptions(options: readonly SelectOption[]) {
      selectOptions = options.map((option) => ({ ...option }));
    },
    fillText: () => fillText,
    setElementState({ present = true, visible = true }: { present?: boolean; visible?: boolean }) {
      elementPresent = present;
      elementVisible = visible;
    },
    setDocumentLifecycle({
      readyState,
      domContentLoaded: loaded,
    }: {
      readyState: string;
      domContentLoaded: boolean;
    }) {
      documentReadyState = readyState;
      domContentLoaded = loaded;
    },
    timeoutNextLifecycleEvaluation() {
      timeoutNextLifecycleEvaluate = true;
    },
    timeoutNextUrlEvaluation() {
      timeoutNextUrlEvaluate = true;
    },
    setWaitFunctionResults(results: readonly boolean[]) {
      waitFunctionResults = [...results];
    },
    failNextFetch(message: string) {
      fetchFailure = message;
    },
    setSession(targetId: string, sessionId: string) {
      sessionOverrides.set(targetId, sessionId);
    },
    selectedValues() {
      return [...selectedValues];
    },
    emitPageEvent(targetId: string, method: string, params: CdpObject = {}) {
      const sessionId = `session:${targetId}`;
      const requestId = params.requestId;
      if (networkSessions.has(sessionId)) {
        const requests = networkRequests.get(sessionId) ?? new Set<string>();
        if (method === 'Network.requestWillBeSent' && typeof requestId === 'string' && requestId) {
          requests.add(requestId);
          networkLastActivityAt.set(sessionId, nowMs);
        } else if (
          (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') &&
          typeof requestId === 'string' &&
          requestId
        ) {
          requests.delete(requestId);
          networkLastActivityAt.set(sessionId, nowMs);
        }
        networkRequests.set(sessionId, requests);
      }
      const events = pageEvents.get(sessionId) ?? [];
      // A test event as the CDP channel would deliver it.
      events.push({ sessionId, method, params } as CdpEvent);
      pageEvents.set(sessionId, events);
    },
    emitBrowserEvent(method: string, params: CdpObject = {}) {
      for (const listener of [...browserEventListeners]) {
        // A test event as the CDP channel would deliver it.
        listener({ method, params } as CdpEvent);
      }
    },
  };
}

/** A new ledger store on the fixture's shared storage (upstream: `{ rootDir: fixture.rootDir }`). */
export function fixtureLedger(fixture: Fixture): PageLedgerStore {
  return new PageLedgerStore({ storage: fixture.ledgerStorage });
}

export function taskForRound(
  fixture: Fixture,
  _roundId: string,
  overrides: PageModelOverrides = {},
): TaskSpaceHandle {
  return createTaskSpaceHandle(
    { id: 7, name: 'research', ownership: 'agent' },
    {
      ledger: fixtureLedger(fixture),
      ...fixture.services,
      ...overrides,
    },
  );
}

export async function openTestPage(
  task: TaskSpaceHandle,
  url: string,
  gotoOptions: Parameters<PageHandle['goto']>[1] = {},
): Promise<PageHandle> {
  const page = await task.newPage();
  await page.goto(url, gotoOptions);
  return page;
}

export async function waitForLedgerTarget(
  ledger: PageLedgerStore,
  spaceId: number,
  targetId: string,
): Promise<{ label: string; targetId: string; openedBy: string }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const entry = Object.entries((await ledger.read(spaceId)).pages).find(
      ([, page]) => page.targetId === targetId,
    );
    if (entry) return { label: entry[0], ...entry[1] };
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ledger target ${targetId}`);
}

/** The `cdp` entries of `fixture.calls`, typed. */
export function cdpCalls(fixture: Fixture): RecordedCdpCall[] {
  return fixture.calls.flatMap((call) => {
    const [name, method, params, sessionId, timeoutMs] = call;
    if (name !== 'cdp' || typeof method !== 'string') return [];
    return [
      {
        method,
        params: isRecord(params) ? params : {},
        sessionId: typeof sessionId === 'string' ? sessionId : undefined,
        timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined,
      },
    ];
  });
}

/** What the round printed so far; resets the sink like upstream's helper. */
export function capturedRoundOutput(): string {
  let output = '';
  flushSink(
    {
      write(chunk: string) {
        output += chunk;
      },
    },
    false,
  );
  resetSink();
  return output;
}

/** The handle of an unmanaged inventory entry (upstream passes `item.page` to `task.adopt`). */
export function unmanagedPage(item: TabInventoryItem | undefined): UnmanagedPageHandle {
  expect(item).toBeDefined();
  expect(item?.label).toBeUndefined();
  return item?.page as UnmanagedPageHandle;
}

/** A value a plain-JavaScript script could pass where the static types forbid it. */
export function untyped(value: unknown): never {
  return value as never;
}

/** The Error a promise rejects with (upstream: `assert.rejects(promise, (error) => { ... })`). */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(Error);
  return outcome instanceof Error ? outcome : new Error(String(outcome));
}
