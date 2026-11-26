import { describe, expect, it } from 'vitest';

import { browserCommand, pageCommand } from './cdp-policy.js';

const STAGED = '/data/sessions/s/tmp/browser/uploads/1/report.pdf';
const staged = (path: string) => path === STAGED;
const allowed = (method: string, params?: Record<string, unknown>) =>
  pageCommand(method, params, staged).allowed;

describe('pageCommand (B2.6.5)', () => {
  it.each([
    'Page.navigate',
    'Page.captureScreenshot',
    'Runtime.evaluate',
    'Runtime.callFunctionOn',
    'DOM.getDocument',
    'DOM.resolveNode',
    'DOMSnapshot.captureSnapshot',
    'Accessibility.getFullAXTree',
    'CSS.getComputedStyleForNode',
    'Input.dispatchMouseEvent',
    'Input.insertText',
    'Emulation.setDeviceMetricsOverride',
    'Emulation.setTimezoneOverride',
    'Overlay.highlightNode',
    'Log.enable',
    'Network.enable',
    'Network.getResponseBody',
    'Performance.getMetrics',
    'Target.setAutoAttach',
    'Target.detachFromTarget',
  ])('allows %s', (method) => {
    expect(allowed(method)).toBe(true);
  });

  it.each([
    'Browser.getVersion',
    'Browser.close',
    'Storage.clearDataForOrigin',
    'Security.setIgnoreCertificateErrors',
    'SystemInfo.getInfo',
    'Tracing.start',
    'IO.read',
    'ServiceWorker.enable',
    'DOMStorage.getDOMStorageItems',
    'IndexedDB.requestData',
    'CacheStorage.requestEntries',
    'Fetch.enable',
    'Debugger.enable',
    'Page.setDownloadBehavior',
    'Page.addScriptToEvaluateOnNewDocument',
    'Network.getCookies',
    'Network.getAllCookies',
    'Network.setCookie',
    'Network.deleteCookies',
    'Network.setExtraHTTPHeaders',
    'Network.setUserAgentOverride',
    'CSS.setStyleTexts',
    'CSS.addRule',
    'Target.createTarget',
    'Target.attachToTarget',
    'Target.createBrowserContext',
    'Target.exposeDevToolsProtocol',
    'nonsense',
    '.enable',
    'Page.',
  ])('refuses %s', (method) => {
    const verdict = pageCommand(method, undefined, staged);
    expect(verdict.allowed).toBe(false);
  });

  it('takes only staged files for file inputs', () => {
    expect(allowed('DOM.setFileInputFiles', { files: [STAGED], nodeId: 1 })).toBe(true);
    expect(allowed('DOM.setFileInputFiles', { files: ['/etc/passwd'] })).toBe(false);
    expect(allowed('DOM.setFileInputFiles', { files: [STAGED, '/etc/hosts'] })).toBe(false);
    expect(allowed('DOM.setFileInputFiles', { files: [] })).toBe(false);
    expect(allowed('DOM.setFileInputFiles', {})).toBe(false);
  });
});

describe('browserCommand', () => {
  it('answers the Space-scoped Target methods and the version only', () => {
    expect(browserCommand('Target.getTargets').allowed).toBe(true);
    expect(browserCommand('Target.createTarget').allowed).toBe(true);
    expect(browserCommand('Browser.getVersion').allowed).toBe(true);
    expect(browserCommand('Browser.setDownloadBehavior').allowed).toBe(false);
    expect(browserCommand('Target.createBrowserContext').allowed).toBe(false);
    expect(browserCommand('Runtime.evaluate').allowed).toBe(false);
  });
});
