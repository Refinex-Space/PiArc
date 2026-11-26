// What the window says about a session's local services (design addendum B4.4, B4.5): a port
// that starts listening gets a toast "localhost:<port> is ready" with "Open in preview" and a
// dot on the preview tool button; a failed server gets the dot (its card is in the panel). The
// main process sends each port once per session.
import { useEffect } from 'react';

import { useT } from '../app/app-context.js';
import { showPanel } from '../shell/registry.js';
import { useUi } from '../shell/ui.js';
import { markPreview } from './attention.js';

export function BrowserNotices() {
  const t = useT();
  const ui = useUi();
  useEffect(
    () =>
      window.piarc.onAppEvent((event) => {
        if (event.type === 'browserServerFailed') {
          markPreview(event.sessionId);
          return;
        }
        if (event.type !== 'browserService') return;
        const { sessionId, port, url } = event;
        markPreview(sessionId);
        ui.addToast({
          sessionId,
          text: t('browser.service.ready', { port }),
          action: {
            label: t('browser.service.openInPreview'),
            run: () => {
              ui.show({ kind: 'session', id: sessionId });
              // The session's tools mount with it; ask for the preview once they listen.
              requestAnimationFrame(() => {
                showPanel('preview');
              });
              window.piarc
                .browser(sessionId, { op: 'navigate', input: url, newTab: true })
                .catch((error: unknown) => {
                  console.warn('[browser] could not open the service', error);
                });
            },
          },
        });
      }),
    [t, ui],
  );
  return null;
}
