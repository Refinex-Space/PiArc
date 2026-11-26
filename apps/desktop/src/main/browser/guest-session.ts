// What every guest partition gets when it is created (ADR-0088 rules 3-5): Core's proxy, a
// Chrome user agent, deny-by-default permissions and devices, the request rules, and the
// downloads hook. The agent's request gate (B2) plugs into `gate`.
import { app, type DownloadItem, type Session, type WebContents } from 'electron';

import { proxyRefused, requestVerdict, type RequestVerdict } from './request-rules.js';

/** Permissions a user may allow for one page of a tab they control (B1.3.2). */
export const PROMPTABLE = new Set([
  'media',
  'geolocation',
  'notifications',
  'clipboard-read',
  'midi',
  'midiSysex',
  'pointerLock',
  'keyboardLock',
  'local-fonts',
  'idle-detection',
  'window-management',
  'storage-access',
  'top-level-storage-access',
]);

/** Granted to every guest page without asking: copying from a page the user is using. */
const GRANTED = new Set(['clipboard-sanitized-write']);

/** What a guest session asks its owner. */
export interface GuestSessionHooks {
  /** Asks the user about `permission` for the tab of `contents`; resolves with the answer. */
  permission(contents: WebContents, origin: string, permission: string): Promise<boolean>;
  /** Whether `permission` was allowed for `origin` in the tab of `contents`. */
  granted(contents: WebContents | null, origin: string, permission: string): boolean;
  download(contents: WebContents | undefined, item: DownloadItem): void;
  /** The agent's request gate (B2); the request rules have already passed. */
  gate?(details: Electron.OnBeforeRequestListenerDetails): RequestVerdict | Promise<RequestVerdict>;
  /** PiArc's own loopback ports now. */
  deniedPorts(): ReadonlySet<number>;
  /** A page's load whose server refused the connection behind the proxy (B1.3.1). */
  refusedLoad(webContentsId: number, url: string): void;
}

/** Chrome's user agent without Electron's and PiArc's tokens, so sites treat it as Chrome. */
export function chromeUserAgent(fallback: string): string {
  return fallback
    .replace(/\s?Electron\/\S+/i, '')
    .replace(/\s?piarc\/\S+/i, '')
    .replace(/\s?PiArc\/\S+/, '');
}

/** Sets up a guest partition; `proxyPort` is its Core proxy on `127.0.0.1`. */
export async function setUpGuestSession(
  session: Session,
  proxyPort: number,
  hooks: GuestSessionHooks,
): Promise<void> {
  // Everything goes through Core, loopback included (`<-loopback>` removes Chromium's implicit
  // bypass): the proxy refuses PiArc's own ports and DNS rebinding (ADR-0088 rule 5).
  await session.setProxy({
    proxyRules: `127.0.0.1:${String(proxyPort)}`,
    proxyBypassRules: '<-loopback>',
  });
  session.setUserAgent(chromeUserAgent(app.userAgentFallback));
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const origin = originOf(details.requestingUrl);
    if (GRANTED.has(permission)) {
      callback(true);
      return;
    }
    if (!PROMPTABLE.has(permission) || origin === undefined) {
      callback(false);
      return;
    }
    if (hooks.granted(contents, origin, permission)) {
      callback(true);
      return;
    }
    hooks.permission(contents, origin, permission).then(callback, () => {
      callback(false);
    });
  });
  session.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    if (GRANTED.has(permission)) return true;
    return PROMPTABLE.has(permission) && hooks.granted(contents, requestingOrigin, permission);
  });
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => {
    callback({});
  });
  // Without listeners Chromium may pick a device by itself; every chooser answers "none".
  session.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault();
    callback(null);
  });
  session.on('select-serial-port', (event, _ports, _contents, callback) => {
    event.preventDefault();
    callback('');
  });
  session.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  session.webRequest.onBeforeRequest((details, callback) => {
    const verdict = requestVerdict(details.url, hooks.deniedPorts());
    if (!verdict.allow || hooks.gate === undefined) {
      callback({ cancel: !verdict.allow });
      return;
    }
    const gated = hooks.gate(details);
    if (!(gated instanceof Promise)) {
      callback({ cancel: !gated.allow });
      return;
    }
    gated.then(
      (answer) => {
        callback({ cancel: !answer.allow });
      },
      () => {
        callback({ cancel: true });
      },
    );
  });
  // Behind the proxy a local server that is not up yet answers the proxy's marked 502; the
  // load fails instead, and the tab treats it as `ERR_CONNECTION_REFUSED` (B1.3.1).
  session.webRequest.onHeadersReceived((details, callback) => {
    if (
      details.resourceType === 'mainFrame' &&
      details.webContentsId !== undefined &&
      proxyRefused(details.statusCode, details.responseHeaders)
    ) {
      hooks.refusedLoad(details.webContentsId, details.url);
      callback({ cancel: true });
      return;
    }
    callback({});
  });
  session.on('will-download', (_event, item, contents) => {
    hooks.download(contents, item);
  });
}

/**
 * Refuses client certificates to browser guests: without this Electron answers a TLS client
 * certificate request with the first certificate in the store.
 */
export function refuseClientCertificates(isGuest: (contents: WebContents) => boolean): void {
  app.on('select-client-certificate', (event, contents, _url, _list, callback) => {
    if (contents === null || !isGuest(contents)) return;
    event.preventDefault();
    callback();
  });
}

function originOf(url: string): string | undefined {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}
