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

/** `Target` methods a page session may forward (frames inside the page). */
const PAGE_TARGET_METHODS: ReadonlySet<string> = new Set([
  'Target.setAutoAttach',
  'Target.detachFromTarget',
  'Target.getTargetInfo',
  'Target.activateTarget',
  'Target.closeTarget',
  'Target.getTargets',
]);

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
