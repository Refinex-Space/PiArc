// The site information menu's "Import this site's sign-ins from Chrome" (design addendum
// B5.1): opens the settings page "Browser" with the import for the page's host in the
// session's workspace. The import itself (profile, sites, native confirmation) is the page's.
import { rememberImportTarget } from '../settings/browser-import-target.js';

export function openChromeImport(host: string, workspace: string | undefined): void {
  rememberImportTarget(workspace === undefined ? { host } : { host, workspace });
  window.piarc.openSettings('browser').catch((error: unknown) => {
    console.error('[browser] cannot open the browser settings', error);
  });
}
