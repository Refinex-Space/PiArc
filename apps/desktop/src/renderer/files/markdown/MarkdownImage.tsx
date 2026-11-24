import { useEffect, useRef, useState } from 'react';
import { useT } from '../../app/app-context.js';
import { MediaTrigger } from './MediaTrigger.js';
import { useSurfaceDocument } from '../../app/surface-document.js';
import { loadMarkdownImage } from '../markdown-images/use-markdown-images.js';
export function MarkdownImage({
  sessionId,
  path,
  source,
  alt,
  editing = false,
}: {
  sessionId: string;
  path: string;
  source: string;
  alt: string;
  editing?: boolean;
}) {
  const t = useT(),
    doc = useSurfaceDocument(),
    ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false),
    [sourceUrl, setUrl] = useState<{ source: string; url: string } | null>(null);
  const [held, setHeld] = useState(false),
    [failed, setFailed] = useState(false);
  const remote = /^https?:\/\//iu.test(source);
  useEffect(() => {
    const element = ref.current;
    if (!element || !doc.defaultView) return;
    const observer = new doc.defaultView.IntersectionObserver(
      ([entry]) => {
        setVisible(!!entry?.isIntersecting);
      },
      { rootMargin: '250px' },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [doc]);
  const needed = visible || held;
  useEffect(() => {
    if (!needed || remote) return;
    let used = true,
      release: (() => void) | undefined;
    setFailed(false);
    void loadMarkdownImage(sessionId, path, source).then(
      (image) => {
        if (!used) {
          image.release();
          return;
        }
        release = image.release;
        setUrl({ source, url: image.url });
      },
      () => {
        if (used) setFailed(true);
      },
    );
    return () => {
      used = false;
      release?.();
      setUrl(null);
    };
  }, [sessionId, path, source, remote, needed]);
  const src = sourceUrl?.source === source ? sourceUrl.url : undefined;
  const label = alt || (source.split('/').at(-1) ?? t('files.md.image'));
  if (remote)
    return (
      <a
        className="md-link"
        href={source}
        onClick={(e) => {
          e.preventDefault();
          void window.piarc.openExternal(source).catch(() => {
            setFailed(true);
          });
        }}
      >
        {failed ? t('files.md.imageMissing', { name: label }) : label}
      </a>
    );
  return (
    <span ref={ref} className="markdown-image">
      {src && !failed ? (
        <MediaTrigger
          kind="image"
          editing={editing}
          src={src}
          label={label}
          onOpenChange={setHeld}
          onError={() => {
            setFailed(true);
          }}
        />
      ) : (
        <span className="muted">
          {failed ? t('files.md.imageMissing', { name: label }) : label}
        </span>
      )}
    </span>
  );
}
