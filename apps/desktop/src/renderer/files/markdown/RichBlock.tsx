import { useEffect, useRef, useState } from 'react';
import { useT } from '../../app/app-context.js';
import { useSurfaceDocument } from '../../app/surface-document.js';
import { useDarkScheme } from '../../transcript/use-color-scheme.js';
import { MediaTrigger } from './MediaTrigger.js';
import { drawDiagram, type DiagramImage } from './diagram-client.js';
export function MarkdownMath({ source, inline }: { source: string; inline: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let live = true;
    const node = ref.current;
    if (!node) return;
    node.textContent = source;
    if (source.length <= 8192)
      void import('katex')
        .then(({ default: katex }) => {
          if (live) {
            katex.render(source, node, {
              displayMode: !inline,
              output: 'mathml',
              trust: false,
              throwOnError: false,
              maxExpand: 500,
              maxSize: 20,
            });
          }
        })
        .catch((error: unknown) => {
          if (live) {
            node.title = error instanceof Error ? error.message : String(error);
          }
        });
    return () => {
      live = false;
    };
  }, [source, inline]);
  return <span ref={ref} className={inline ? 'markdown-inline-math' : 'markdown-display-math'} />;
}
export function MarkdownDiagram({
  source,
  editing = false,
}: {
  source: string;
  editing?: boolean;
}) {
  const doc = useSurfaceDocument(),
    dark = useDarkScheme(),
    t = useT();
  const ref = useRef<HTMLElement>(null),
    [visible, setVisible] = useState(false);
  const [result, setResult] = useState<{
    source: string;
    dark: boolean;
    image?: DiagramImage;
    error?: string;
  }>();
  useEffect(() => {
    if (!ref.current || !doc.defaultView) return;
    const observer = new doc.defaultView.IntersectionObserver(
      ([item]) => {
        if (item?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '240px' },
    );
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
    };
  }, [doc]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    // Typing in a live fence may replace the entire CM widget. Debounce even a first
    // draw so unmounted source revisions never enter the shared drawing queue.
    const timer = setTimeout(() => {
      void drawDiagram(doc, source, dark, controller.signal).then(
        (image) => {
          if (!controller.signal.aborted) setResult({ source, dark, image });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setResult({
              source,
              dark,
              error: error instanceof Error ? error.message : String(error),
            });
        },
      );
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [source, dark, visible, doc]);
  const shown = result?.source === source && result.dark === dark ? result : undefined;
  return (
    <figure className="markdown-diagram" ref={ref} aria-label={t('files.md.diagram')}>
      {shown?.image ? (
        <MediaTrigger
          src={shown.image.url}
          natural={shown.image.size}
          label={t('files.md.diagram')}
          editing={editing}
          kind="diagram"
        />
      ) : (
        <>
          <pre>{source}</pre>
          {shown?.error && (
            <figcaption>{t('files.md.diagramError', { reason: shown.error })}</figcaption>
          )}
        </>
      )}
    </figure>
  );
}
export function markdownRichBlock(kind: 'math' | 'mermaid', source: string, inline: boolean) {
  return kind === 'math' ? (
    <MarkdownMath source={source} inline={inline} />
  ) : (
    <MarkdownDiagram source={source} />
  );
}

export function markdownEditingBlock(kind: 'math' | 'mermaid', source: string, inline: boolean) {
  return kind === 'mermaid' ? (
    <MarkdownDiagram source={source} editing />
  ) : (
    <MarkdownMath source={source} inline={inline} />
  );
}
