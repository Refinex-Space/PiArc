// One browser tab: its `WebContentsView` (created when first shown, dropped when discarded),
// what the page reports, and the guards of a guest (ADR-0088 rules 2-4). The service decides
// where the view is attached; the tab only reports changes.
import { WebContentsView, type ContextMenuParams, type Input, type WebContents } from 'electron';

import type {
  BrowserEmulation,
  BrowserMedia,
  BrowserTabState,
  SiteSecurity,
  TabOrigin,
} from '../../shared/browser.js';
import { originForLog } from '../security/navigation.js';
import { local } from './address.js';
import { navigable, WORKSPACE_SCHEME } from './request-rules.js';
import { fitDevice } from './view-host.js';

/** What a tab tells its owner. */
export interface TabHooks {
  changed(tab: BrowserTab): void;
  /** A popup or `target=_blank` link: a new tab in the same Space. */
  openTab(from: BrowserTab, url: string, background: boolean): void;
  /** `mailto:` links go through the app's link confirmation. */
  openExternal(from: BrowserTab, url: string): void;
  contextMenu(tab: BrowserTab, params: ContextMenuParams): void;
  /** A key pressed in the page; true when the panel took it. */
  key(tab: BrowserTab, input: Input): boolean;
  found(tab: BrowserTab, active: number, matches: number): void;
  certificate(
    tab: BrowserTab,
    url: string,
    error: string,
    fingerprint: string,
    answer: (accept: boolean) => void,
  ): void;
  login(
    tab: BrowserTab,
    host: string,
    realm: string,
    proxy: boolean,
    answer: (user?: string, password?: string) => void,
  ): void;
  beforeUnload(tab: BrowserTab): boolean;
  /** A JavaScript dialog opened (CDP `Page.javascriptDialogOpening`). */
  dialog(tab: BrowserTab, type: string, message: string): void;
}

export interface TabInit {
  readonly id: string;
  readonly sessionId: string;
  readonly space: string;
  readonly openedBy: TabOrigin;
  readonly url: string;
  readonly title?: string;
}

const ZOOM_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
const FAVICON_BYTES = 32 * 1024;

export class BrowserTab {
  readonly id: string;
  readonly sessionId: string;
  space: string;
  openedBy: TabOrigin;
  url: string;
  title: string;
  favicon: string | undefined;
  loading = false;
  canGoBack = false;
  canGoForward = false;
  zoom = 100;
  audible = false;
  emulation: BrowserEmulation | null = null;
  media: BrowserMedia = { colorScheme: 'system', reducedMotion: false };
  devtools: BrowserTabState['devtools'] = 'closed';
  failure: BrowserTabState['failure'];
  crashed = false;
  /** When the tab was last on screen (for discarding hidden tabs). */
  lastShown = Date.now();
  view: WebContentsView | undefined;
  /** The emulation last given to Chromium (`none`), or undefined for a fresh page. */
  #emulationApplied: string | undefined;

  constructor(
    init: TabInit,
    private readonly hooks: TabHooks,
  ) {
    this.id = init.id;
    this.sessionId = init.sessionId;
    this.space = init.space;
    this.openedBy = init.openedBy;
    this.url = init.url;
    this.title = init.title ?? '';
  }

  /** The tab's page; created (and the URL loaded) on first use. */
  contents(partition: string): WebContents {
    return this.ensureView(partition).webContents;
  }

  ensureView(partition: string): WebContentsView {
    if (this.view !== undefined && !this.view.webContents.isDestroyed()) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        // The built-in PDF viewer needs plugins; nothing else uses them (ADR-0088 rule 3).
        plugins: true,
        spellcheck: false,
        backgroundThrottling: true,
      },
    });
    view.setBackgroundColor('#00000000');
    this.view = view;
    this.crashed = false;
    this.#emulationApplied = undefined;
    this.wire(view.webContents);
    if (this.url !== '' && this.url !== 'about:blank') {
      this.load(this.url);
    }
    return view;
  }

  load(url: string): void {
    this.url = url;
    this.failure = undefined;
    const contents = this.view?.webContents;
    if (contents === undefined || contents.isDestroyed()) return;
    contents.loadURL(url).catch(() => {
      // Failures arrive as `did-fail-load`; an aborted load (-3) is a new navigation.
    });
  }

  /** Drops the page, keeping its URL and title: it reloads when shown again. */
  discard(): void {
    const view = this.view;
    this.view = undefined;
    if (view !== undefined) close(view);
    this.loading = false;
    this.hooks.changed(this);
  }

  destroy(): void {
    const view = this.view;
    this.view = undefined;
    if (view !== undefined) close(view);
  }

  /**
   * Applies the tab's device emulation inside `area` when it changed. Chromium's emulation
   * calls need a page that loaded something: before that they are skipped and run on the
   * next layout.
   */
  applyEmulation(area: Electron.Rectangle): void {
    const contents = this.view?.webContents;
    if (contents === undefined || contents.isDestroyed() || contents.getURL() === '') return;
    const emulation = this.emulation;
    const key =
      emulation === null ? 'none' : JSON.stringify([emulation, fitDevice(area, emulation).scale]);
    if (key === this.#emulationApplied) return;
    if (emulation === null) {
      if (this.#emulationApplied !== undefined && this.#emulationApplied !== 'none') {
        contents.disableDeviceEmulation();
      }
    } else {
      contents.enableDeviceEmulation({
        screenPosition: emulation.mobile ? 'mobile' : 'desktop',
        screenSize: { width: emulation.width, height: emulation.height },
        viewPosition: { x: 0, y: 0 },
        deviceScaleFactor: emulation.deviceScaleFactor,
        viewSize: { width: emulation.width, height: emulation.height },
        scale: fitDevice(area, emulation).scale,
      });
    }
    this.#emulationApplied = key;
  }

  stepZoom(step: 'in' | 'out' | 'reset'): void {
    const index = ZOOM_STEPS.indexOf(this.zoom);
    const at = index === -1 ? ZOOM_STEPS.indexOf(100) : index;
    if (step === 'reset') this.zoom = 100;
    else if (step === 'in') this.zoom = ZOOM_STEPS[Math.min(at + 1, ZOOM_STEPS.length - 1)] ?? 100;
    else this.zoom = ZOOM_STEPS[Math.max(at - 1, 0)] ?? 100;
    this.view?.webContents.setZoomFactor(this.zoom / 100);
    this.hooks.changed(this);
  }

  state(): BrowserTabState {
    return {
      id: this.id,
      space: this.space,
      url: this.url,
      title: this.title,
      ...(this.favicon === undefined ? {} : { favicon: this.favicon }),
      loading: this.loading,
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      openedBy: this.openedBy,
      security: securityOf(this.url),
      zoom: this.zoom,
      audible: this.audible,
      discarded: this.view === undefined,
      emulation: this.emulation,
      media: this.media,
      devtools: this.devtools,
      ...(this.failure === undefined ? {} : { failure: this.failure }),
      crashed: this.crashed,
    };
  }

  #history(contents: WebContents): void {
    this.canGoBack = contents.navigationHistory.canGoBack();
    this.canGoForward = contents.navigationHistory.canGoForward();
  }

  private wire(contents: WebContents): void {
    const changed = () => {
      this.hooks.changed(this);
    };
    contents.on('did-start-loading', () => {
      this.loading = true;
      changed();
    });
    contents.on('did-stop-loading', () => {
      this.loading = false;
      this.#history(contents);
      changed();
    });
    contents.on('did-navigate', (_event, url) => {
      this.url = url;
      this.failure = undefined;
      this.favicon = undefined;
      this.#history(contents);
      contents.setZoomFactor(this.zoom / 100);
      changed();
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.url = url;
      this.#history(contents);
      changed();
    });
    contents.on('page-title-updated', (_event, title) => {
      this.title = title;
      changed();
    });
    contents.on('page-favicon-updated', (_event, favicons) => {
      void this.#fetchFavicon(contents, favicons[0]);
    });
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 is an aborted load: a new navigation replaced it.
      if (!isMainFrame || code === -3) return;
      this.failure = { url, code, name: description };
      this.loading = false;
      changed();
    });
    contents.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit') return;
      this.crashed = true;
      this.loading = false;
      changed();
    });
    contents.on('audio-state-changed', (event) => {
      this.audible = event.audible;
      changed();
    });
    contents.on('found-in-page', (_event, result) => {
      this.hooks.found(this, result.activeMatchOrdinal, result.matches);
    });
    contents.on('context-menu', (_event, params) => {
      this.hooks.contextMenu(this, params);
    });
    contents.on('before-input-event', (event, input) => {
      if (this.hooks.key(this, input)) event.preventDefault();
    });
    contents.on('zoom-changed', (_event, direction) => {
      this.stepZoom(direction === 'in' ? 'in' : 'out');
    });
    contents.on('devtools-closed', () => {
      this.devtools = 'closed';
      changed();
    });
    this.#guard(contents);
    this.#debugger(contents);
  }

  /** The navigation, popup and prompt rules of a guest (ADR-0088 rule 4). */
  #guard(contents: WebContents): void {
    const refuse = (event: Electron.Event, url: string, what: string) => {
      if (url.startsWith('mailto:')) this.hooks.openExternal(this, url);
      event.preventDefault();
      console.warn(`[browser] blocked ${what} to ${originForLog(url)}`);
    };
    contents.on('will-navigate', (event) => {
      if (!navigable(event.url)) refuse(event, event.url, 'navigation');
    });
    contents.on('will-redirect', (event) => {
      if (event.isMainFrame && !navigable(event.url)) refuse(event, event.url, 'redirect');
    });
    contents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame) return;
      const url = event.url;
      if (!navigable(url) && !url.startsWith('data:')) refuse(event, url, 'frame navigation');
    });
    contents.setWindowOpenHandler((details) => {
      if (navigable(details.url) && !details.url.startsWith('about:')) {
        this.hooks.openTab(this, details.url, details.disposition === 'background-tab');
      } else if (details.url.startsWith('mailto:')) {
        this.hooks.openExternal(this, details.url);
      }
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
    contents.on('will-prevent-unload', (event) => {
      if (this.hooks.beforeUnload(this)) event.preventDefault();
    });
    contents.on('certificate-error', (event, url, error, certificate, callback, isMainFrame) => {
      event.preventDefault();
      if (!isMainFrame) {
        callback(false);
        return;
      }
      this.hooks.certificate(this, url, error, certificate.fingerprint, callback);
    });
    // Without a listener Electron picks the first device by itself (client certificates are
    // refused at the app level: `refuseClientCertificates`).
    contents.on('select-bluetooth-device', (event, _devices, callback) => {
      event.preventDefault();
      callback('');
    });
    contents.on('login', (event, _details, authInfo, callback) => {
      event.preventDefault();
      this.hooks.login(this, authInfo.host, authInfo.realm, authInfo.isProxy, (user, password) => {
        if (user === undefined || password === undefined) callback();
        else callback(user, password);
      });
    });
  }

  /** CDP on every guest: dialogs now, the agent's tools later (ADR-0089 rule 4). */
  #debugger(contents: WebContents): void {
    try {
      contents.debugger.attach('1.3');
    } catch (error) {
      console.warn('[browser] cannot attach the debugger', error);
      return;
    }
    contents.debugger.on('message', (_event, method, params: unknown) => {
      if (method === 'Page.javascriptDialogOpening' && isDialog(params)) {
        this.hooks.dialog(this, params.type, params.message);
      }
    });
    contents.debugger.sendCommand('Page.enable').catch(() => {
      // The page is gone; nothing to watch.
    });
  }

  async #fetchFavicon(contents: WebContents, url: string | undefined): Promise<void> {
    if (url === undefined || contents.isDestroyed()) return;
    try {
      const scheme = new URL(url).protocol;
      if (scheme !== 'http:' && scheme !== 'https:' && scheme !== 'data:') return;
      const response = await contents.session.fetch(url);
      const type = response.headers.get('content-type') ?? 'image/x-icon';
      if (!response.ok || !type.startsWith('image/')) return;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > FAVICON_BYTES) return;
      this.favicon = `data:${type.split(';')[0] ?? 'image/x-icon'};base64,${bytes.toString('base64')}`;
      this.hooks.changed(this);
    } catch {
      // No favicon: the panel shows the site's initial.
    }
  }
}

function isDialog(value: unknown): value is { type: string; message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    'message' in value &&
    typeof value.message === 'string'
  );
}

function close(view: WebContentsView): void {
  const contents = view.webContents;
  if (contents.isDestroyed()) return;
  // Detach CDP before the page goes away (ZCode's use-after-free lesson).
  if (contents.debugger.isAttached()) contents.debugger.detach();
  contents.close();
}

/** How the address bar shows `url`. */
export function securityOf(url: string): SiteSecurity {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'internal';
  }
  if (parsed.protocol === `${WORKSPACE_SCHEME}:`) return 'file';
  if (parsed.protocol === 'https:') return 'secure';
  if (parsed.protocol === 'http:') return local(parsed.hostname) ? 'local' : 'insecure';
  return 'internal';
}
