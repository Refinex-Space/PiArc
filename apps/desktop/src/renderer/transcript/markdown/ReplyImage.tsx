// Images in a session's transcript (ADR-0080). A local image of the session's project shows
// inline through the same short-lived preview address Files uses (Core checks the path; the
// page never reads the file), and opens in the media viewer. Remote images are not loaded: they
// show as a card with their host that opens in the browser after the native confirmation.
import { useContext, useEffect, useState } from 'react';

import { useT } from '../../app/app-context.js';
import { MediaTrigger } from '../../files/markdown/MediaTrigger.js';
import { projectPath } from '../../files/file-path.js';
import { ImageGlyph } from '../../shell/icons.js';
import { revealBidi } from '../reveal.js';
import { TranscriptContext } from '../services.js';

/** The file types shown as images. */
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/iu;

/** Whether `path` names an image file. */
export function isImagePath(path: string): boolean {
  return IMAGE_FILE.test(path.split(/[?#]/u, 1)[0] ?? path);
}

/** The project path of a local image reference, when it is one in this session's project. */
export function useProjectImage(reference: string | undefined): string | undefined {
  const files = useContext(TranscriptContext)?.fileLinks;
  if (reference === undefined || files?.root === undefined || !isImagePath(reference)) {
    return undefined;
  }
  return projectPath(decodeURI(reference), files.root, files.directory);
}

/** A project image, loaded through Files' preview address while it is shown. */
export function ProjectImage({
  path,
  alt,
  fallback,
}: {
  readonly path: string;
  readonly alt: string;
  /** What shows when the image cannot be loaded. */
  readonly fallback: React.ReactNode;
}) {
  const t = useT();
  const sessionId = useContext(TranscriptContext)?.fileLinks?.sessionId;
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (sessionId === undefined) return;
    let live = true;
    let registered = '';
    setUrl(undefined);
    setFailed(false);
    window.piarc.projectFilePreview(sessionId, path, 'media').then(
      (next) => {
        if (live) {
          registered = next;
          setUrl(next);
        } else {
          void window.piarc.projectFilePreview(sessionId, path, 'release', next).catch(() => {
            // Already released with the window's other previews.
          });
        }
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
      if (registered !== '') {
        void window.piarc.projectFilePreview(sessionId, path, 'release', registered).catch(() => {
          // Already released with the window's other previews.
        });
      }
    };
  }, [sessionId, path]);
  if (failed || sessionId === undefined) return fallback;
  const label = alt === '' ? (path.split('/').at(-1) ?? path) : alt;
  return (
    <span
      className="md-reply-image"
      data-testid="reply-image"
      data-state={url ? 'shown' : 'loading'}
    >
      {url === undefined ? (
        <span
          className="md-reply-image-pending"
          role="img"
          aria-label={t('markdown.image', { name: label })}
        />
      ) : (
        <MediaTrigger
          src={url}
          label={label}
          kind="image"
          onError={() => {
            setFailed(true);
          }}
        />
      )}
    </span>
  );
}

/** A remote image: not loaded; a card with its host that opens in the browser. */
export function RemoteImage({ href, alt }: { readonly href: string; readonly alt: string }) {
  const t = useT();
  let host = href;
  try {
    host = new URL(href).host;
  } catch {
    // Shown as written.
  }
  const name = alt === '' ? host : alt;
  return (
    <button
      type="button"
      className="md-remote-image"
      data-testid="remote-image"
      data-tooltip={t('markdown.remoteImage.tooltip', { host })}
      onClick={() => {
        void window.piarc.openExternal(href).catch((error: unknown) => {
          console.error('[transcript] cannot open the image link', error);
        });
      }}
    >
      <ImageGlyph />
      <span className="md-remote-image-text">
        <span className="md-remote-image-name">{revealBidi(name)}</span>
        <span className="md-remote-image-host">{revealBidi(host)}</span>
      </span>
    </button>
  );
}
