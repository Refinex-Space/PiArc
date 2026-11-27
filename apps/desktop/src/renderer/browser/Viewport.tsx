// The page's place in the panel (B1.5): an empty element whose rectangle the main process
// gives the native page view. It reports the rectangle as it moves and whether something
// covers it; while covered it shows a still frame of the page. The swap never shows a gap: the
// still frame is painted under the page before the page is hidden, and taken away only after
// the page is back.
import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { BrowserPlacement } from '../../shared/browser.js';
import { useT } from '../app/app-context.js';
import { onWindowVisibility, isWindowVisible } from '../app/window-visibility.js';
import { useToolVisible } from '../shell/ToolHeaderSlot.js';
import { watchCover } from './occlusion.js';

/** Frames to keep re-measuring after a change, for layout that settles over a few frames. */
const SETTLE_FRAMES = 20;

/** Resolves after the browser painted the next frame. */
function painted(view: Window | null): Promise<void> {
  return new Promise((resolve) => {
    if (view === null) {
      resolve();
      return;
    }
    view.requestAnimationFrame(() => {
      view.requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}

export function Viewport({
  sessionId,
  active,
  claim,
  children,
  onEnter,
  frozen = false,
}: {
  readonly sessionId: string;
  /** Whether the page should be shown here (a tab is open and nothing replaces it). */
  readonly active: boolean;
  /** Take the page from another window (the user asked). */
  readonly claim: boolean;
  readonly children?: ReactNode;
  readonly onEnter: () => void;
  /** Annotating (B3.3): the page's view is hidden and the panel draws its screenshot instead. */
  readonly frozen?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const toolVisible = useToolVisible();
  const [windowVisible, setWindowVisible] = useState(isWindowVisible());
  // Something of the workbench is over the viewport, and what the main process was told.
  const [covered, setCovered] = useState(false);
  const [occluded, setOccluded] = useState(false);
  const [still, setStill] = useState<string | undefined>(undefined);
  /** The last placement sent: the still frame goes once the page is back. */
  const placed = useRef<Promise<unknown>>(Promise.resolve());
  // The document the viewport lives in: popping the tool out moves it to another window.
  const [host, setHost] = useState<Document | null>(null);
  const shown = active && toolVisible && windowVisible;

  useEffect(() => {
    const check = () => {
      const doc = ref.current?.ownerDocument ?? null;
      setHost((current) => (current === doc ? current : doc));
    };
    check();
    const timer = window.setInterval(check, 500);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(
    () =>
      onWindowVisibility(() => {
        setWindowVisible(isWindowVisible());
      }),
    [],
  );

  useEffect(() => {
    const element = ref.current;
    if (element === null || !shown) {
      setCovered(false);
      return;
    }
    return watchCover(element, setCovered);
  }, [shown, host]);

  // Covered: paint the page's still frame under the page first, then have it hidden.
  useEffect(() => {
    if (!covered) {
      setOccluded(false);
      return;
    }
    const run = { live: true };
    // A call, not the field: TypeScript would keep a checked field narrowed across awaits.
    const live = () => run.live;
    const view = ref.current?.ownerDocument.defaultView ?? null;
    void (async () => {
      let image: string | undefined;
      try {
        const answer = await window.piarc.browser(sessionId, { op: 'still' });
        if (typeof answer === 'string') image = answer;
      } catch {
        // No frame: the panel's background shows while the page is hidden.
      }
      if (!live()) return;
      if (image !== undefined) {
        const decoding = new Image();
        decoding.src = image;
        await decoding.decode().catch(() => undefined);
        if (!live()) return;
        setStill(image);
        await painted(view);
      }
      if (live()) setOccluded(true);
    })();
    return () => {
      run.live = false;
    };
  }, [covered, sessionId]);

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
        occluded: occluded || frozen,
        ...(toolWindow === undefined || toolWindow === '' ? {} : { toolWindow }),
        ...(claim ? { claim } : {}),
      };
      const key = JSON.stringify(placement);
      if (key === last) return;
      last = key;
      placed.current = window.piarc.placeBrowser(sessionId, placement).catch((error: unknown) => {
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
  }, [sessionId, shown, occluded, frozen, claim, host]);

  // Uncovered: the still frame goes once the page is shown again (after the placement above).
  useEffect(() => {
    if (occluded || covered || still === undefined) return;
    let live = true;
    const view = ref.current?.ownerDocument.defaultView ?? null;
    void placed.current
      .then(() => painted(view))
      .then(() => {
        if (live) setStill(undefined);
      });
    return () => {
      live = false;
    };
  }, [occluded, covered, still]);

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
        // Only the placeholder itself: Enter in a control drawn over it (the annotation's text
        // and comments, a start page button) stays with that control.
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onEnter();
        }
      }}
    >
      {!frozen && still !== undefined && (
        <img className="browser-still" src={still} alt="" data-testid="browser-occlusion" />
      )}
      {children}
    </div>
  );
}
