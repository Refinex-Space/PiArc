import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../app/app-context.js';
import { Button } from '../app/Button.js';
import { reason } from '../shell/errors.js';

export function DocumentFrame({
  sessionId,
  path,
  kind,
  text,
  children,
}: {
  sessionId: string;
  path: string;
  kind: 'html' | 'pdf' | 'image' | 'audio' | 'video';
  text?: string;
  children?: ReactNode;
}) {
  const t = useT(),
    [run, setRun] = useState(false),
    [attempt, setAttempt] = useState(0);
  const [url, setUrl] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true,
      registered = '';
    const release = (token: string) => {
      void window.piarc
        .projectFilePreview(sessionId, path, 'release', token)
        .catch((e: unknown) => {
          console.warn('[files] preview release failed', e);
        });
    };
    setUrl('');
    setError('');
    void window.piarc
      .projectFilePreview(
        sessionId,
        path,
        kind === 'html' ? (run ? 'interactive' : 'static') : 'media',
      )
      .then((next) => {
        if (live) {
          registered = next;
          setUrl(next);
        } else release(next);
      })
      .catch((e: unknown) => {
        if (live) setError(reason(e));
      });
    return () => {
      live = false;
      if (registered) release(registered);
    };
  }, [kind, path, run, sessionId, text, attempt]);
  return (
    <div className="files-document-frame">
      {kind === 'html' && (
        <Button
          variant="ghost"
          onClick={() => {
            setRun(!run);
          }}
        >
          {t(run ? 'files.static' : 'files.interactive')}
        </Button>
      )}
      {error ? (
        <>
          <p role="status">{t('files.failed', { reason: error })}</p>
          <Button
            onClick={() => {
              setAttempt((n) => n + 1);
            }}
          >
            {t('files.retry')}
          </Button>
          {!run && children}
        </>
      ) : url ? (
        kind === 'html' ? (
          <iframe
            title={path}
            src={url}
            sandbox={run ? 'allow-scripts' : ''}
            referrerPolicy="no-referrer"
          />
        ) : kind === 'pdf' ? (
          <iframe title={path} src={url} referrerPolicy="no-referrer" />
        ) : kind === 'image' ? (
          <img
            alt={path}
            src={url}
            onError={() => {
              setError(t('files.decode'));
            }}
          />
        ) : kind === 'video' ? (
          <video
            controls
            preload="metadata"
            src={url}
            aria-label={path}
            onError={() => {
              setError(t('files.decode'));
            }}
          />
        ) : (
          <audio
            controls
            preload="metadata"
            src={url}
            aria-label={path}
            onError={() => {
              setError(t('files.decode'));
            }}
          />
        )
      ) : null}
    </div>
  );
}
