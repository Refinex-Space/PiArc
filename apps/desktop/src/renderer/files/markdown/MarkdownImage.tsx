import { createPortal } from 'react-dom';
import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../app/app-context.js';
import { Button } from '../../app/Button.js';
import { useSurfaceDocument } from '../../app/surface-document.js';
import { Dialog } from '../../shell/Dialog.js';
import { loadMarkdownImage } from '../markdown-images/use-markdown-images.js';
export function MarkdownImage({
  sessionId,
  path,
  source,
  alt,
}: {
  sessionId: string;
  path: string;
  source: string;
  alt: string;
}) {
  const t = useT(),
    doc = useSurfaceDocument(),
    ref = useRef<HTMLSpanElement>(null),
    title = useId();
  const [visible, setVisible] = useState(false),
    [sourceUrl, setUrl] = useState<{ source: string; url: string } | null>(null);
  const [zoom, setZoom] = useState<null | number>(null),
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
  const needed = visible || zoom !== null;
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
        <button
          type="button"
          className="markdown-image-open"
          title={t('files.md.zoomImage', { name: label })}
          onClick={() => {
            setZoom(1);
          }}
        >
          <img
            alt={label}
            src={src}
            onError={() => {
              setFailed(true);
            }}
          />
        </button>
      ) : (
        <span className="muted">
          {failed ? t('files.md.imageMissing', { name: label }) : label}
        </span>
      )}
      {zoom !== null &&
        src &&
        createPortal(
          <Dialog
            testId="markdown-image-dialog"
            labelledBy={title}
            wide
            onCancel={() => {
              setZoom(null);
            }}
            dismissOnBackdrop
          >
            <div className="markdown-image-tools">
              <h2 id={title}>{label}</h2>
              <Button
                onClick={() => {
                  setZoom(zoom === 1 ? 2 : 1);
                }}
              >
                {t(zoom === 1 ? 'files.md.zoomIn' : 'files.md.fit')}
              </Button>
              <Button
                onClick={() => {
                  setZoom(null);
                }}
              >
                {t('files.md.close')}
              </Button>
            </div>
            <div className="markdown-image-zoom" data-fit={zoom === 1}>
              <img alt={label} src={src} />
            </div>
          </Dialog>,
          doc.body,
        )}
    </span>
  );
}
