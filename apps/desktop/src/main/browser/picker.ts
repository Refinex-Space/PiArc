// The element picker of the preview (design addendum B3.1): CDP Overlay's inspect mode
// highlights what the pointer is over, and only a click that went through the page's input
// pipeline selects (`Overlay.inspectNodeRequested`); page scripts cannot produce one, and the
// picker does not start on a page an agent's call is driving. Each pick becomes an element
// context (element-context.ts) with the element's screenshot, sent to the panel that shows the
// page. Esc, "Done", a new document, closing the tab or the agent starting on the page ends it.

import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import type { WebContents } from 'electron';

import type {
  BrowserCaptureKind,
  BrowserImage,
  BrowserPick,
  BrowserPickMode,
} from '../../shared/browser.js';
import { originOf } from '../security/origin.js';
import { captureClip, captureFullPage, captureVisible, layoutMetrics } from './capture.js';
import {
  buildContext,
  elementClip,
  ELEMENT_FACTS,
  FACT_LIMITS,
  FRAMEWORK_FACTS,
  locateSource,
  parseFacts,
  parseFramework,
  type SourceIo,
} from './element-context.js';
import type { CdpSend } from './snapshot.js';

/** What the picker needs from the browser service. */
export interface PickHost {
  /** The tab's page and address, when it has one. */
  page(sessionId: string, tab: string): { contents: WebContents; url: string } | undefined;
  /** The session's workspace: source files must be inside it. */
  workspace(sessionId: string): string | undefined;
  /** An agent's call drives the tab's Space now (B2.5.1). */
  driven(sessionId: string, tab: string): boolean;
  /** A pick for the panel showing the session's page. */
  deliver(sessionId: string, mode: BrowserPickMode, pick: BrowserPick): void;
  /** Picking started or stopped. */
  changed(sessionId: string): void;
}

interface Active {
  readonly tab: string;
  readonly mode: BrowserPickMode;
  readonly contents: WebContents;
  readonly listener: (event: unknown, method: string, params: unknown, session: string) => void;
  readonly navigated: () => void;
}

/** The inspect overlay's colors (Chromium DevTools' defaults). */
const HIGHLIGHT = {
  showInfo: true,
  showAccessibilityInfo: true,
  showStyles: false,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
} as const;

const OBJECT_GROUP = 'piarc-picker';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sender(contents: WebContents): CdpSend {
  return (method, params, sessionId) =>
    contents.debugger.sendCommand(method, params ?? {}, sessionId) as Promise<unknown>;
}

/** The value a `Runtime.callFunctionOn` returned, `undefined` when it threw. */
function returned(answer: unknown): unknown {
  if (!isRecord(answer) || answer.exceptionDetails !== undefined) return undefined;
  return isRecord(answer.result) ? answer.result.value : undefined;
}

/** Reads source files and maps through the page's own partition, same origin only. */
function sourceIo(contents: WebContents, pageUrl: string): SourceIo {
  return {
    realpath: (file) => realpath(file),
    fetchText: async (url, max) => {
      if (originOf(url) === 'null' || originOf(url) !== originOf(pageUrl)) return undefined;
      try {
        const response = await contents.session.fetch(url, {
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
        const length = Number(response.headers.get('content-length') ?? '0');
        if (!response.ok || length > max) return undefined;
        const bytes = await response.arrayBuffer();
        return bytes.byteLength > max ? undefined : new TextDecoder().decode(bytes);
      } catch {
        return undefined;
      }
    },
  };
}

export class BrowserPicker {
  readonly #active = new Map<string, Active>();

  constructor(private readonly host: PickHost) {}

  /** Whether the session's picker is on, in which tab and for what. */
  picking(sessionId: string): { tab: string; mode: BrowserPickMode } | undefined {
    const active = this.#active.get(sessionId);
    return active === undefined ? undefined : { tab: active.tab, mode: active.mode };
  }

  /** Turns the picker on in `tab` (B3.1); refused while an agent's call drives the page. */
  async start(sessionId: string, tab: string, mode: BrowserPickMode): Promise<void> {
    if (this.host.driven(sessionId, tab)) {
      throw new Error('[piarc:browserAgentRunning] Take over the page before picking elements');
    }
    const page = this.host.page(sessionId, tab);
    if (page === undefined || page.url === '') {
      throw new Error('[piarc:browserNoPage] Open a page before picking elements');
    }
    this.stop(sessionId);
    const { contents } = page;
    if (!contents.debugger.isAttached()) {
      throw new Error('[piarc:browserNoPage] The page cannot be inspected');
    }
    const active: Active = {
      tab,
      mode,
      contents,
      listener: (_event, method, params, session) => {
        if (session !== '' || this.#active.get(sessionId) !== active) return;
        if (method === 'Overlay.inspectModeCanceled') {
          this.stop(sessionId);
        } else if (
          method === 'Overlay.inspectNodeRequested' &&
          isRecord(params) &&
          typeof params.backendNodeId === 'number'
        ) {
          void this.#picked(sessionId, active, params.backendNodeId);
        }
      },
      navigated: () => {
        if (this.#active.get(sessionId) === active) this.stop(sessionId);
      },
    };
    this.#active.set(sessionId, active);
    contents.debugger.on('message', active.listener);
    contents.once('did-navigate', active.navigated);
    contents.once('destroyed', active.navigated);
    try {
      await this.#arm(contents);
    } catch (error) {
      this.stop(sessionId);
      throw error;
    }
    this.host.changed(sessionId);
  }

  /** Turns the session's picker off. */
  stop(sessionId: string): void {
    const active = this.#active.get(sessionId);
    if (active === undefined) return;
    this.#active.delete(sessionId);
    const { contents } = active;
    if (!contents.isDestroyed()) {
      contents.debugger.removeListener('message', active.listener);
      contents.removeListener('did-navigate', active.navigated);
      contents.removeListener('destroyed', active.navigated);
      if (contents.debugger.isAttached()) {
        sender(contents)('Overlay.setInspectMode', { mode: 'none', highlightConfig: HIGHLIGHT })
          .then(() => sender(contents)('Overlay.hideHighlight'))
          .catch(() => undefined);
      }
    }
    this.host.changed(sessionId);
  }

  /** Stops the picker when it is on in `tab` (the tab closed, or another one is shown). */
  stopTab(sessionId: string, tab: string): void {
    if (this.#active.get(sessionId)?.tab === tab) this.stop(sessionId);
  }

  /** The page menu's "Add to conversation" (B1.3.8): the element at `x`, `y` becomes a card. */
  async pickAt(sessionId: string, tab: string, x: number, y: number): Promise<void> {
    if (this.host.driven(sessionId, tab)) return;
    const page = this.host.page(sessionId, tab);
    if (page === undefined) return;
    const send = sender(page.contents);
    const answer = await send('DOM.getNodeForLocation', {
      x: Math.round(x),
      y: Math.round(y),
      includeUserAgentShadowDOM: false,
      ignorePointerEventsNone: true,
    });
    if (!isRecord(answer) || typeof answer.backendNodeId !== 'number') return;
    const pick = await this.#context(sessionId, tab, page.contents, page.url, answer.backendNodeId);
    if (pick !== undefined) this.host.deliver(sessionId, 'collect', pick);
  }

  /** A screenshot of the tab's page (B3.3, B3.4). */
  async capture(sessionId: string, tab: string, kind: BrowserCaptureKind): Promise<BrowserImage> {
    const contents = this.host.page(sessionId, tab)?.contents;
    if (contents?.debugger.isAttached() !== true) {
      throw new Error('[piarc:browserNoPage] Open a page before taking a screenshot');
    }
    const send = sender(contents);
    if (kind === 'visible') return captureVisible(send);
    const ratio = returned(
      await send('Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true }),
    );
    return captureFullPage(send, typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : 1);
  }

  async #arm(contents: WebContents): Promise<void> {
    const send = sender(contents);
    await send('DOM.enable');
    await send('Overlay.enable');
    await send('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: HIGHLIGHT });
  }

  async #picked(sessionId: string, active: Active, backendNodeId: number): Promise<void> {
    // A click an agent's input produced on a page it took over meanwhile does not count.
    if (this.host.driven(sessionId, active.tab)) return;
    if (active.mode === 'shot') this.stop(sessionId);
    const url = this.host.page(sessionId, active.tab)?.url ?? '';
    try {
      const pick = await this.#context(sessionId, active.tab, active.contents, url, backendNodeId);
      if (pick !== undefined) this.host.deliver(sessionId, active.mode, pick);
    } catch (error) {
      console.warn('[browser] reading the picked element failed', error);
    }
    // Inspect mode may end with the click: arm it again for the next one.
    if (this.#active.get(sessionId) === active) {
      await this.#arm(active.contents).catch(() => {
        this.stop(sessionId);
      });
    }
  }

  async #context(
    sessionId: string,
    tab: string,
    contents: WebContents,
    url: string,
    backendNodeId: number,
  ): Promise<BrowserPick | undefined> {
    const send = sender(contents);
    try {
      const isolated = await this.#resolve(send, backendNodeId, true);
      const own = await this.#resolve(send, backendNodeId, false);
      if (own === undefined) return undefined;
      const call = (objectId: string, functionDeclaration: string, args: unknown[]) =>
        send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration,
          arguments: args.map((value) => ({ value })),
          returnByValue: true,
          awaitPromise: false,
          silent: true,
        }).then(returned);
      const facts = parseFacts(await call(isolated ?? own, ELEMENT_FACTS, [FACT_LIMITS]));
      if (facts === undefined) return undefined;
      const framework = parseFramework(await call(own, FRAMEWORK_FACTS, []).catch(() => undefined));
      const accessibility = await this.#accessibility(send, backendNodeId);
      const box = (await this.#box(send, backendNodeId)) ?? facts.box;
      const workspace = this.host.workspace(sessionId);
      const source =
        workspace === undefined
          ? undefined
          : await locateSource(framework, url, workspace, sourceIo(contents, url)).catch(
              () => undefined,
            );
      const metrics = await layoutMetrics(send).catch(() => undefined);
      const clip = elementClip(box, metrics?.scroll ?? { x: 0, y: 0 }, facts.dpr, metrics?.content);
      const image =
        clip === undefined ? undefined : await captureClip(send, clip).catch(() => undefined);
      return {
        id: randomUUID(),
        tab,
        context: buildContext(url, facts, framework, accessibility, box, source),
        ...(image === undefined ? {} : { image }),
      };
    } finally {
      await send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(
        () => undefined,
      );
    }
  }

  /** A remote object for the node: in a fresh isolated world of the top frame, or the page's. */
  async #resolve(
    send: CdpSend,
    backendNodeId: number,
    isolated: boolean,
  ): Promise<string | undefined> {
    try {
      let executionContextId: number | undefined;
      if (isolated) {
        const tree = await send('Page.getFrameTree');
        const frame = isRecord(tree) && isRecord(tree.frameTree) ? tree.frameTree.frame : undefined;
        const frameId = isRecord(frame) && typeof frame.id === 'string' ? frame.id : undefined;
        if (frameId === undefined) return undefined;
        const world = await send('Page.createIsolatedWorld', {
          frameId,
          worldName: OBJECT_GROUP,
          grantUniveralAccess: false,
        });
        if (!isRecord(world) || typeof world.executionContextId !== 'number') return undefined;
        executionContextId = world.executionContextId;
      }
      const answer = await send('DOM.resolveNode', {
        backendNodeId,
        objectGroup: OBJECT_GROUP,
        ...(executionContextId === undefined ? {} : { executionContextId }),
      });
      const object = isRecord(answer) && isRecord(answer.object) ? answer.object : undefined;
      return object !== undefined && typeof object.objectId === 'string'
        ? object.objectId
        : undefined;
    } catch {
      // The node is in another frame than the top one: the page's own world is used.
      return undefined;
    }
  }

  async #accessibility(
    send: CdpSend,
    backendNodeId: number,
  ): Promise<{ role: string; name: string }> {
    try {
      const answer = await send('Accessibility.getPartialAXTree', {
        backendNodeId,
        fetchRelatives: false,
      });
      const node =
        isRecord(answer) && Array.isArray(answer.nodes) ? (answer.nodes[0] as unknown) : undefined;
      const value = (field: unknown) =>
        isRecord(field) && typeof field.value === 'string' ? field.value : '';
      return isRecord(node)
        ? { role: value(node.role), name: value(node.name) }
        : { role: '', name: '' };
    } catch {
      return { role: '', name: '' };
    } finally {
      await send('Accessibility.disable').catch(() => undefined);
    }
  }

  /** The node's border box in the top viewport (`DOM.getBoxModel`), CSS pixels. */
  async #box(
    send: CdpSend,
    backendNodeId: number,
  ): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
    try {
      const answer = await send('DOM.getBoxModel', { backendNodeId });
      const model = isRecord(answer) && isRecord(answer.model) ? answer.model : undefined;
      const quad = model !== undefined && Array.isArray(model.border) ? model.border : [];
      const numbers = quad.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
      if (numbers.length !== 8) return undefined;
      const xs = numbers.filter((_, index) => index % 2 === 0);
      const ys = numbers.filter((_, index) => index % 2 === 1);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    } catch {
      return undefined;
    }
  }
}
