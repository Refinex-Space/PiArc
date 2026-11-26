// The built-in browser of the main process (ADR-0088; design addendum B1). It owns every
// session's Spaces and tabs, puts the active tab where the session's panel is, answers the
// panel's requests and sends each window the state it shows. Nothing here decides what the
// agent may do: Core does (ADR-0089).
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  clipboard,
  dialog,
  Menu,
  shell,
  type BrowserWindow,
  type ContextMenuParams,
  type DownloadItem,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
  WebContentsView,
} from 'electron';

import {
  BROWSER_LIMITS,
  type BrowserControl,
  type BrowserDownload,
  type BrowserFind,
  type BrowserPlacement,
  type BrowserPrompt,
  type BrowserRequest,
  type BrowserSessionState,
  type BrowserSpaceState,
} from '../../shared/browser.js';
import type { Translator } from '../../shared/i18n/index.js';
import type { BrowserObservation } from '../../shared/test-hooks.js';
import { APP_EVENT_CHANNEL, type AppEvent } from '../../shared/ipc.js';
import { local, parseAddress, searchUrl, type SearchEngine } from './address.js';
import { setUpGuestSession } from './guest-session.js';
import { previewKey } from './keymap.js';
import {
  BrowserPartitions,
  partitionKey,
  partitionName,
  SHIELD_PARTITION,
  type BrowserStorage,
} from './partitions.js';
import { BrowserTab } from './tab.js';
import { createDevtoolsView, fitDevice, splitForDevtools, toDips, ViewHost } from './view-host.js';
import type { GatedPage } from './agent-gate.js';
import { loopbackHost, portOf, type RequestVerdict } from './request-rules.js';
import { insideRoot, type WorkspaceFiles } from './workspace-files.js';
import type { Placement } from './view-host.js';

/** What the service needs from the rest of the main process. */
export interface BrowserDeps {
  /** Core's NAPI calls the browser uses. */
  readonly core: {
    browserProxy(requestJson: string): Promise<string>;
    stopBrowserProxy(partition: string): Promise<string>;
    sessionDeletionTarget(sessionId: string): Promise<string>;
  };
  /** The workbench windows that receive the browser's state. */
  windows(): BrowserWindow[];
  translator(): Translator;
  /** Opens `url` outside PiArc after the app's link confirmation. */
  openExternal(window: BrowserWindow | null, url: string): void;
  /** Where session tab lists are kept (`<userData>/browser`). */
  readonly dataDir: string;
  readonly platform: string;
  /** PiArc's own loopback ports (dev server, tests). */
  deniedPorts(): ReadonlySet<number>;
  createParking(): BrowserWindow;
  /** The user's choices (B5.5). */
  preferences(): BrowserPreferences;
  /** Workspace files in guests (B1.6). */
  readonly files: WorkspaceFiles;
  /** The tool window `owner` popped the preview out to (ticket `token`). */
  toolWindow(token: string, owner: WebContents): BrowserWindow | undefined;
  /** The user's home directory, for `~/` addresses. */
  readonly home: string;
}

export interface BrowserPreferences {
  readonly storage: BrowserStorage;
  readonly searchEngine: SearchEngine;
  readonly localHostnames: readonly string[];
}

/** A Space of a session; agent-spaces.ts changes agent Spaces through `AgentModel`. */
export interface Space {
  id: string;
  name: string;
  kind: 'user' | 'agent';
  ownership: BrowserSpaceState['ownership'];
  running: boolean;
  action?: string;
  /** What the agent asked the user to do when it handed the Space over (B2.5.3). */
  handOff?: string;
}

interface Prompt {
  readonly state: BrowserPrompt;
  answer(accept: boolean, text?: string, user?: string, password?: string): void;
}

interface Download {
  readonly item: DownloadItem;
  readonly session: string;
  state: BrowserDownload;
}

interface SessionModel {
  readonly id: string;
  readonly workspace: string;
  readonly storage: BrowserStorage;
  readonly key: string;
  readonly partition: string;
  readonly spaces: Space[];
  readonly tabs: BrowserTab[];
  active: string | undefined;
  readonly closed: { url: string; title: string }[];
  readonly prompts: Map<string, Prompt>;
  find: BrowserFind | undefined;
  placement: Placement | undefined;
  /** Permissions the user allowed, per tab: `origin permission`. */
  readonly grants: Map<string, Set<string>>;
  /** Certificate errors the user went past: `host fingerprint`, until quit. */
  readonly certificates: Set<string>;
  readonly devtools: Map<string, Electron.WebContentsView>;
  revision: number;
  emitTimer: NodeJS.Timeout | undefined;
  saveTimer: NodeJS.Timeout | undefined;
  /** Tab events for the agent side (the CDP proxy's target events). */
  readonly watchers: Set<(event: TabEvent) => void>;
  /** Loopback ports the user opened in their own tabs: the agent may use them (B2.6.2). */
  readonly userPorts: Set<number>;
  /** The empty view over a page while the agent drives it (B2.5.1), made on first use. */
  shield: Electron.WebContentsView | undefined;
}

/** A tab came, changed (address, title, loading) or went. */
export interface TabEvent {
  readonly kind: 'created' | 'changed' | 'destroyed';
  readonly tab: BrowserTab;
}

/** What the agent side (agent-spaces.ts, ADR-0089) uses of one session. */
export interface AgentModel {
  readonly sessionId: string;
  readonly workspace: string;
  readonly partition: string;
  /** Live: the agent side adds and changes agent Spaces in place, then calls `changed`. */
  readonly spaces: Space[];
  readonly tabs: readonly BrowserTab[];
  active(): string | undefined;
  /** Opens a tab in `space`; the panel moves to it only when it shows no user tab. */
  newTab(space: string, url: string): BrowserTab;
  closeTab(id: string): void;
  /** Shows the tab in the panel unless the panel shows a user tab. */
  select(id: string): void;
  /** The tab's page, created (and parked when hidden) if needed. */
  contents(tab: BrowserTab): WebContents;
  changed(): void;
  watch(listener: (event: TabEvent) => void): () => void;
}

const USER_SPACE = 'user';
const EMIT_DELAY_MS = 16;
const SAVE_DELAY_MS = 1000;
/** Hidden local pages of agent Spaces are discarded after this long (B1.5.3). */
export const DISCARD_AFTER_MS = 10 * 60 * 1000;

export class BrowserService {
  readonly partitions = new BrowserPartitions();
  readonly #sessions = new Map<string, Promise<SessionModel>>();
  readonly #loaded = new Map<string, SessionModel>();
  readonly #downloads = new Map<string, Download>();
  readonly #views: ViewHost;
  #nextTab = 1;
  #quitting = false;
  /** The user's controls of agent Spaces (B2.5), installed once the agent side starts. */
  #control:
    ((sessionId: string, space: string, action: BrowserControl) => Promise<void>) | undefined;
  /** The agent's request gate (agent-gate.ts), installed once the agent side starts. */
  #gate:
    | ((
        details: Electron.OnBeforeRequestListenerDetails,
      ) => RequestVerdict | Promise<RequestVerdict>)
    | undefined;

  constructor(private readonly deps: BrowserDeps) {
    this.#views = new ViewHost(() => deps.createParking());
  }

  /** The session's state for the window of `viewer`, loading the session on first use. */
  async state(sessionId: string, viewer: WebContents): Promise<BrowserSessionState> {
    const model = await this.#model(sessionId);
    return this.#snapshot(model, viewer);
  }

  /** Runs a panel's request. */
  async request(sessionId: string, request: BrowserRequest, sender: WebContents): Promise<unknown> {
    const model = await this.#model(sessionId);
    const result = this.#run(model, request, sender);
    this.#changed(model);
    return result instanceof Promise ? await result : result;
  }

  /** Where the session's panel wants its page (B1.5). */
  async place(sessionId: string, placement: BrowserPlacement, sender: WebContents): Promise<void> {
    const model = await this.#model(sessionId);
    const current = model.placement;
    if (placement === null) {
      if (current?.owner === sender) model.placement = undefined;
      this.#layout(model);
      this.#changed(model);
      return;
    }
    // A popped-out panel measures in its tool window; the page goes there (B1.5.3).
    const window =
      placement.toolWindow === undefined
        ? windowOf(sender, this.deps.windows())
        : this.deps.toolWindow(placement.toolWindow, sender);
    if (window === undefined) return;
    if (current !== undefined && current.owner !== sender && !current.owner.isDestroyed()) {
      if (placement.claim !== true) {
        this.#changed(model);
        return;
      }
    }
    const wasOccluded = current?.owner === sender && current.occluded;
    model.placement = {
      window,
      owner: sender,
      bounds: toDips(placement.bounds, window.webContents.getZoomFactor()),
      occluded: placement.occluded,
    };
    if (placement.occluded && !wasOccluded) await this.#sendStill(model, sender);
    this.#layout(model);
    if (current?.owner !== sender) this.#changed(model);
  }

  /** A workbench page went away: its panels no longer show anything. */
  released(owner: WebContents): void {
    for (const model of this.#loaded.values()) {
      if (model.placement?.owner === owner) {
        model.placement = undefined;
        this.#layout(model);
        this.#changed(model);
      }
    }
  }

  /** Installs what the panel's take over, hand back and stop do (B2.5). */
  setControl(
    control: (sessionId: string, space: string, action: BrowserControl) => Promise<void>,
  ): void {
    this.#control = control;
  }

  /** Installs the agent's request gate for every guest partition (B2.6.1). */
  setGate(
    gate: (
      details: Electron.OnBeforeRequestListenerDetails,
    ) => RequestVerdict | Promise<RequestVerdict>,
  ): void {
    this.#gate = gate;
  }

  /** The Space of the tab whose page is `webContentsId`, for the gate. */
  gatedPage(webContentsId: number): GatedPage | undefined {
    for (const model of this.#loaded.values()) {
      const tab = model.tabs.find(
        (t) =>
          t.view !== undefined &&
          !t.view.webContents.isDestroyed() &&
          t.view.webContents.id === webContentsId,
      );
      if (tab === undefined) continue;
      const space = model.spaces.find((s) => s.id === tab.space);
      return {
        sessionId: model.id,
        space: tab.space,
        agentControlled: space?.kind === 'agent' && space.ownership === 'agent',
      };
    }
    return undefined;
  }

  /** Agent pages showing `host` (requests no page can be named for, such as a worker's). */
  agentPagesOn(host: string): GatedPage[] {
    const pages: GatedPage[] = [];
    for (const model of this.#loaded.values()) {
      for (const tab of model.tabs) {
        const space = model.spaces.find((s) => s.id === tab.space);
        if (space?.kind !== 'agent' || hostOf(tab.url) !== host) continue;
        pages.push({
          sessionId: model.id,
          space: tab.space,
          agentControlled: space.ownership === 'agent',
        });
      }
    }
    return pages;
  }

  /** Loopback ports the user opened in the session's own tabs (B2.6.2). */
  userPorts(sessionId: string): ReadonlySet<number> {
    return this.#loaded.get(sessionId)?.userPorts ?? new Set();
  }

  /** One session as the agent side sees it, loading it on first use. */
  async agentModel(sessionId: string, workspace?: string): Promise<AgentModel> {
    const model = await this.#model(sessionId, workspace);
    const userTabShown = () => model.tabs.find((t) => t.id === model.active)?.space === USER_SPACE;
    return {
      sessionId: model.id,
      workspace: model.workspace,
      partition: model.partition,
      spaces: model.spaces,
      tabs: model.tabs,
      active: () => model.active,
      newTab: (space, url) => {
        const tab = this.#newTab(model, url, userTabShown(), 'agent', space);
        this.#changed(model);
        return tab;
      },
      closeTab: (id) => {
        this.#closeTab(model, id);
        this.#changed(model);
      },
      select: (id) => {
        if (userTabShown() || model.active === id) return;
        this.#select(model, id);
        this.#changed(model);
      },
      contents: (tab) => {
        const contents = tab.contents(model.partition);
        this.#layout(model);
        return contents;
      },
      changed: () => {
        // The agent's work starting or ending shows or lifts the shield.
        this.#layout(model);
        this.#changed(model);
      },
      watch: (listener) => {
        model.watchers.add(listener);
        return () => model.watchers.delete(listener);
      },
    };
  }

  /** What L4 checks (development builds' test hooks). */
  async observe(sessionId: string): Promise<BrowserObservation> {
    const model = await this.#model(sessionId);
    const placement = model.placement;
    const shield = model.shield;
    return {
      partition: model.partition,
      shielded:
        shield !== undefined &&
        placement !== undefined &&
        this.#views.parentOf(shield) === placement.window,
      active: model.active ?? null,
      placement:
        placement === undefined
          ? null
          : { bounds: { ...placement.bounds }, occluded: placement.occluded },
      tabs: model.tabs.map((tab) => {
        const view = tab.view;
        const parent = view === undefined ? undefined : this.#views.parentOf(view);
        return {
          id: tab.id,
          space: tab.space,
          url: tab.url,
          pageUrl: view === undefined ? '' : view.webContents.getURL(),
          title: tab.title,
          openedBy: tab.openedBy,
          host:
            parent === undefined
              ? 'none'
              : parent === placement?.window
                ? 'panel'
                : parent === this.#views.parking()
                  ? 'parking'
                  : 'none',
          visible: view?.getVisible() ?? false,
          bounds: view === undefined ? null : { ...view.getBounds() },
          zoom: tab.zoom,
          devtools: tab.devtools,
          emulated: tab.emulation !== null,
        };
      }),
    };
  }

  /** Whether `contents` is a browser guest or the script host (ADR-0088 rule 2). */
  isBrowserContents(contents: WebContents): boolean {
    return this.partitions.kind(contents.session) !== undefined;
  }

  /** Discards hidden local pages of agent Spaces that nobody looked at for a while. */
  discardIdle(now = Date.now()): void {
    for (const model of this.#loaded.values()) {
      for (const tab of model.tabs) {
        const space = model.spaces.find((s) => s.id === tab.space);
        if (
          tab.view !== undefined &&
          tab.id !== model.active &&
          space?.kind === 'agent' &&
          !space.running &&
          now - tab.lastShown > DISCARD_AFTER_MS &&
          local(hostOf(tab.url))
        ) {
          this.#views.detach(tab.view);
          tab.discard();
        }
      }
    }
  }

  /**
   * The app is quitting: from now on nothing is laid out or parked, so closing the
   * workbench windows never creates the parking window (a window created during quit stops
   * the quit).
   */
  quitting(): void {
    this.#quitting = true;
  }

  /** Closes every page (app quit). */
  dispose(): void {
    for (const model of this.#loaded.values()) {
      for (const tab of model.tabs) tab.destroy();
      for (const view of model.devtools.values()) closeView(view);
      if (model.shield !== undefined) closeView(model.shield);
    }
    this.#views.dispose();
  }

  async #model(sessionId: string, workspace?: string): Promise<SessionModel> {
    let pending = this.#sessions.get(sessionId);
    if (pending === undefined) {
      pending = this.#load(sessionId, workspace);
      this.#sessions.set(sessionId, pending);
      pending.catch(() => this.#sessions.delete(sessionId));
    }
    return pending;
  }

  /** Loads a session; `known` is its workspace when the caller has it (an agent's run). */
  async #load(sessionId: string, known?: string): Promise<SessionModel> {
    const workspace = known ?? (await this.#workspaceOf(sessionId));
    const { storage, localHostnames } = this.deps.preferences();
    const key = partitionKey(workspace, storage);
    const partition = partitionName(key, storage);
    await this.#ensurePartition(key, storage, localHostnames);
    const model: SessionModel = {
      id: sessionId,
      workspace,
      storage,
      key,
      partition,
      spaces: [
        {
          id: USER_SPACE,
          name: '',
          kind: 'user',
          ownership: 'user',
          running: false,
        },
      ],
      tabs: [],
      active: undefined,
      closed: [],
      prompts: new Map(),
      find: undefined,
      placement: undefined,
      grants: new Map(),
      certificates: new Set(),
      devtools: new Map(),
      revision: 0,
      emitTimer: undefined,
      saveTimer: undefined,
      watchers: new Set(),
      userPorts: new Set(),
      shield: undefined,
    };
    await this.#restore(model);
    this.#loaded.set(sessionId, model);
    return model;
  }

  /** The session's workspace from Core's index. */
  async #workspaceOf(sessionId: string): Promise<string> {
    const target: unknown = JSON.parse(await this.deps.core.sessionDeletionTarget(sessionId));
    if (
      typeof target !== 'object' ||
      target === null ||
      !('workspace' in target) ||
      typeof target.workspace !== 'string'
    ) {
      throw new Error('The session has no workspace');
    }
    return target.workspace;
  }

  async #ensurePartition(
    key: string,
    storage: BrowserStorage,
    localNames: readonly string[],
  ): Promise<void> {
    let setUp: Promise<void> | undefined;
    this.partitions.guest(key, storage, (created) => {
      setUp = this.#setUpPartition(created, key, localNames);
    });
    if (setUp !== undefined) await setUp;
  }

  async #setUpPartition(session: Session, key: string, localNames: readonly string[]) {
    const answer: unknown = JSON.parse(
      await this.deps.core.browserProxy(
        JSON.stringify({
          partition: key,
          localNames,
          deniedPorts: [...this.deps.deniedPorts()],
        }),
      ),
    );
    const port =
      typeof answer === 'object' && answer !== null && 'port' in answer ? answer.port : undefined;
    if (typeof port !== 'number') throw new Error('Core did not start the browser proxy');
    this.deps.files.register(session);
    await setUpGuestSession(session, port, {
      gate: (details) => this.#gate?.(details) ?? { allow: true },
      permission: (contents, origin, permission) =>
        this.#askPermission(contents, origin, permission),
      granted: (contents, origin, permission) => this.#granted(contents, origin, permission),
      download: (contents, item) => {
        this.#download(contents, item);
      },
      deniedPorts: () => this.deps.deniedPorts(),
    });
  }

  #run(model: SessionModel, request: BrowserRequest, sender: WebContents): unknown {
    switch (request.op) {
      case 'state':
        return this.#snapshot(model, sender);
      case 'navigate':
        return this.#navigate(model, request.tab, request.input);
      case 'newTab':
        return this.#newTab(
          model,
          request.url ?? '',
          request.background === true,
          'user',
          USER_SPACE,
        ).id;
      case 'closeTab':
        this.#closeTab(model, request.tab);
        return null;
      case 'closeOthers':
        for (const tab of [...model.tabs]) {
          if (tab.id !== request.tab && tab.space === this.#tab(model, request.tab).space) {
            this.#closeTab(model, tab.id);
          }
        }
        return null;
      case 'selectTab':
        this.#select(model, this.#tab(model, request.tab).id);
        return null;
      case 'moveTab':
        this.#move(model, request.tab, request.index);
        return null;
      case 'reopenClosed': {
        const last = model.closed.pop();
        if (last === undefined) return null;
        return this.#newTab(model, last.url, false, 'user', USER_SPACE).id;
      }
      case 'history': {
        const contents = this.#tab(model, request.tab).view?.webContents;
        if (request.direction === 'back') contents?.navigationHistory.goBack();
        else contents?.navigationHistory.goForward();
        return null;
      }
      case 'reload': {
        const tab = this.#tab(model, request.tab);
        if (tab.view === undefined || tab.crashed) {
          tab.destroy();
          this.#layout(model);
          return null;
        }
        if (request.hard === true) tab.view.webContents.reloadIgnoringCache();
        else tab.view.webContents.reload();
        return null;
      }
      case 'stop':
        this.#tab(model, request.tab).view?.webContents.stop();
        return null;
      case 'zoom':
        this.#tab(model, request.tab).stepZoom(request.step);
        return null;
      case 'find':
        return this.#find(model, request);
      case 'stopFind':
        this.#tab(model, request.tab).view?.webContents.stopFindInPage('clearSelection');
        model.find = undefined;
        return null;
      case 'devtools':
        this.#devtools(model, request.tab, request.mode);
        return null;
      case 'emulate':
        return this.#emulate(model, request.tab, request.emulation);
      case 'media':
        return this.#media(model, request.tab, request.media);
      case 'answer':
        this.#answer(model, request);
        return null;
      case 'control':
        return this.#control?.(model.id, request.space, request.action) ?? null;
      case 'openExternal': {
        const tab = this.#tab(model, request.tab);
        this.deps.openExternal(windowOf(sender, this.deps.windows()) ?? null, tab.url);
        return null;
      }
      case 'contextMenu':
        this.#tabMenu(model, request.tab, sender);
        return null;
      case 'focus':
        this.#tab(model, request.tab).view?.webContents.focus();
        return null;
      case 'download':
        this.#downloadAction(request.download, request.action);
        return null;
      case 'clearData':
        return this.#clearData(model);
    }
  }

  #tab(model: SessionModel, id: string): BrowserTab {
    const tab = model.tabs.find((t) => t.id === id);
    if (tab === undefined) throw new Error('No such tab');
    return tab;
  }

  #newTab(
    model: SessionModel,
    url: string,
    background: boolean,
    openedBy: 'user' | 'agent',
    space: string,
  ): BrowserTab {
    if (model.tabs.length >= BROWSER_LIMITS.tabs) {
      throw new Error(`[piarc:browserTabLimit] At most ${String(BROWSER_LIMITS.tabs)} tabs`);
    }
    const tab = new BrowserTab(
      { id: `tab-${String(this.#nextTab++)}`, sessionId: model.id, space, openedBy, url },
      this.#hooks(model),
    );
    const at = model.tabs.findIndex((t) => t.id === model.active);
    model.tabs.splice(at === -1 ? model.tabs.length : at + 1, 0, tab);
    if (!background || model.active === undefined) this.#select(model, tab.id);
    else this.#layout(model);
    tabEvent(model, { kind: 'created', tab });
    return tab;
  }

  #select(model: SessionModel, id: string): void {
    model.active = id;
    if (model.find !== undefined && model.find.tab !== id) model.find = undefined;
    this.#layout(model);
  }

  #move(model: SessionModel, id: string, index: number): void {
    const from = model.tabs.findIndex((t) => t.id === id);
    if (from === -1) throw new Error('No such tab');
    const [tab] = model.tabs.splice(from, 1);
    if (tab === undefined) return;
    model.tabs.splice(Math.max(0, Math.min(index, model.tabs.length)), 0, tab);
  }

  #closeTab(model: SessionModel, id: string): void {
    const index = model.tabs.findIndex((t) => t.id === id);
    const tab = model.tabs[index];
    if (tab === undefined) return;
    if (tab.url !== '' && tab.url !== 'about:blank') {
      model.closed.push({ url: tab.url, title: tab.title });
      if (model.closed.length > BROWSER_LIMITS.closed) model.closed.shift();
    }
    this.#closeDevtools(model, tab);
    for (const [key, prompt] of model.prompts) {
      if (prompt.state.tab === id) {
        prompt.answer(false);
        model.prompts.delete(key);
      }
    }
    model.grants.delete(id);
    if (tab.view !== undefined) this.#views.detach(tab.view);
    tab.destroy();
    model.tabs.splice(index, 1);
    tabEvent(model, { kind: 'destroyed', tab });
    if (model.active === id) {
      model.active = (model.tabs[index] ?? model.tabs[index - 1])?.id;
    }
    this.#layout(model);
  }

  #navigate(model: SessionModel, tabId: string | undefined, input: string): string | null {
    const parsed = parseAddress(input);
    let url: string;
    switch (parsed.kind) {
      case 'url':
        url = parsed.url;
        break;
      case 'search':
        url = searchUrl(this.deps.preferences().searchEngine, parsed.query);
        break;
      case 'file': {
        const relative = insideRoot(parsed.path, model.workspace, this.deps.home);
        if (relative === undefined) {
          throw new Error('[piarc:browserFile] Only files inside the workspace open here');
        }
        url = this.deps.files.url(model.id, relative);
        break;
      }
      case 'refused':
        throw new Error(`[piarc:browserAddress] ${parsed.reason}`);
    }
    const tab =
      tabId === undefined
        ? (model.tabs.find((t) => t.id === model.active) ??
          this.#newTab(model, '', false, 'user', USER_SPACE))
        : this.#tab(model, tabId);
    tab.load(url);
    if (tab.view === undefined) {
      if (model.active !== tab.id) this.#select(model, tab.id);
      else this.#layout(model);
    }
    return tab.id;
  }

  #find(model: SessionModel, request: Extract<BrowserRequest, { op: 'find' }>): number | null {
    const contents = this.#tab(model, request.tab).view?.webContents;
    if (contents === undefined || request.text === '') {
      contents?.stopFindInPage('clearSelection');
      model.find = undefined;
      return null;
    }
    model.find = { tab: request.tab, text: request.text, active: 0, matches: 0 };
    return contents.findInPage(request.text, { forward: request.forward, findNext: request.next });
  }

  #devtools(model: SessionModel, tabId: string, mode: 'closed' | 'docked' | 'window'): void {
    const tab = this.#tab(model, tabId);
    const contents = tab.contents(model.partition);
    this.#closeDevtools(model, tab);
    if (mode === 'window') {
      contents.openDevTools({ mode: 'detach', activate: true });
    } else if (mode === 'docked') {
      const view = createDevtoolsView();
      contents.setDevToolsWebContents(view.webContents);
      contents.openDevTools();
      model.devtools.set(tab.id, view);
    }
    tab.devtools = mode;
    this.#layout(model);
  }

  #closeDevtools(model: SessionModel, tab: BrowserTab): void {
    const contents = tab.view?.webContents;
    if (contents !== undefined && !contents.isDestroyed() && contents.isDevToolsOpened()) {
      contents.closeDevTools();
    }
    const view = model.devtools.get(tab.id);
    if (view !== undefined) {
      this.#views.detach(view);
      closeView(view);
      model.devtools.delete(tab.id);
    }
    tab.devtools = 'closed';
  }

  async #emulate(
    model: SessionModel,
    tabId: string,
    emulation: Extract<BrowserRequest, { op: 'emulate' }>['emulation'],
  ): Promise<null> {
    const tab = this.#tab(model, tabId);
    tab.emulation = emulation === null ? null : { ...emulation, by: 'user' };
    const contents = tab.contents(model.partition);
    const touch = emulation?.touch === true;
    await cdp(contents, 'Emulation.setTouchEmulationEnabled', { enabled: touch });
    await cdp(contents, 'Emulation.setEmitTouchEventsForMouse', { enabled: touch });
    this.#layout(model);
    return null;
  }

  async #media(
    model: SessionModel,
    tabId: string,
    media: Extract<BrowserRequest, { op: 'media' }>['media'],
  ): Promise<null> {
    const tab = this.#tab(model, tabId);
    tab.media = media;
    const features = [
      {
        name: 'prefers-color-scheme',
        value: media.colorScheme === 'system' ? '' : media.colorScheme,
      },
      { name: 'prefers-reduced-motion', value: media.reducedMotion ? 'reduce' : '' },
    ];
    await cdp(tab.contents(model.partition), 'Emulation.setEmulatedMedia', { features });
    return null;
  }

  #answer(model: SessionModel, request: Extract<BrowserRequest, { op: 'answer' }>): void {
    const prompt = model.prompts.get(request.prompt);
    if (prompt === undefined) return;
    model.prompts.delete(request.prompt);
    prompt.answer(request.accept, request.text, request.user, request.password);
  }

  async #clearData(model: SessionModel): Promise<null> {
    const session = model.tabs[0]?.view?.webContents.session;
    const target = session ?? this.partitions.guest(model.key, model.storage, () => undefined);
    await target.clearStorageData();
    await target.clearCache();
    await target.clearAuthCache();
    for (const tab of model.tabs) tab.view?.webContents.reload();
    return null;
  }

  /** Puts every tab's view where it belongs. */
  #layout(model: SessionModel): void {
    if (this.#quitting) return;
    const active = model.tabs.find((t) => t.id === model.active);
    for (const tab of model.tabs) {
      if (tab !== active && tab.view !== undefined) this.#views.park(tab.view);
    }
    for (const [tabId, view] of model.devtools) {
      if (tabId !== model.active) this.#views.detach(view);
    }
    if (active === undefined) return;
    const placement = model.placement;
    // A tab without an address has no page: the panel shows its start card instead.
    if (placement === undefined || placement.window.isDestroyed() || active.url === '') {
      if (model.shield !== undefined) this.#views.detach(model.shield);
      if (active.view !== undefined) this.#views.park(active.view);
      const devtools = model.devtools.get(active.id);
      if (devtools !== undefined) this.#views.detach(devtools);
      return;
    }
    const view = active.ensureView(model.partition);
    active.lastShown = Date.now();
    this.#views.attach(view, placement.window);
    const devtools = model.devtools.get(active.id);
    const area =
      devtools === undefined ? placement.bounds : splitForDevtools(placement.bounds).page;
    if (devtools !== undefined) {
      this.#views.attach(devtools, placement.window);
      devtools.setBounds(splitForDevtools(placement.bounds).devtools);
      devtools.setVisible(!placement.occluded);
    }
    if (active.emulation === null) {
      view.setBounds(area);
    } else {
      view.setBounds(fitDevice(area, active.emulation).rect);
    }
    active.applyEmulation(area);
    view.setVisible(!placement.occluded);
    this.#shieldOver(model, active, placement.window, view.getBounds(), !placement.occluded);
  }

  /**
   * While the agent's call drives the shown page, an empty view above it takes the user's
   * pointer (B2.5.1): the panel's control bar says to take over first. Keys stay with the
   * focused element, which is the panel's while the user works there.
   */
  #shieldOver(
    model: SessionModel,
    tab: BrowserTab,
    window: BrowserWindow,
    bounds: Electron.Rectangle,
    visible: boolean,
  ): void {
    const space = model.spaces.find((s) => s.id === tab.space);
    const driven = space?.kind === 'agent' && space.ownership === 'agent' && space.running;
    if (!driven) {
      if (model.shield !== undefined) this.#views.detach(model.shield);
      return;
    }
    model.shield ??= createShield(this.partitions);
    this.#views.raise(model.shield, window);
    model.shield.setBounds(bounds);
    model.shield.setVisible(visible);
  }

  async #sendStill(model: SessionModel, owner: WebContents): Promise<void> {
    const view = model.tabs.find((t) => t.id === model.active)?.view;
    if (view === undefined || view.webContents.isDestroyed()) return;
    try {
      const image = await view.webContents.capturePage();
      if (image.isEmpty()) return;
      const still = `data:image/jpeg;base64,${image.toJPEG(70).toString('base64')}`;
      send(owner, { type: 'browserStill', sessionId: model.id, image: still });
    } catch {
      // No frame (the window is not on screen): the panel shows its background.
    }
  }

  #hooks(model: SessionModel) {
    return {
      changed: (tab: BrowserTab) => {
        this.#changed(model);
        tabEvent(model, { kind: 'changed', tab });
        if (tab.space === USER_SPACE) rememberUserPort(model, tab.url);
      },
      openTab: (from: BrowserTab, url: string, background: boolean) => {
        try {
          this.#newTab(model, url, background, from.openedBy, from.space);
          this.#changed(model);
        } catch (error) {
          console.warn('[browser] popup refused', error);
        }
      },
      openExternal: (_from: BrowserTab, url: string) => {
        const window = model.placement?.window ?? null;
        this.deps.openExternal(window, url);
      },
      contextMenu: (tab: BrowserTab, params: ContextMenuParams) => {
        this.#pageMenu(model, tab, params);
      },
      key: (tab: BrowserTab, input: Electron.Input) => this.#key(model, tab, input),
      found: (tab: BrowserTab, active: number, matches: number) => {
        if (model.find?.tab !== tab.id) return;
        model.find = { ...model.find, active, matches };
        this.#changed(model);
      },
      certificate: (
        tab: BrowserTab,
        url: string,
        error: string,
        fingerprint: string,
        answer: (accept: boolean) => void,
      ) => {
        const host = hostOf(url);
        if (model.certificates.has(`${host} ${fingerprint}`)) {
          answer(true);
          return;
        }
        const bypassable = local(host);
        this.#prompt(
          model,
          { id: '', kind: 'certificate', tab: tab.id, host, error, fingerprint, bypassable },
          (accept) => {
            if (accept && bypassable) model.certificates.add(`${host} ${fingerprint}`);
            answer(accept && bypassable);
          },
        );
      },
      login: (
        tab: BrowserTab,
        host: string,
        realm: string,
        proxy: boolean,
        answer: (user?: string, password?: string) => void,
      ) => {
        this.#prompt(
          model,
          { id: '', kind: 'auth', tab: tab.id, host, realm, proxy },
          (accept, _text, user, password) => {
            if (accept) answer(user ?? '', password ?? '');
            else answer();
          },
        );
      },
      beforeUnload: (tab: BrowserTab) => this.#confirmLeave(model, tab),
      dialog: () => {
        // User tabs show Electron's dialog; the agent answers its own through CDP (B2).
      },
    };
  }

  #prompt(
    model: SessionModel,
    state: BrowserPrompt,
    answer: (accept: boolean, text?: string, user?: string, password?: string) => void,
  ): void {
    const id = randomUUID();
    model.prompts.set(id, { state: { ...state, id }, answer });
    this.#changed(model);
  }

  async #askPermission(contents: WebContents, origin: string, permission: string) {
    const found = this.#tabOf(contents);
    if (found === undefined) return false;
    const { model, tab } = found;
    const space = model.spaces.find((s) => s.id === tab.space);
    if (space?.ownership === 'agent' && space.running) return false;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        for (const [id, prompt] of model.prompts) {
          if (prompt.state.kind === 'permission' && prompt.state.tab === tab.id) {
            model.prompts.delete(id);
          }
        }
        this.#changed(model);
        resolve(false);
      }, 30_000);
      this.#prompt(
        model,
        { id: '', kind: 'permission', tab: tab.id, origin, permission },
        (accept) => {
          clearTimeout(timer);
          if (accept) {
            const grants = model.grants.get(tab.id) ?? new Set<string>();
            grants.add(`${origin} ${permission}`);
            model.grants.set(tab.id, grants);
          }
          resolve(accept);
        },
      );
    });
  }

  #granted(contents: WebContents | null, origin: string, permission: string): boolean {
    if (contents === null) return false;
    const found = this.#tabOf(contents);
    if (found === undefined) return false;
    return found.model.grants.get(found.tab.id)?.has(`${origin} ${permission}`) === true;
  }

  #tabOf(contents: WebContents): { model: SessionModel; tab: BrowserTab } | undefined {
    for (const model of this.#loaded.values()) {
      for (const tab of model.tabs) {
        if (tab.view?.webContents === contents) return { model, tab };
      }
    }
    return undefined;
  }

  #download(contents: WebContents | undefined, item: DownloadItem): void {
    const found = contents === undefined ? undefined : this.#tabOf(contents);
    if (found === undefined) {
      item.cancel();
      return;
    }
    const id = randomUUID();
    const download: Download = {
      item,
      session: found.model.id,
      state: {
        id,
        name: item.getFilename(),
        state: 'progressing',
        received: 0,
        total: item.getTotalBytes(),
      },
    };
    this.#downloads.set(id, download);
    const update = () => {
      download.state = {
        ...download.state,
        name: path.basename(item.getSavePath() || item.getFilename()),
        received: item.getReceivedBytes(),
        total: item.getTotalBytes(),
      };
      this.#changed(found.model);
    };
    item.on('updated', (_event, state) => {
      download.state = {
        ...download.state,
        state: state === 'interrupted' ? 'interrupted' : 'progressing',
      };
      update();
    });
    item.once('done', (_event, state) => {
      download.state = { ...download.state, state };
      update();
    });
    update();
  }

  #downloadAction(id: string, action: 'cancel' | 'show'): void {
    const download = this.#downloads.get(id);
    if (download === undefined) return;
    if (action === 'cancel') download.item.cancel();
    else if (download.state.state === 'completed')
      shell.showItemInFolder(download.item.getSavePath());
  }

  #confirmLeave(model: SessionModel, tab: BrowserTab): boolean {
    const t = this.deps.translator();
    const window = model.placement?.window;
    const options = {
      type: 'question' as const,
      buttons: [t.t('browser.leave.leave'), t.t('browser.leave.stay')],
      defaultId: 0,
      cancelId: 1,
      message: t.t('browser.leave.title'),
      detail: t.t('browser.leave.message', { host: hostOf(tab.url) }),
    };
    const choice =
      window === undefined || window.isDestroyed()
        ? dialog.showMessageBoxSync(options)
        : dialog.showMessageBoxSync(window, options);
    return choice === 0;
  }

  #key(model: SessionModel, tab: BrowserTab, input: Electron.Input): boolean {
    const key = previewKey(input, this.deps.platform);
    if (key === undefined) return false;
    const owner = model.placement?.owner;
    if (owner === undefined || owner.isDestroyed()) return false;
    if (key === 'leave') owner.focus();
    send(owner, { type: 'browserKey', sessionId: model.id, tab: tab.id, key });
    return true;
  }

  #pageMenu(model: SessionModel, tab: BrowserTab, params: ContextMenuParams): void {
    const t = this.deps.translator();
    const contents = tab.view?.webContents;
    if (contents === undefined) return;
    const items: MenuItemConstructorOptions[] = [];
    if (params.linkURL !== '') {
      const link = params.linkURL;
      items.push(
        {
          label: t.t('browser.menu.openLinkInTab'),
          click: () => {
            this.#hooks(model).openTab(tab, link, true);
          },
        },
        {
          label: t.t('browser.menu.copyLink'),
          click: () => {
            void clipboard.writeText(link);
          },
        },
        { type: 'separator' },
      );
    }
    if (params.mediaType === 'image' && params.srcURL !== '') {
      const src = params.srcURL;
      items.push(
        {
          label: t.t('browser.menu.copyImage'),
          click: () => {
            contents.copyImageAt(params.x, params.y);
          },
        },
        {
          label: t.t('browser.menu.saveImage'),
          click: () => {
            contents.downloadURL(src);
          },
        },
        { type: 'separator' },
      );
    }
    if (params.isEditable) {
      items.push(
        { label: t.t('browser.menu.cut'), role: 'cut', enabled: params.editFlags.canCut },
        { label: t.t('browser.menu.copy'), role: 'copy', enabled: params.editFlags.canCopy },
        { label: t.t('browser.menu.paste'), role: 'paste', enabled: params.editFlags.canPaste },
        { label: t.t('browser.menu.selectAll'), role: 'selectAll' },
        { type: 'separator' },
      );
    } else if (params.selectionText !== '') {
      items.push({ label: t.t('browser.menu.copy'), role: 'copy' }, { type: 'separator' });
    }
    items.push(
      {
        label: t.t('browser.menu.back'),
        enabled: contents.navigationHistory.canGoBack(),
        click: () => {
          contents.navigationHistory.goBack();
        },
      },
      {
        label: t.t('browser.menu.forward'),
        enabled: contents.navigationHistory.canGoForward(),
        click: () => {
          contents.navigationHistory.goForward();
        },
      },
      {
        label: t.t('browser.menu.reload'),
        click: () => {
          contents.reload();
        },
      },
      { type: 'separator' },
      {
        label: t.t('browser.menu.inspect'),
        click: () => {
          if (tab.devtools === 'closed') this.#devtools(model, tab.id, 'docked');
          contents.inspectElement(params.x, params.y);
          this.#changed(model);
        },
      },
    );
    const window = model.placement?.window;
    Menu.buildFromTemplate(items).popup(window === undefined ? {} : { window });
  }

  #tabMenu(model: SessionModel, tabId: string, sender: WebContents): void {
    const t = this.deps.translator();
    const tab = this.#tab(model, tabId);
    const items: MenuItemConstructorOptions[] = [
      {
        label: t.t('browser.menu.reload'),
        click: () => {
          tab.view?.webContents.reload();
        },
      },
      {
        label: t.t('browser.menu.copyLink'),
        click: () => {
          void clipboard.writeText(tab.url);
        },
        enabled: tab.url !== '',
      },
      {
        label: t.t('browser.menu.openExternal'),
        enabled: /^https?:/.test(tab.url),
        click: () => {
          this.deps.openExternal(windowOf(sender, this.deps.windows()) ?? null, tab.url);
        },
      },
      { type: 'separator' },
      {
        label: t.t('browser.menu.closeOthers'),
        enabled: model.tabs.length > 1,
        click: () => {
          for (const other of [...model.tabs])
            if (other.id !== tab.id) this.#closeTab(model, other.id);
          this.#changed(model);
        },
      },
      {
        label: t.t('browser.menu.closeTab'),
        click: () => {
          this.#closeTab(model, tab.id);
          this.#changed(model);
        },
      },
    ];
    const window = windowOf(sender, this.deps.windows());
    Menu.buildFromTemplate(items).popup(window === undefined ? {} : { window });
  }

  #changed(model: SessionModel): void {
    model.emitTimer ??= setTimeout(() => {
      model.emitTimer = undefined;
      model.revision += 1;
      for (const window of this.deps.windows()) {
        if (window.isDestroyed()) continue;
        send(window.webContents, {
          type: 'browser',
          sessionId: model.id,
          state: this.#snapshot(model, window.webContents),
        });
      }
    }, EMIT_DELAY_MS);
    model.saveTimer ??= setTimeout(() => {
      model.saveTimer = undefined;
      void this.#save(model);
    }, SAVE_DELAY_MS);
  }

  #snapshot(model: SessionModel, viewer: WebContents): BrowserSessionState {
    const owner = model.placement?.owner;
    return {
      sessionId: model.id,
      revision: model.revision,
      spaces: model.spaces.map((space) => ({
        id: space.id,
        name: space.name,
        kind: space.kind,
        ownership: space.ownership,
        running: space.running,
        ...(space.action === undefined ? {} : { action: space.action }),
        ...(space.handOff === undefined ? {} : { handOff: space.handOff }),
      })),
      tabs: model.tabs.map((tab) => tab.state()),
      ...(model.active === undefined ? {} : { activeTab: model.active }),
      prompts: [...model.prompts.values()].map((prompt) => prompt.state),
      downloads: [...this.#downloads.values()]
        .filter((download) => download.session === model.id)
        .map((download) => download.state),
      ...(model.find === undefined ? {} : { find: model.find }),
      shownElsewhere: owner !== undefined && !owner.isDestroyed() && owner !== viewer,
    };
  }

  #file(model: SessionModel): string {
    return path.join(this.deps.dataDir, 'sessions', `${model.id}.json`);
  }

  async #save(model: SessionModel): Promise<void> {
    const file = this.#file(model);
    const saved = {
      version: 1,
      active: model.active,
      // Tabs of a Space the agent controls are its own; they are not reopened as the user's.
      tabs: model.tabs
        .filter((tab) => tab.url !== '' && tab.url !== 'about:blank')
        .filter((tab) => model.spaces.find((s) => s.id === tab.space)?.ownership === 'user')
        .map((tab) => ({
          space: tab.space,
          url: tab.url,
          title: tab.title,
          openedBy: tab.openedBy,
        })),
    };
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(saved));
      await rename(temporary, file);
    } catch (error) {
      console.warn('[browser] cannot save the session tabs', error);
    }
  }

  async #restore(model: SessionModel): Promise<void> {
    let saved: unknown;
    try {
      saved = JSON.parse(await readFile(this.#file(model), 'utf8'));
    } catch {
      return;
    }
    if (typeof saved !== 'object' || saved === null || !('tabs' in saved)) return;
    const tabs = Array.isArray(saved.tabs) ? (saved.tabs as unknown[]) : [];
    for (const entry of tabs.slice(0, BROWSER_LIMITS.tabs)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const url = 'url' in entry && typeof entry.url === 'string' ? entry.url : undefined;
      if (url === undefined || parseAddress(url).kind !== 'url') continue;
      const title = 'title' in entry && typeof entry.title === 'string' ? entry.title : '';
      const tab = new BrowserTab(
        {
          id: `tab-${String(this.#nextTab++)}`,
          sessionId: model.id,
          space: USER_SPACE,
          openedBy: 'user',
          url,
          title,
        },
        this.#hooks(model),
      );
      model.tabs.push(tab);
    }
    model.active = model.tabs.at(-1)?.id;
  }

  /** Forgets a deleted session's tab list. */
  async forget(sessionId: string): Promise<void> {
    const model = this.#loaded.get(sessionId);
    if (model !== undefined) {
      for (const tab of model.tabs) {
        if (tab.view !== undefined) this.#views.detach(tab.view);
        tab.destroy();
      }
      this.#loaded.delete(sessionId);
      this.#sessions.delete(sessionId);
    }
    await rm(path.join(this.deps.dataDir, 'sessions', `${sessionId}.json`), { force: true });
  }
}

/** Remembers the port of a loopback address the user opened (B2.6.2). */
function rememberUserPort(model: SessionModel, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
  if (!loopbackHost(parsed.hostname.replace(/^\[|\]$/g, ''))) return;
  model.userPorts.add(portOf(parsed));
}

function tabEvent(model: SessionModel, event: TabEvent): void {
  for (const listener of model.watchers) {
    try {
      listener(event);
    } catch (error) {
      console.warn('[browser] a tab listener failed', error);
    }
  }
}

function send(contents: WebContents, event: AppEvent): void {
  if (!contents.isDestroyed()) contents.send(APP_EVENT_CHANNEL, event);
}

function windowOf(sender: WebContents, windows: BrowserWindow[]): BrowserWindow | undefined {
  return windows.find((window) => !window.isDestroyed() && window.webContents === sender);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function createShield(partitions: BrowserPartitions): Electron.WebContentsView {
  partitions.shield();
  const shield = new WebContentsView({
    webPreferences: {
      partition: SHIELD_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      images: false,
      webgl: false,
      plugins: false,
      spellcheck: false,
    },
  });
  shield.setBackgroundColor('#00000000');
  return shield;
}

function closeView(view: Electron.WebContentsView): void {
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

async function cdp(contents: WebContents, method: string, params: object): Promise<void> {
  if (!contents.debugger.isAttached()) return;
  try {
    await contents.debugger.sendCommand(method, params);
  } catch (error) {
    console.warn(`[browser] ${method} failed`, error);
  }
}
