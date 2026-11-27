// The offer to use Chrome's sign-ins in this workspace (design addendum B5.1), shown once per
// workspace under the address bar's site button while a site of the web is open: Chrome has
// profiles and nothing was imported here yet. "Choose sites…" opens the import (profile, sites,
// the main process's native confirmation); "Not now" and Esc close it. Asking Chrome for its
// profiles reads their names only; no cookie is read before the user picks sites and confirms.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

import { useT } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { useOverlayRect } from '../app/overlays.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { parseImports, parseProfiles } from '../settings/browser-settings.js';
import { markPrompted, promptHost, wasPrompted } from './chrome-prompt.js';
import { openChromeImport } from './site-import.js';

export function ChromePrompt({
  url,
  workspace,
  enabled,
  localNames,
  anchor,
}: {
  readonly url: string;
  readonly workspace: string | undefined;
  /** A page is shown and nothing else holds it (picking, annotating). */
  readonly enabled: boolean;
  readonly localNames: readonly string[];
  /** The element the offer points at (the site button). */
  readonly anchor: () => Element | null | undefined;
}) {
  const t = useT();
  const host = promptHost(url, localNames);
  const [offer, setOffer] = useState<{ readonly workspace: string }>();
  const [at, setAt] = useState<{ readonly left: number; readonly top: number }>();
  const ref = useRef<HTMLElement>(null);
  // On a local page (or while the page is held) the offer waits; it stays for this workspace.
  const shown =
    offer !== undefined && offer.workspace === workspace && enabled && host !== undefined;
  useOverlayRect(ref, shown);

  useEffect(() => {
    if (!enabled || host === undefined || workspace === undefined) return;
    if (offer !== undefined || wasPrompted(workspace)) return;
    const run = { live: true };
    // A call, not the field: TypeScript would keep a checked field narrowed across awaits.
    const live = () => run.live;
    void (async () => {
      const { chrome, profiles } = parseProfiles(await window.piarc.chromeProfiles());
      if (!chrome || profiles.length === 0 || !live()) return;
      if (parseImports(await window.piarc.browserImports(workspace)).length > 0) return;
      if (!live() || wasPrompted(workspace)) return;
      markPrompted(workspace);
      setOffer({ workspace });
    })().catch((error: unknown) => {
      console.warn('[browser] cannot tell whether Chrome has sign-ins to offer', error);
    });
    return () => {
      run.live = false;
    };
  }, [enabled, host, workspace, offer]);

  // Under the site button; again when the window changes size.
  useLayoutEffect(() => {
    if (!shown) return;
    const place = () => {
      const rect = anchor()?.getBoundingClientRect();
      if (rect === undefined) return;
      const left = rect.left;
      const top = rect.bottom + 6;
      setAt((current) => (current?.left === left && current.top === top ? current : { left, top }));
    };
    place();
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
    };
  }, [shown, anchor]);

  if (!shown) return null;
  const close = () => {
    setOffer(undefined);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (isImeComposing(event.nativeEvent) || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  return (
    <section
      ref={ref}
      className="browser-chrome-offer"
      data-testid="browser-chrome-offer"
      role="dialog"
      aria-labelledby="browser-chrome-offer-title"
      aria-describedby="browser-chrome-offer-body"
      style={at === undefined ? { visibility: 'hidden' } : { left: at.left, top: at.top }}
      onKeyDown={onKeyDown}
    >
      <span className="browser-chrome-offer-arrow" aria-hidden="true" />
      <h2 id="browser-chrome-offer-title" className="browser-chrome-offer-title">
        {t('browser.chromePrompt.title')}
      </h2>
      <p id="browser-chrome-offer-body" className="browser-chrome-offer-body">
        {t('browser.chromePrompt.body')}
      </p>
      <div className="browser-chrome-offer-actions">
        <Button
          variant="ghost"
          size="small"
          data-testid="browser-chrome-offer-dismiss"
          onClick={close}
        >
          {t('browser.chromePrompt.dismiss')}
        </Button>
        <Button
          variant="primary"
          size="small"
          data-testid="browser-chrome-offer-import"
          onClick={() => {
            close();
            openChromeImport(host, offer.workspace);
          }}
        >
          {t('browser.chromePrompt.import')}
        </Button>
      </div>
    </section>
  );
}
