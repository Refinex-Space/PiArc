import { describe, expect, it } from 'vitest';

import { agentEmulation, browserCommand, pageCommand, pageEvent } from './cdp-policy.js';

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

describe('THR-16 and THR-17 tightening (B2.6.5)', () => {
  it('THR-16 refuses dragging local files into a page and page-level Target reach', () => {
    const none = () => false;
    const drop = { type: 'drop', x: 1, y: 1 };
    expect(
      pageCommand(
        'Input.dispatchDragEvent',
        { ...drop, data: { items: [], files: ['/etc/hosts'], dragOperationsMask: 1 } },
        none,
      ).allowed,
    ).toBe(false);
    expect(
      pageCommand(
        'Input.dispatchDragEvent',
        { ...drop, data: { items: [], dragOperationsMask: 1 } },
        none,
      ).allowed,
    ).toBe(true);
    for (const method of [
      'Target.getTargets',
      'Target.getTargetInfo',
      'Target.activateTarget',
      'Target.closeTarget',
    ]) {
      expect(pageCommand(method, {}, none).allowed, method).toBe(false);
    }
    expect(pageCommand('Target.setAutoAttach', {}, none).allowed).toBe(true);
  });

  it('THR-17 keeps cookies out of the network events the script sees', () => {
    expect(
      pageEvent('Network.requestWillBeSentExtraInfo', { associatedCookies: [] }),
    ).toBeUndefined();
    expect(pageEvent('Network.responseReceivedExtraInfo', { headers: {} })).toBeUndefined();
    const sent = pageEvent('Network.requestWillBeSent', {
      requestId: '1',
      request: { url: 'https://a.example/', headers: { Cookie: 'sid=1', Accept: '*/*' } },
    });
    expect(sent).toEqual({
      requestId: '1',
      request: { url: 'https://a.example/', headers: { Accept: '*/*' } },
    });
    const received = pageEvent('Network.responseReceived', {
      requestId: '1',
      response: {
        status: 200,
        headers: { 'Set-Cookie': 'sid=1', 'content-type': 'text/html' },
        requestHeaders: { cookie: 'sid=1' },
      },
    });
    expect(received).toEqual({
      requestId: '1',
      response: { status: 200, headers: { 'content-type': 'text/html' }, requestHeaders: {} },
    });
    const other = { frameId: 'f' };
    expect(pageEvent('Page.frameNavigated', other)).toBe(other);
  });

  it('B2.6.6 drops Chromium’s own download events: PiArc reports downloads with its guid', () => {
    for (const method of [
      'Page.downloadWillBegin',
      'Page.downloadProgress',
      'Browser.downloadWillBegin',
      'Browser.downloadProgress',
    ]) {
      expect(pageEvent(method, { guid: 'chromium-guid' }), method).toBeUndefined();
    }
  });
});

describe('agentEmulation (B1.4.2)', () => {
  it('takes the device the panel can show and explains anything else', () => {
    expect(agentEmulation({ width: 390, height: 844, deviceScaleFactor: 3, mobile: true })).toEqual(
      {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true,
      },
    );
    expect(agentEmulation({ width: 1280, height: 800, deviceScaleFactor: 0 })).toEqual({
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const params of [
      { width: 0, height: 800, deviceScaleFactor: 1 },
      { width: 199, height: 800, deviceScaleFactor: 1 },
      { width: 4001, height: 800, deviceScaleFactor: 1 },
      { width: 390.5, height: 800, deviceScaleFactor: 1 },
      { width: 390, height: 800, deviceScaleFactor: 4 },
      { width: 390, height: 800, deviceScaleFactor: -1 },
      { width: '390', height: 800, deviceScaleFactor: 1 },
      undefined,
    ]) {
      expect(typeof agentEmulation(params)).toBe('string');
    }
  });
});
