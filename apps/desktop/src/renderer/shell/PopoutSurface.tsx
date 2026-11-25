import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from '../app/IconButton.js';
import { useT } from '../app/app-context.js';
import { SurfaceDocument } from '../app/surface-document.js';
import { TooltipLayer } from '../app/Tooltip.js';
import { PinIcon } from './icons.js';
import { useUi } from './ui.js';
import { reason } from './errors.js';

interface NativeTool {
  readonly ticket: string;
  readonly popup: Window;
  readonly doc: Document;
}
const Pinned = createContext<{ pinned: boolean; toggle: () => void } | null>(null);

export function ToolWindowPin() {
  const pin = useContext(Pinned);
  const t = useT();
  if (!pin) return null;
  const label = t(pin.pinned ? 'tiles.unpin' : 'tiles.pin');
  return (
    <IconButton
      label={label}
      aria-pressed={pin.pinned}
      data-testid="tool-window-pin"
      onClick={pin.toggle}
    >
      <PinIcon label={label} />
    </IconButton>
  );
}

/** Resolve only after Chromium has replaced the transient about:blank with the scriptless page. */
async function loadedDocument(popup: Window, url: string, signal: AbortSignal): Promise<Document> {
  const until = Date.now() + 10000;
  while (!signal.aborted && !popup.closed && Date.now() < until) {
    if (popup.location.href === url && popup.document.readyState !== 'loading')
      return popup.document;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
  }
  throw new Error('Tool window did not load');
}

function mirrorAppearance(doc: Document): () => void {
  const source = document.documentElement;
  const target = doc.documentElement;
  const sync = () => {
    for (const attr of [
      'lang',
      'dir',
      'data-app',
      'data-platform',
      'data-color-mode',
      'data-density',
      'data-reduce-motion',
    ]) {
      const value = source.getAttribute(attr);
      if (value === null) target.removeAttribute(attr);
      else target.setAttribute(attr, value);
    }
  };
  sync();
  for (const style of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const copy = doc.createElement('link');
    copy.rel = 'stylesheet';
    copy.href = style.href;
    doc.head.append(copy);
  }
  doc.body.dataset.toolWindow = '';
  const observer = new MutationObserver(sync);
  observer.observe(source, { attributes: true });
  const markPointer = () => {
    target.setAttribute('data-pointer-focus', '');
  };
  const markKeyboard = () => {
    target.removeAttribute('data-pointer-focus');
  };
  doc.addEventListener('pointerdown', markPointer, true);
  doc.addEventListener('keydown', markKeyboard, true);
  return () => {
    observer.disconnect();
    doc.removeEventListener('pointerdown', markPointer, true);
    doc.removeEventListener('keydown', markKeyboard, true);
  };
}

export function PopoutSurface({
  sessionId,
  panelId,
  title,
  detached,
  onDock,
  children,
}: {
  readonly sessionId: string;
  readonly panelId: string;
  readonly title: string;
  readonly detached: boolean;
  readonly onDock: () => void;
  readonly children: ReactNode;
}) {
  const ui = useUi();
  const t = useT();
  const anchor = useRef<HTMLDivElement>(null);
  const [content] = useState(() => {
    const node = document.createElement('div');
    node.className = 'tool-surface-content';
    node.style.display = 'contents';
    return node;
  });
  const [native, setNative] = useState<NativeTool | null>(null);
  const [pinned, setPinned] = useState(false);
  const callbacks = useRef({ ui, t, onDock, title });
  callbacks.current = { ui, t, onDock, title };
  const report = useCallback(
    (failure: unknown) => {
      callbacks.current.ui.addToast({
        sessionId,
        text: callbacks.current.t('tiles.popoutFailed', {
          reason: reason(failure),
        }),
      });
    },
    [sessionId],
  );

  useLayoutEffect(() => {
    const local = anchor.current;
    if (!local) return;
    local.append(content);
    return () => {
      content.remove();
    };
  }, [content]);
  useEffect(() => {
    if (!detached) return;
    const controller = new AbortController();
    let popup: Window | null = null;
    let cleanup: (() => void) | undefined;
    const dock = () => {
      if (controller.signal.aborted) return;
      // Adopt the live DOM back before Chromium releases the closing document.
      anchor.current?.append(content);
      setNative(null);
      setPinned(false);
      callbacks.current.onDock();
    };
    const open = async () => {
      const ticket = await window.piarc.prepareToolWindow(sessionId, panelId);
      if (controller.signal.aborted) return;
      const url = new URL('/tool-window.html', document.URL).href;
      popup = window.open(url, ticket);
      if (!popup) throw new Error('Tool window was not opened');
      const doc = await loadedDocument(popup, url, controller.signal);
      controller.signal.throwIfAborted();
      popup.opener = null;
      doc.title = callbacks.current.title;
      const unmirror = mirrorAppearance(doc);
      const closeWindow = popup;
      closeWindow.addEventListener('pagehide', dock, { once: true });
      const unsub = window.piarc.onAppEvent((event) => {
        if (event.type !== 'toolWindow' || event.ticket !== ticket) return;
        if (event.state === 'closed') {
          dock();
          return;
        }
        doc.documentElement.toggleAttribute('data-tool-hidden', event.state === 'hidden');
        doc.dispatchEvent(new Event('visibilitychange'));
      });
      cleanup = () => {
        closeWindow.removeEventListener('pagehide', dock);
        unsub();
        unmirror();
      };
      const mount = doc.getElementById('tool-root');
      if (!mount) throw new Error('Missing tool window surface');
      mount.append(content);
      setNative({ ticket, popup, doc });
      popup.focus();
    };
    void open().catch((failure: unknown) => {
      if (!controller.signal.aborted) {
        report(failure);
        dock();
      }
    });
    return () => {
      controller.abort();
      cleanup?.();
      anchor.current?.append(content);
      if (popup && !popup.closed) popup.close();
      setNative(null);
      setPinned(false);
    };
  }, [content, detached, sessionId, panelId, report]);
  useEffect(() => {
    if (native) native.doc.title = title;
  }, [title, native]);

  return (
    <>
      <div ref={anchor} className="tool-surface-anchor" style={{ display: 'contents' }} />
      {createPortal(
        <SurfaceDocument.Provider value={native?.doc ?? document}>
          <Pinned.Provider
            value={
              native
                ? {
                    pinned,
                    toggle: () => {
                      const next = !pinned;
                      void window.piarc.pinToolWindow(native.ticket, next).then(() => {
                        setPinned(next);
                      }, report);
                    },
                  }
                : null
            }
          >
            {children}
            {native ? <TooltipLayer /> : null}
          </Pinned.Provider>
        </SurfaceDocument.Provider>,
        content,
      )}
    </>
  );
}
