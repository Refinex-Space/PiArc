// Image files in a diff (design addendum H6): the old and the new picture side by side on a
// checkerboard, with their sizes. Bytes come from Core (`fileBlob`, at most 8 MiB) and are shown
// as `data:` URLs, which the CSP allows; an SVG in an `<img>` runs no script.
import { useEffect, useState } from 'react';

import { useApp } from '../../app/app-context.js';
import type { FileChange, Scope } from './protocol.js';
import { blobOf, commitDetailOf, gitCall, type Blob } from './protocol.js';

const TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

/** The image type of `path` by its extension, if it is one the panel shows. */
export function imageType(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? undefined : TYPES[path.slice(dot + 1).toLowerCase()];
}

/** A byte count in the app's language (B, kB, MB). */
function sizeText(
  format: { number(value: number, options?: Intl.NumberFormatOptions): string },
  bytes: number,
): string {
  if (bytes < 1024) return format.number(bytes, { style: 'unit', unit: 'byte' });
  const kb = bytes / 1024;
  return kb < 1024
    ? format.number(kb, { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 1 })
    : format.number(kb / 1024, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 });
}

type Side = { readonly blob: Blob; readonly size?: { w: number; h: number } } | 'none' | 'loading';

/** The revision of the old side: the commit's first parent, `HEAD`, or the merge base. */
async function beforeRev(
  sessionId: string,
  scope: Scope,
  mergeBase: string | undefined,
): Promise<string | undefined> {
  if (scope.kind === 'uncommitted') return 'HEAD';
  if (scope.kind === 'branch') return mergeBase;
  const reply = await gitCall(sessionId, { op: 'commitDetail', sha: scope.sha }, commitDetailOf);
  return reply.ok ? reply.value.parents[0] : undefined;
}

export function ImageDiff({
  sessionId,
  file,
  scope,
  mergeBase,
}: {
  readonly sessionId: string;
  readonly file: FileChange;
  readonly scope: Scope;
  readonly mergeBase?: string | undefined;
}) {
  const { t, format } = useApp();
  const [before, setBefore] = useState<Side>('loading');
  const [after, setAfter] = useState<Side>('loading');
  useEffect(() => {
    const state = { live: true };
    const fetch = async (source: Record<string, unknown>, path: string): Promise<Side> => {
      const reply = await gitCall(sessionId, { op: 'fileBlob', source, path }, blobOf);
      return reply.ok && (reply.value.data !== undefined || reply.value.tooLarge === true)
        ? { blob: reply.value }
        : 'none';
    };
    void (async () => {
      const added = file.status === 'added' || file.status === 'untracked';
      const old = added ? undefined : await beforeRev(sessionId, scope, mergeBase);
      const oldSide =
        old === undefined
          ? 'none'
          : await fetch({ kind: 'commit', rev: old }, file.oldPath ?? file.path);
      const newSide =
        file.status === 'deleted'
          ? 'none'
          : await fetch(
              scope.kind === 'commit' ? { kind: 'commit', rev: scope.sha } : { kind: 'worktree' },
              file.path,
            );
      if (!state.live) return;
      setBefore(oldSide);
      setAfter(newSide);
    })();
    return () => {
      state.live = false;
    };
  }, [sessionId, file, scope, mergeBase]);
  const type = imageType(file.path) ?? 'application/octet-stream';
  const pane = (side: Side, label: string, which: 'before' | 'after') => (
    <figure className="git-image-side" data-testid={`git-image-${which}`}>
      <figcaption className="git-image-caption">{label}</figcaption>
      {side === 'loading' ? (
        <p className="git-note">{t('git.diff.loading')}</p>
      ) : side === 'none' ? (
        <p className="git-note">{t('git.image.none')}</p>
      ) : side.blob.data === undefined ? (
        <p className="git-note">
          {t('git.image.tooLarge', { size: sizeText(format, side.blob.size) })}
        </p>
      ) : (
        <>
          <div className="git-image-frame">
            <img
              src={`data:${type};base64,${side.blob.data}`}
              alt={t('git.image.alt', { label, path: file.path })}
              onLoad={(event) => {
                const img = event.currentTarget;
                const next = { w: img.naturalWidth, h: img.naturalHeight };
                const set = which === 'before' ? setBefore : setAfter;
                set((old) => (typeof old === 'object' ? { ...old, size: next } : old));
              }}
            />
          </div>
          <p className="git-image-meta">
            {side.size === undefined ? '' : `${String(side.size.w)} × ${String(side.size.h)} · `}
            {sizeText(format, side.blob.size)}
          </p>
        </>
      )}
    </figure>
  );
  return (
    <div className="git-image-diff" data-testid="git-image-diff">
      {pane(before, t('git.image.before'), 'before')}
      {pane(after, t('git.image.after'), 'after')}
    </div>
  );
}
