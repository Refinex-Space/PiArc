// A ```mermaid fence in a reply (ADR-0080): drawn in the isolated diagram document Files uses and
// shown only as an image (the SVG never enters this page's DOM). While the fence streams it is a
// placeholder; once complete the head offers the source, copying, downloading as SVG or PNG, and
// the image opens in the media viewer. A diagram that cannot be drawn shows its source with the
// reason and a button that asks the model to fix it.
import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useT } from '../../app/app-context.js';
import { IconButton } from '../../app/IconButton.js';
import { useSurfaceDocument } from '../../app/surface-document.js';
import { drawDiagram, type DiagramImage } from '../../files/markdown/diagram-client.js';
import { MediaTrigger } from '../../files/markdown/MediaTrigger.js';
import { MenuPopup, useMenu } from '../../shell/Menu.js';
import {
  CheckGlyph,
  CodeGlyph,
  DownloadGlyph,
  FixGlyph,
  PreviewGlyph,
  WarningGlyph,
} from '../../shell/icons.js';
import { CodeBlock } from '../highlight/CodeBlock.js';
import { useRowCommitted } from '../rows/list-actions.js';
import { COPIED_MS, CopyIconButton } from '../rows/parts.js';
import { useTranscriptView } from '../services.js';
import { useDarkScheme } from '../use-color-scheme.js';
import { reason } from '../../shell/errors.js';

/** A drawn image or the reason it could not be drawn, for one source and theme. */
interface Drawn {
  readonly source: string;
  readonly dark: boolean;
  readonly image?: DiagramImage;
  readonly error?: string;
}

const SVG_PREFIX = 'data:image/svg+xml;charset=utf-8,';

/** The SVG document of a drawn image. */
function svgBytes(image: DiagramImage): Uint8Array {
  return new TextEncoder().encode(decodeURIComponent(image.url.slice(SVG_PREFIX.length)));
}

/** The image at twice its size on the given background, as PNG bytes. */
async function pngBytes(
  doc: Document,
  image: DiagramImage,
  background: string,
): Promise<Uint8Array> {
  const picture = new (doc.defaultView ?? window).Image();
  picture.src = image.url;
  await picture.decode();
  const width = image.size?.width ?? (picture.naturalWidth || 640);
  const height = image.size?.height ?? (picture.naturalHeight || 480);
  const canvas = doc.createElement('canvas');
  canvas.width = Math.ceil(width * 2);
  canvas.height = Math.ceil(height * 2);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas unavailable');
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(picture, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
  if (blob === null) throw new Error('Could not encode the image');
  return new Uint8Array(await blob.arrayBuffer());
}

export const ChatDiagram = memo(function ChatDiagram({
  lang,
  source,
  complete,
}: {
  /** The fence's language as written (`mermaid`). */
  readonly lang: string;
  readonly source: string;
  readonly complete: boolean;
}) {
  const t = useT();
  const doc = useSurfaceDocument();
  const dark = useDarkScheme();
  const { actions } = useTranscriptView();
  const figure = useRef<HTMLElement>(null);
  const [shown, setShown] = useState<'preview' | 'source'>('preview');
  const [drawn, setDrawn] = useState<Drawn>();
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const menu = useMenu();
  useRowCommitted();

  useEffect(() => {
    if (!complete) return;
    const controller = new AbortController();
    drawDiagram(doc, source, dark, controller.signal).then(
      (image) => {
        if (!controller.signal.aborted) setDrawn({ source, dark, image });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setDrawn({ source, dark, error: reason(error) });
      },
    );
    return () => {
      controller.abort();
    };
  }, [doc, source, dark, complete]);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => {
      setSaved(false);
    }, COPIED_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [saved]);

  const current = drawn?.source === source && drawn.dark === dark ? drawn : undefined;
  const image = current?.image;
  const failed = current?.error;
  const state = !complete || current === undefined ? 'drawing' : image ? 'drawn' : 'failed';

  const save = async (kind: 'svg' | 'png') => {
    if (image === undefined) return;
    setSaveError(undefined);
    try {
      const background =
        figure.current === null
          ? ''
          : getComputedStyle(figure.current).getPropertyValue('--piarc-workbench-canvas').trim();
      const bytes = kind === 'svg' ? svgBytes(image) : await pngBytes(doc, image, background);
      if (await window.piarc.saveImage({ kind, name: 'diagram', bytes })) setSaved(true);
    } catch (error) {
      setSaveError(t('transcript.diagram.saveFailed', { reason: reason(error) }));
    }
  };

  return (
    <figure
      ref={figure}
      className="md-diagram"
      data-testid="md-diagram"
      data-state={state}
      aria-label={t('transcript.diagram.label')}
      aria-busy={state === 'drawing'}
    >
      <div className="md-diagram-head">
        <span className="md-diagram-lang" aria-hidden="true">
          {lang}
        </span>
        {complete ? (
          <span className="md-diagram-tools">
            {image === undefined ? null : (
              <IconButton
                size="xs"
                label={t(
                  shown === 'preview' ? 'transcript.diagram.source' : 'transcript.diagram.preview',
                )}
                aria-pressed={shown === 'source'}
                data-testid="diagram-toggle"
                onClick={() => {
                  setShown(shown === 'preview' ? 'source' : 'preview');
                }}
              >
                {shown === 'preview' ? <CodeGlyph /> : <PreviewGlyph />}
              </IconButton>
            )}
            <CopyIconButton
              label={t('transcript.diagram.copy')}
              text={() => source}
              testId="diagram-copy"
            />
            {image === undefined ? null : (
              <IconButton
                size="xs"
                label={saved ? t('transcript.diagram.saved') : t('transcript.diagram.download')}
                aria-haspopup="menu"
                aria-expanded={menu.open !== null}
                data-testid="diagram-download"
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  menu.openAt(box.left, box.bottom + 4, event.currentTarget);
                }}
              >
                {saved ? <CheckGlyph /> : <DownloadGlyph />}
              </IconButton>
            )}
            {failed === undefined || actions.prompt === undefined ? null : (
              <IconButton
                size="xs"
                className="md-diagram-fix"
                label={t('transcript.diagram.fix')}
                data-testid="diagram-fix"
                onClick={() => {
                  actions.prompt?.(t('transcript.diagram.fixPrompt', { reason: failed, source }));
                }}
              >
                <FixGlyph />
              </IconButton>
            )}
          </span>
        ) : null}
      </div>
      {failed === undefined ? null : (
        <p className="md-diagram-error" role="note" data-testid="diagram-error">
          <WarningGlyph />
          <span>{t('transcript.diagram.failed', { reason: failed })}</span>
        </p>
      )}
      {saveError === undefined ? null : (
        <p className="md-diagram-error" role="alert">
          <WarningGlyph />
          <span>{saveError}</span>
        </p>
      )}
      {image !== undefined && shown === 'preview' ? (
        <div className="md-diagram-body">
          <MediaTrigger
            src={image.url}
            natural={image.size}
            label={t('transcript.diagram.label')}
            kind="diagram"
          />
        </div>
      ) : image !== undefined || failed !== undefined ? (
        <CodeBlock lang={lang} code={source} complete />
      ) : (
        <div className="md-diagram-placeholder">
          <span className="visually-hidden">{t('transcript.diagram.drawing')}</span>
        </div>
      )}
      {/* Outside the row: the transcript scrolls and moves its rows, the menu stays put. */}
      {menu.open &&
        createPortal(
          <MenuPopup
            at={menu.open}
            label={t('transcript.diagram.download')}
            onClose={menu.close}
            items={[
              {
                id: 'svg',
                label: t('transcript.diagram.downloadSvg'),
                testId: 'diagram-download-svg',
                run: () => {
                  void save('svg');
                },
              },
              {
                id: 'png',
                label: t('transcript.diagram.downloadPng'),
                testId: 'diagram-download-png',
                run: () => {
                  void save('png');
                },
              },
            ]}
          />,
          doc.body,
        )}
    </figure>
  );
});
