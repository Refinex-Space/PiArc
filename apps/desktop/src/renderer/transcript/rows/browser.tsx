// A `Browser` call (ADR-0089, design addendum B2.7.1): the label the model gave the run, then,
// opened, the script, the hosts the browser kept its pages from, what it printed and the
// screenshots it took (ADR-0093). The screenshots are the session's blobs, shown through
// short-lived preview URLs the main process grants to this page; a click enlarges one.
import { useContext, useEffect, useState } from 'react';

import type { BrowserItemImage, Item } from '@piarc/protocol';

import { useT } from '../../app/app-context.js';
import { MediaTrigger } from '../../files/markdown/MediaTrigger.js';
import { revealBidi } from '../reveal.js';
import { TranscriptContext, useExpanded } from '../services.js';
import { CommandText, StepRow, type StepState } from './parts.js';
import { ReviewNote } from './review.js';

type BrowserItem = Extract<Item, { type: 'browser' }>;

/** One screenshot: a preview URL while the row shows it. */
function Shot({
  sessionId,
  image,
  label,
}: {
  readonly sessionId: string;
  readonly image: BrowserItemImage;
  readonly label: string;
}) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let granted = '';
    setUrl(undefined);
    setFailed(false);
    window.piarc.sessionImage(sessionId, image.blob).then(
      (next) => {
        if (live) {
          granted = next;
          setUrl(next);
        } else {
          void window.piarc.sessionImage(sessionId, image.blob, next).catch(() => {
            // Already released with the page's other previews.
          });
        }
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
      if (granted !== '') {
        void window.piarc.sessionImage(sessionId, image.blob, granted).catch(() => {
          // Already released with the page's other previews.
        });
      }
    };
  }, [sessionId, image.blob]);
  if (failed) return null;
  return (
    <span
      className="browser-run-shot"
      data-testid="browser-shot"
      data-state={url === undefined ? 'loading' : 'shown'}
      style={{ aspectRatio: `${String(image.width)} / ${String(image.height)}` }}
    >
      {url !== undefined && (
        <MediaTrigger
          src={url}
          label={label}
          kind="image"
          natural={{ width: image.width, height: image.height }}
          onError={() => {
            setFailed(true);
          }}
        />
      )}
    </span>
  );
}

export function BrowserCard({ id, item }: { readonly id: string; readonly item: BrowserItem }) {
  const t = useT();
  const sessionId = useContext(TranscriptContext)?.fileLinks?.sessionId;
  const [open, setOpen] = useExpanded(id, false);
  const images = item.images ?? [];
  const blocked = item.blockedHosts ?? [];
  const failed = item.status === 'failed' || item.errorCode != null;
  const state: StepState = item.status === 'inProgress' ? 'busy' : failed ? 'failed' : 'done';
  const label = item.description ?? t('transcript.browser.default');
  const script = typeof item.arguments.script === 'string' ? item.arguments.script : '';
  return (
    <div
      className={`row row-browser is-${item.status}`}
      data-testid="browser-card"
      data-row-id={id}
      data-status={item.status}
    >
      <StepRow
        verb={t('transcript.browser.verb')}
        meta={<span className="browser-run-label">{revealBidi(label)}</span>}
        metaTitle={label}
        state={state}
        outcome={failed ? t('transcript.tool.status.failed') : undefined}
        trail={
          images.length === 0 ? undefined : (
            <span className="browser-run-shots">
              {t('transcript.browser.shots', { count: images.length })}
            </span>
          )
        }
        expanded={open}
        onToggle={() => {
          setOpen(!open);
        }}
      >
        <ReviewNote review={item.review} />
        {script !== '' && (
          <pre
            className="bash-command browser-run-script"
            aria-label={t('transcript.browser.script')}
          >
            <CommandText text={revealBidi(script)} />
          </pre>
        )}
        {blocked.length > 0 && (
          <div className="step-note browser-run-blocked" data-testid="browser-blocked">
            {t('transcript.browser.blocked', { hosts: revealBidi(blocked.join(', ')) })}
          </div>
        )}
        {item.output != null && item.output !== '' && (
          <pre
            className={`tool-output${failed ? ' is-failed' : ''}`}
            aria-label={t('transcript.browser.output')}
          >
            {revealBidi(item.output)}
          </pre>
        )}
      </StepRow>
      {sessionId !== undefined && images.length > 0 && (
        <div className="browser-shots" role="list" aria-label={t('transcript.browser.shotsLabel')}>
          {images.map((image, n) => (
            <span role="listitem" key={`${String(n)}:${image.blob}`}>
              <Shot
                sessionId={sessionId}
                image={image}
                label={t('transcript.browser.shot', { n: n + 1 })}
              />
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
