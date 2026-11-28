// Production `ExternalLinkPort`: a native confirmation dialog, then `shell.openExternal`.
import { dialog, shell, type BrowserWindow, type MessageBoxOptions } from 'electron';

import type { Translator } from '../shared/i18n/index.js';
import type { ExternalLinkPort } from './external-links.js';

/** Port whose dialog is modal to `parent` when there is one, in the app's language. */
export function electronExternalLinkPort(
  parent: BrowserWindow | null,
  translator: Translator,
): ExternalLinkPort {
  return {
    async confirm(url) {
      const options: MessageBoxOptions = {
        type: 'question',
        buttons: [translator.t('link.open'), translator.t('dialog.cancel')],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        message: translator.t('link.confirm'),
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
