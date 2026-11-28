// A context menu in source mode may not have a rendered thumbnail. Resolve that exact
// file resource or fenced diagram through the same owner as the reading pane.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useSurfaceDocument } from '../../app/surface-document.js';
import { useT } from '../../app/app-context.js';
import { useUi } from '../../shell/ui.js';
import { reason } from '../../shell/errors.js';
import { useDarkScheme } from '../../transcript/use-color-scheme.js';
import { loadMarkdownImage } from '../markdown-images/use-markdown-images.js';
import { drawDiagram } from './diagram-client.js';
import { MediaViewer } from './MediaViewer.js';
import { bindMediaContext, type SourceMedia } from './media-context-item.js';
import type { MediaSize } from './media-camera.js';
interface VisibleMedia {
  kind: SourceMedia['kind'];
  src: string;
  name: string;
  natural?: MediaSize;
  restore: () => void;
}
export function MarkdownMediaContext({
  root,
  sessionId,
  path,
  text,
  visible,
}: {
  root: RefObject<HTMLDivElement | null>;
  sessionId: string;
  path: string;
  text: string;
  visible: boolean;
}) {
  const t = useT(),
    ui = useUi(),
    owner = useSurfaceDocument(),
    dark = useDarkScheme();
  const [opened, setOpened] = useState<VisibleMedia | null>(null);
  const cancel = useRef<() => void>(() => undefined),
    toast = useRef(ui.addToast);
  toast.current = ui.addToast;
  useEffect(() => {
    setOpened(null);
    if (!root.current || !visible) return;
    const unregister = bindMediaContext(root.current, (item, restore) => {
      cancel.current();
      setOpened(null);
      const abort = new AbortController();
      let release: (() => void) | undefined;
      cancel.current = () => {
        abort.abort();
        release?.();
        release = undefined;
      };
      const load = async () => {
        if (item.kind === 'diagram') {
          const diagram = await drawDiagram(owner, item.source, dark, abort.signal);
          if (!abort.signal.aborted)
            setOpened({
              kind: item.kind,
              src: diagram.url,
              name: t('files.md.diagram'),
              ...(diagram.size ? { natural: diagram.size } : {}),
              restore,
            });
        } else {
          const resource = await loadMarkdownImage(sessionId, path, item.source);
          if (abort.signal.aborted) {
            resource.release();
            return;
          }
          release = resource.release;
          setOpened({
            kind: item.kind,
            src: resource.url,
            name: item.label || item.source,
            restore,
          });
        }
      };
      void load().catch((e: unknown) => {
        if (!abort.signal.aborted)
          toast.current({ sessionId, text: t('files.failed', { reason: reason(e) }) });
      });
    });
    return () => {
      cancel.current();
      unregister();
    };
  }, [root, sessionId, path, text, visible, dark, owner, t]);
  if (!visible || !opened) return null;
  return (
    <MediaViewer
      src={opened.src}
      label={opened.name}
      kind={opened.kind}
      {...(opened.natural ? { natural: opened.natural } : {})}
      onClose={() => {
        cancel.current();
        setOpened(null);
        owner.defaultView?.requestAnimationFrame(opened.restore);
      }}
    />
  );
}
