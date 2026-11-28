// The three-way merge view (design addendum M4): your side, the result and the incoming side in
// three columns, chunk by chunk. Changes made on one side only are taken as they are; each
// conflict is resolved with a side, both (in either order) or neither, or the result is edited
// by hand. F7 and Shift+F7 move between conflicts. Applying writes the result over the file the
// view read (Core refuses if it changed since) and marks it resolved; a result that still has
// conflicts or conflict markers asks first.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { useT } from '../../app/app-context.js';
import { Dialog } from '../../shell/Dialog.js';
import { revealBidi } from '../../transcript/reveal.js';
import { openMergeView, type GitActions } from './actions.js';
import {
  hasMarkers,
  merge3,
  resolvedLines,
  resultText,
  type MergeChunk,
  type Resolution,
} from './merge3.js';
import { conflictSidesOf, gitCall, type ConflictSides } from './protocol.js';

/** Unchanged stretches longer than this show their ends only. */
const FOLD = 8;
const EDGE = 3;

function Lines({
  lines,
  fold = false,
}: {
  readonly lines: readonly string[];
  readonly fold?: boolean;
}) {
  const t = useT();
  if (fold && lines.length > FOLD) {
    const hidden = lines.length - EDGE * 2;
    return (
      <pre className="git-merge-lines">
        {revealBidi(lines.slice(0, EDGE).join(''))}
        <span className="git-merge-fold">{t('git.merge.folded', { count: hidden })}</span>
        {'\n'}
        {revealBidi(lines.slice(-EDGE).join(''))}
      </pre>
    );
  }
  return <pre className="git-merge-lines">{revealBidi(lines.join(''))}</pre>;
}

export function MergeView({
  sessionId,
  path,
  actions,
}: {
  readonly sessionId: string;
  readonly path: string;
  readonly actions: GitActions;
}) {
  const t = useT();
  const titleId = useId();
  const [sides, setSides] = useState<ConflictSides | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [resolutions, setResolutions] = useState<ReadonlyMap<number, Resolution>>(new Map());
  const [manual, setManual] = useState<string | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const [generation, setGeneration] = useState(0);
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const state = { live: true };
    setSides(undefined);
    setFailed(false);
    setResolutions(new Map());
    setManual(undefined);
    void gitCall(sessionId, { op: 'conflictSides', path }, conflictSidesOf).then((reply) => {
      if (!state.live) return;
      if (reply.ok) setSides(reply.value);
      else setFailed(true);
    });
    return () => {
      state.live = false;
    };
  }, [sessionId, path, generation]);
  const close = () => {
    openMergeView(sessionId, undefined);
  };
  const mergeable =
    sides !== undefined &&
    sides.binary !== true &&
    sides.tooLarge !== true &&
    sides.yours !== undefined &&
    sides.theirs !== undefined;
  const chunks: MergeChunk[] = useMemo(
    () => (mergeable ? merge3(sides.base ?? '', sides.yours ?? '', sides.theirs ?? '') : []),
    [mergeable, sides],
  );
  const labels = { yours: sides?.yoursLabel ?? '', theirs: sides?.theirsLabel ?? '' };
  const conflicts = chunks.flatMap((c, i) => (c.kind === 'conflict' ? [i] : []));
  const left = conflicts.filter((i) => !resolutions.has(i)).length;
  const result = manual ?? resultText(chunks, resolutions, labels);
  const resolve = (index: number, resolution: Resolution) => {
    setResolutions((old) => new Map(old).set(index, resolution));
  };
  const take = (side: 'yours' | 'theirs') => {
    void actions.run({ op: 'resolveConflict', path, take: side }).then((reply) => {
      if (reply.ok) close();
    });
  };
  const save = () => {
    if (sides === undefined) return;
    void actions
      .run(
        { op: 'saveResolution', path, content: result, expect: sides.resultHash },
        { done: t('git.merge.saved', { path }), handled: ['stale'] },
      )
      .then((reply) => {
        if (reply.ok) close();
        else if (reply.failure.kind === 'stale') setGeneration((g) => g + 1);
      });
  };
  const apply = () => {
    if (left > 0 || hasMarkers(result)) setAsking(true);
    else save();
  };
  const jump = (direction: 1 | -1) => {
    const rows = [...(grid.current?.querySelectorAll<HTMLElement>('[data-conflict]') ?? [])];
    if (rows.length === 0) return;
    const active = grid.current?.ownerDocument.activeElement ?? null;
    const at = rows.findIndex((row) => row.contains(active));
    const next = rows[(at + direction + rows.length) % rows.length];
    next?.scrollIntoView({ block: 'center' });
    next?.querySelector<HTMLElement>('button')?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'F7') {
      event.preventDefault();
      jump(event.shiftKey ? -1 : 1);
    }
  };

  const header = (
    <header className="git-merge-head">
      <h2 id={titleId} className="git-merge-title">
        {revealBidi(path)}
      </h2>
      {mergeable && manual === undefined ? (
        <span className="git-merge-left" data-testid="git-merge-left" role="status">
          {t('git.merge.left', { count: left })}
        </span>
      ) : null}
      <span className="git-merge-spacer" />
      {mergeable && manual === undefined && conflicts.length > 0 ? (
        <>
          <button
            type="button"
            className="button button-small"
            onClick={() => {
              jump(-1);
            }}
          >
            {t('git.merge.previous')}
          </button>
          <button
            type="button"
            className="button button-small"
            onClick={() => {
              jump(1);
            }}
          >
            {t('git.merge.next')}
          </button>
        </>
      ) : null}
      {mergeable ? (
        <button
          type="button"
          className="button button-small"
          aria-pressed={manual !== undefined}
          data-testid="git-merge-manual"
          onClick={() => {
            setManual(manual === undefined ? result : undefined);
          }}
        >
          {t('git.merge.editResult')}
        </button>
      ) : null}
      <button
        type="button"
        className="button button-small"
        data-testid="git-merge-cancel"
        onClick={close}
      >
        {t('dialog.cancel')}
      </button>
      {mergeable ? (
        <button
          type="button"
          className="button button-small button-primary"
          data-testid="git-merge-apply"
          onClick={apply}
        >
          {t('git.merge.apply')}
        </button>
      ) : null}
    </header>
  );

  const body = (() => {
    if (failed) {
      return (
        <p className="git-note" role="alert">
          {t('git.merge.failed')}
        </p>
      );
    }
    if (sides === undefined) return <p className="git-note">{t('git.diff.loading')}</p>;
    if (!mergeable) {
      return (
        <div className="git-merge-whole" data-testid="git-merge-whole">
          <p>
            {sides.binary === true || sides.tooLarge === true
              ? t('git.merge.wholeOnly')
              : t('git.merge.deletedSide')}
          </p>
          <div className="git-detail-actions">
            <button
              type="button"
              className="button"
              data-testid="git-merge-take-yours"
              onClick={() => {
                take('yours');
              }}
            >
              {t('git.merge.takeYours', { label: revealBidi(labels.yours) })}
            </button>
            <button
              type="button"
              className="button"
              data-testid="git-merge-take-theirs"
              onClick={() => {
                take('theirs');
              }}
            >
              {t('git.merge.takeTheirs', { label: revealBidi(labels.theirs) })}
            </button>
          </div>
        </div>
      );
    }
    if (manual !== undefined) {
      return (
        <textarea
          className="git-merge-editor"
          aria-label={t('git.merge.result')}
          data-testid="git-merge-editor"
          spellCheck={false}
          value={manual}
          onChange={(event) => {
            setManual(event.target.value);
          }}
        />
      );
    }
    return (
      <div className="git-merge-grid" ref={grid} data-testid="git-merge-grid">
        <div className="git-merge-colhead">
          {t('git.merge.yours', { label: revealBidi(labels.yours) })}
        </div>
        <div className="git-merge-colhead">{t('git.merge.result')}</div>
        <div className="git-merge-colhead">
          {t('git.merge.theirs', { label: revealBidi(labels.theirs) })}
        </div>
        {chunks.map((chunk, index) => {
          if (chunk.kind === 'same') {
            return (
              <div key={index} className="git-merge-row is-same">
                <Lines lines={chunk.lines} fold />
                <Lines lines={chunk.lines} fold />
                <Lines lines={chunk.lines} fold />
              </div>
            );
          }
          if (chunk.kind !== 'conflict') {
            const yoursLines = chunk.kind === 'theirs' ? chunk.base : chunk.lines;
            const theirsLines = chunk.kind === 'yours' ? chunk.base : chunk.lines;
            return (
              <div
                key={index}
                className={`git-merge-row is-${chunk.kind}`}
                data-testid="git-merge-taken"
              >
                <Lines lines={yoursLines} />
                <Lines lines={chunk.lines} />
                <Lines lines={theirsLines} />
              </div>
            );
          }
          const chosen = resolutions.get(index);
          const lines = resolvedLines(chunk, chosen);
          return (
            <div
              key={index}
              className={`git-merge-row is-conflict${chosen === undefined ? '' : ' is-resolved'}`}
              data-conflict
              data-testid="git-merge-conflict"
            >
              <div className="git-merge-side">
                <Lines lines={chunk.yours} />
                <button
                  type="button"
                  className="button button-small"
                  aria-pressed={chosen === 'yours'}
                  data-testid="git-merge-use-yours"
                  onClick={() => {
                    resolve(index, 'yours');
                  }}
                >
                  {t('git.merge.useYours')}
                </button>
              </div>
              <div className="git-merge-side is-result">
                {lines === undefined ? (
                  <p className="git-merge-unresolved">{t('git.merge.unresolved')}</p>
                ) : (
                  <Lines lines={lines} />
                )}
                <div className="git-merge-both">
                  <button
                    type="button"
                    className="button button-small"
                    aria-pressed={chosen === 'yoursFirst'}
                    data-testid="git-merge-yours-first"
                    onClick={() => {
                      resolve(index, 'yoursFirst');
                    }}
                  >
                    {t('git.merge.yoursFirst')}
                  </button>
                  <button
                    type="button"
                    className="button button-small"
                    aria-pressed={chosen === 'theirsFirst'}
                    onClick={() => {
                      resolve(index, 'theirsFirst');
                    }}
                  >
                    {t('git.merge.theirsFirst')}
                  </button>
                  <button
                    type="button"
                    className="button button-small"
                    aria-pressed={chosen === 'neither'}
                    onClick={() => {
                      resolve(index, 'neither');
                    }}
                  >
                    {t('git.merge.neither')}
                  </button>
                </div>
              </div>
              <div className="git-merge-side">
                <Lines lines={chunk.theirs} />
                <button
                  type="button"
                  className="button button-small"
                  aria-pressed={chosen === 'theirs'}
                  data-testid="git-merge-use-theirs"
                  onClick={() => {
                    resolve(index, 'theirs');
                  }}
                >
                  {t('git.merge.useTheirs')}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  })();

  return (
    <section
      className="git-merge"
      aria-labelledby={titleId}
      data-testid="git-merge-view"
      onKeyDown={onKeyDown}
    >
      {header}
      {body}
      {!asking ? null : (
        <UnresolvedDialog
          left={left}
          onClose={() => {
            setAsking(false);
          }}
          onConfirm={() => {
            setAsking(false);
            save();
          }}
        />
      )}
    </section>
  );
}

function UnresolvedDialog({
  left,
  onClose,
  onConfirm,
}: {
  readonly left: number;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  const t = useT();
  const titleId = useId();
  return (
    <Dialog labelledBy={titleId} onCancel={onClose} testId="git-merge-unresolved-dialog">
      <h2 id={titleId} className="dialog-title">
        {t('git.merge.unresolvedTitle')}
      </h2>
      <p>{t('git.merge.unresolvedBody', { count: left })}</p>
      <div className="dialog-actions">
        <button type="button" className="button" data-autofocus onClick={onClose}>
          {t('dialog.cancel')}
        </button>
        <button
          type="button"
          className="button button-primary"
          data-testid="git-merge-unresolved-confirm"
          onClick={onConfirm}
        >
          {t('git.merge.applyAnyway')}
        </button>
      </div>
    </Dialog>
  );
}
