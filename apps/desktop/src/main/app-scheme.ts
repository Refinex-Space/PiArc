// The custom scheme that serves the renderer (architecture section 10.3). It is registered as
// standard and secure, so pages loaded from it get the stable origin `APP_ORIGIN`, which CSP
// `'self'`, the navigation guard and the IPC sender check all compare against.
//
// The scheme name is provisional and changes together with the application identifier (D2).
// `piarc://` is reserved for deep links (T35) and must not be used here.

/** Scheme name, without the colon. */
export const APP_SCHEME = 'app';
/** The only host the scheme serves. */
export const APP_HOST = 'piarc';
/** Origin of every page the app loads. */
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
/** URL the main window loads. */
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;
