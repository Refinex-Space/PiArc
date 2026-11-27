// Which DevTools Protocol commands an agent's script may send to a page (ADR-0089, design
// addendum B2.6.5). The script drives pages through the browser SDK; the commands below are
// what the SDK and `page.cdp()` need to read, act and emulate. Commands that reach beyond the
// page (the browser, storage of other sites, the file system, request interception, other
// targets) or that bypass PiArc's own bindings (downloads, uploads, scripts injected into
// every future document) are refused, and each refusal goes into the run's audit row.

/** Domains a page session may use, all of their methods unless listed below. */
const PAGE_DOMAINS: ReadonlySet<string> = new Set([
  'Page',
  'Runtime',
  'DOM',
  'DOMSnapshot',
  'Accessibility',
  'CSS',
  'Input',
  'Emulation',
  'Overlay',
  'Log',
  'Network',
  'Performance',
]);

/** Methods of allowed domains that are refused anyway. */
const REFUSED_METHODS: ReadonlySet<string> = new Set([
  // Downloads go through the main process's staging directory (B2.6.6).
  'Page.setDownloadBehavior',
  // Scripts for every future document only through a binding that clears them (B2.6.5).
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.removeScriptToEvaluateOnNewDocument',
  // Closing the target or the whole page from inside goes through `Target.closeTarget`.
  'Page.close',
  'Page.crash',
  // The page's cookies, headers and identity stay as the browser keeps them.
  'Network.getCookies',
  'Network.getAllCookies',
  'Network.setCookie',
  'Network.setCookies',
  'Network.deleteCookies',
  'Network.clearBrowserCookies',
  'Network.clearBrowserCache',
  'Network.setExtraHTTPHeaders',
  'Network.setUserAgentOverride',
  'Network.setBlockedURLs',
  'Network.setRequestInterception',
  'Network.continueInterceptedRequest',
  'Network.replayXHR',
  'Network.loadNetworkResource',
  'Network.setAttachDebugStack',
  // CSS is read only: the agent changes pages through `evaluate`, which the user can see.
  'CSS.setStyleTexts',
  'CSS.setStyleSheetText',
  'CSS.setRuleSelector',
  'CSS.setKeyframeKey',
  'CSS.setMediaText',
  'CSS.setContainerQueryText',
  'CSS.setSupportsText',
  'CSS.setScopeText',
  'CSS.setPropertyRulePropertyName',
  'CSS.addRule',
  'CSS.createStyleSheet',
  'CSS.forcePseudoState',
  'CSS.setEffectivePropertyValueForNode',
  'CSS.setLocalFontsEnabled',
]);

/**
 * `Target` methods a page session may forward: the frames inside the page. Other targets are
 * reached through the proxy's browser-level methods, which answer only the Space's own tabs.
 */
const PAGE_TARGET_METHODS: ReadonlySet<string> = new Set([
  'Target.setAutoAttach',
  'Target.detachFromTarget',
]);

/** Network events whose content includes cookie values (HttpOnly ones too, THR-17). */
const COOKIE_EVENTS: ReadonlySet<string> = new Set([
  'Network.requestWillBeSentExtraInfo',
  'Network.responseReceivedExtraInfo',
  'Network.responseReceivedEarlyHints',
]);

/**
 * Chromium's own download events: PiArc reports the downloads of a run itself, with the guid
 * its staging uses (`agent-downloads.ts`, B2.6.6), so these would name downloads it cannot save.
 */
const NATIVE_DOWNLOAD_EVENTS: ReadonlySet<string> = new Set([
  'Page.downloadWillBegin',
  'Page.downloadProgress',
  'Browser.downloadWillBegin',
  'Browser.downloadProgress',
]);

/** Header names that carry cookies. */
const COOKIE_HEADERS: ReadonlySet<string> = new Set(['cookie', 'set-cookie', 'set-cookie2']);

/** Browser-level methods the proxy answers itself (the Space's own tabs). */
export const BROWSER_METHODS: ReadonlySet<string> = new Set([
  'Target.getTargets',
  'Target.getTargetInfo',
  'Target.attachToTarget',
  'Target.detachFromTarget',
  'Target.setDiscoverTargets',
  'Target.setAutoAttach',
  'Target.activateTarget',
  'Target.closeTarget',
  'Target.createTarget',
  'Browser.getVersion',
  'Browser.cancelDownload',
]);

export type CdpVerdict =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * Whether `method` may go to a page session. `stagedFile` tells whether a path is a file the
 * main process staged for this run's uploads (`DOM.setFileInputFiles` takes only those).
 */
export function pageCommand(
  method: string,
  params: Record<string, unknown> | undefined,
  stagedFile: (path: string) => boolean,
): CdpVerdict {
  const dot = method.indexOf('.');
  if (dot <= 0 || dot === method.length - 1) {
    return { allowed: false, reason: 'not a DevTools method name' };
  }
  const domain = method.slice(0, dot);
  if (domain === 'Target') {
    return PAGE_TARGET_METHODS.has(method)
      ? { allowed: true }
      : { allowed: false, reason: 'only the frames of this page' };
  }
  if (method === 'Input.dispatchDragEvent') {
    // A drag can carry local files into the page (`data.files`): uploads are staged instead.
    const data = params?.data;
    const files =
      typeof data === 'object' && data !== null && 'files' in data ? data.files : undefined;
    if (Array.isArray(files) && files.length > 0) {
      return {
        allowed: false,
        reason: 'files go through setInputFiles(), which stages them first',
      };
    }
  }
  if (method === 'DOM.setFileInputFiles') {
    const files = params?.files;
    const staged =
      Array.isArray(files) &&
      files.length > 0 &&
      files.every((file) => typeof file === 'string' && stagedFile(file));
    return staged
      ? { allowed: true }
      : { allowed: false, reason: 'files go through setInputFiles(), which stages them first' };
  }
  if (!PAGE_DOMAINS.has(domain)) {
    return { allowed: false, reason: `the ${domain} domain is not available to the agent` };
  }
  if (REFUSED_METHODS.has(method)) {
    return { allowed: false, reason: `${method} is not available to the agent` };
  }
  return { allowed: true };
}

/** Whether `method` without a session is one the proxy answers. */
export function browserCommand(method: string): CdpVerdict {
  return BROWSER_METHODS.has(method)
    ? { allowed: true }
    : { allowed: false, reason: `${method} is not available to the agent` };
}

/**
 * A page event as the agent's script may see it (THR-17): the events that list cookies and
 * Chromium's own download events are dropped (undefined), cookie headers are removed from
 * requests and responses, everything else passes unchanged.
 */
export function pageEvent(method: string, params: unknown): unknown {
  if (COOKIE_EVENTS.has(method) || NATIVE_DOWNLOAD_EVENTS.has(method)) return undefined;
  if (method !== 'Network.requestWillBeSent' && method !== 'Network.responseReceived') {
    return params;
  }
  if (typeof params !== 'object' || params === null) return params;
  const event = { ...(params as Record<string, unknown>) };
  for (const key of ['request', 'response', 'redirectResponse']) {
    const part = event[key];
    if (typeof part !== 'object' || part === null) continue;
    const copy = { ...(part as Record<string, unknown>) };
    for (const field of ['headers', 'requestHeaders']) {
      const headers = copy[field];
      if (typeof headers !== 'object' || headers === null) continue;
      copy[field] = Object.fromEntries(
        Object.entries(headers).filter(([name]) => !COOKIE_HEADERS.has(name.toLowerCase())),
      );
    }
    event[key] = copy;
  }
  return event;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A device the agent asked for with `Emulation.setDeviceMetricsOverride` (B1.4.2). */
export interface AgentEmulation {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly mobile: boolean;
}

/** The sizes and pixel ratios the panel shows (the device toolbar's limits). */
const EMULATED_SIDE = { min: 200, max: 4000 } as const;
const EMULATED_SCALE = 3;

/**
 * The device of an agent's `setDeviceMetricsOverride`, applied as the panel's own emulation so
 * the panel, `browserState()` and the page agree; a string explains what the panel cannot show.
 */
export function agentEmulation(params: unknown): AgentEmulation | string {
  if (!isRecord(params)) return 'width and height are required';
  const { width, height, deviceScaleFactor, mobile } = params;
  const side = (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= EMULATED_SIDE.min &&
    value <= EMULATED_SIDE.max;
  if (!side(width) || !side(height)) {
    return `width and height are whole numbers from ${String(EMULATED_SIDE.min)} to ${String(EMULATED_SIDE.max)}`;
  }
  const scale = deviceScaleFactor === 0 || deviceScaleFactor === undefined ? 1 : deviceScaleFactor;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 1 || scale > EMULATED_SCALE) {
    return `deviceScaleFactor is from 1 to ${String(EMULATED_SCALE)}`;
  }
  return {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: mobile === true,
  };
}
