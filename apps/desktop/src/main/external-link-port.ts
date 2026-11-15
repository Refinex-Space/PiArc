// Production `ExternalLinkPort`: a native confirmation dialog, then `shell.openExternal`.
import { dialog, shell, type BrowserWindow, type MessageBoxOptions } from 'electron';

import type { ExternalLinkPort } from './external-links.js';

/** Port whose dialog is modal to `parent` when there is one. */
export function electronExternalLinkPort(parent: BrowserWindow | null): ExternalLinkPort {
  return {
    async confirm(url) {
      const options: MessageBoxOptions = {
        type: 'question',
        buttons: ['Open', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        message: 'Open this link in your browser?',
        detail: url,
      };
      const { response } =
        parent === null
          ? await dialog.showMessageBox(options)
          : await dialog.showMessageBox(parent, options);
      return response === 0;
    },
    open: (url) => shell.openExternal(url),
  };
}
