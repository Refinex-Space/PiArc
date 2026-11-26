// The page's place in the panel (B1.5): an empty element whose rectangle the main process
// gives the native page view. It reports the rectangle as it moves and whether something
// covers it; while covered it shows the still frame the main process sent.
import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { BrowserPlacement } from '../../shared/browser.js';
import { useT } from '../app/app-context.js';
import { onWindowVisibility, isWindowVisible } from '../app/window-visibility.js';
import { useToolVisible } from '../shell/ToolHeaderSlot.js';
import { watchCover } from './occlusion.js';

/** Frames to keep re-measuring after a change, for layout that settles over a few frames. */
const SETTLE_FRAMES = 20;

export function Viewport({
  sessionId,
  active,
  claim,
  children,
  onEnter,
}: {
  readonly sessionId: string;
  /** Whether the page should be shown here (a tab is open and nothing replaces it). */
  readonly active: boolean;
  /** Take the page from another window (the user asked). */
  readonly claim: boolean;
  readonly children?: ReactNode;
  readonly onEnter: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const toolVisible = useToolVisible();
  const [windowVisible, setWindowVisible] = useState(isWindowVisible());
  const [occluded, setOccluded] = useState(false);
  const [still, setStill] = useState<string | undefined>(undefined);
  const shown = active && toolVisible && windowVisible;

  useEffect(
    () =>
      onWindowVisibility(() => {
        setWindowVisible(isWindowVisible());
      }),
    [],
  );

  useEffect(
    () =>
      window.piarc.onAppEvent((event) => {
        if (event.type === 'browserStill' && event.sessionId === sessionId) setStill(event.image);
      }),
    [sessionId],
  );

  useEffect(() => {
    const element = ref.current;
    if (element === null || !shown) return;
    return watchCover(element, setOccluded);
  }, [shown]);

  useEffect(() => {
    if (!occluded) setStill(undefined);
  }, [occluded]);

  useEffect(() => {
    const element = ref.current;
    if (element === null || !shown) {
      void window.piarc.placeBrowser(sessionId, null);
      return;
    }
    const view = element.ownerDocument.defaultView;
    const toolWindow = view !== null && view !== window ? view.name : undefined;
    let frames = 0;
    let frame = 0;
    let last = '';
    const send = () => {
      const rect = element.getBoundingClientRect();
      const placement: BrowserPlacement = {
        bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        occluded,
        ...(toolWindow === undefined || toolWindow === '' ? {} : { toolWindow }),
        ...(claim ? { claim } : {}),
      };
      const key = JSON.stringify(placement);
      if (key === last) return;
      last = key;
      window.piarc.placeBrowser(sessionId, placement).catch((error: unknown) => {
        console.warn('[browser] placing the page failed', error);
      });
    };
    const tick = () => {
      send();
      frames += 1;
      frame = frames < SETTLE_FRAMES && view !== null ? view.requestAnimationFrame(tick) : 0;
    };
    const settle = () => {
      frames = 0;
      if (frame === 0 && view !== null) frame = view.requestAnimationFrame(tick);
    };
    const resize = new ResizeObserver(settle);
    resize.observe(element);
    view?.addEventListener('resize', settle);
    settle();
    return () => {
      resize.disconnect();
      view?.removeEventListener('resize', settle);
      if (frame !== 0) view?.cancelAnimationFrame(frame);
    };
  }, [sessionId, shown, occluded, claim]);

  useEffect(
    () => () => {
      void window.piarc.placeBrowser(sessionId, null);
    },
    [sessionId],
  );

  return (
    <div
      ref={ref}
      className="browser-viewport"
      data-testid="browser-viewport"
      data-occluded={occluded}
      role="region"
      aria-label={t('browser.viewport')}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onEnter();
        }
      }}
    >
      {occluded && still !== undefined && (
        <img className="browser-still" src={still} alt="" data-testid="browser-occlusion" />
      )}
      {children}
    </div>
  );
}
