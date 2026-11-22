// A changed file's hunks in the Changes panel (T28): line numbers, signs and syntax colors from
// the highlight worker (each hunk's lines highlighted as one block in the file's language), and a
// discard button per hunk. Lines are text nodes and tokens; nothing is parsed as HTML. In the
// panel the line numbers are buttons that start a comment on that side (T42, `DiffComments.tsx`);
// Shift+click stretches the comment being started to a range.
import type { ChangesFile, DiffHunk } from '@piarc/protocol';
import { Fragment, useEffect, useState } from 'react';

import { useT } from '../app/app-context.js';
import { Token } from '../transcript/highlight/CodeBlock.js';
import { revealBidi } from '../transcript/reveal.js';
import { DiffSign } from '../transcript/rows/tools.js';
import type { HighlightClient } from '../transcript/highlight/highlight-client.js';
import type { HighlightLines } from '../transcript/highlight/protocol.js';
import { useDarkScheme } from '../transcript/use-color-scheme.js';
import type { Side } from './comments.js';
import { CommentEditorRow, CommentRow, useDiffComments } from './DiffComments.js';

/** The highlighted lines of `code`, once the worker answered (`null`: plain). */
function useHighlighted(
  highlight: HighlightClient,
  language: string | null,
  code: string,
): HighlightLines | null | undefined {
  const [result, setResult] = useState<{ code: string; lines: HighlightLines | null }>();
  useEffect(() => {
    let active = true;
    highlight.highlight(language, code).then(
      (lines) => {
        if (active) setResult({ code, lines });
      },
      (error: unknown) => {
        console.error('[changes] highlighting failed', error);
      },
    );
    return () => {
      active = false;
    };
  }, [highlight, language, code]);
  if (result?.code === code) return result.lines;
  return highlight.peek(language, code);
}

/** A line number; a button that starts a comment when the panel takes comments. */
function Gutter({
  file,
  side,
  line,
}: {
  readonly file: ChangesFile | undefined;
  readonly side: Side;
  readonly line: number | undefined;
}) {
  const t = useT();
  const comments = useDiffComments();
  if (line === undefined) return <td className="diff-gutter" />;
  if (file === undefined || comments === undefined) {
    return <td className="diff-gutter">{line}</td>;
  }
  return (
    <td className="diff-gutter">
      <button
        type="button"
        className="diff-gutter-button"
        data-testid="changes-comment-add"
        data-side={side}
        data-line={line}
        aria-label={t('changes.comment.add', {
          line,
          side: t(side === 'new' ? 'changes.comment.new' : 'changes.comment.old'),
        })}
        onClick={(event) => {
          comments.start(file, side, line, event.shiftKey);
        }}
      >
        {line}
      </button>
    </td>
  );
}

function Hunk({
  hunk,
  index,
  language,
  highlight,
  onDiscard,
  busy,
  file,
}: {
  readonly hunk: DiffHunk;
  readonly index: number;
  readonly file: ChangesFile | undefined;
  readonly language: string | null;
  readonly highlight: HighlightClient;
  readonly onDiscard: ((index: number) => void) | undefined;
  readonly busy: boolean;
}) {
  const t = useT();
  const dark = useDarkScheme();
  const comments = useDiffComments();
  const lines = useHighlighted(highlight, language, hunk.lines.map((l) => l.text).join('\n'));
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return (
    <tbody className="diff-hunk" data-testid="changes-hunk" data-index={index}>
      <tr className="diff-hunk-head">
        <td colSpan={3}>
          <span className="changes-hunk-range">
            @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          </span>
          {onDiscard === undefined ? null : (
            <button
              type="button"
              className="row-action changes-hunk-discard"
              data-testid="changes-discard-hunk"
              disabled={busy}
              onClick={() => {
                onDiscard(index);
              }}
            >
              {t('changes.discardHunk')}
            </button>
          )}
        </td>
      </tr>
      {hunk.lines.map((line, at) => {
        const old = line.kind === 'added' ? undefined : oldLine++;
        const now = line.kind === 'removed' ? undefined : newLine++;
        const tokens = lines?.[at];
        const ends = (side: Side, n: number | undefined) =>
          n !== undefined && file !== undefined
            ? (c: { path: string; side: Side; end: number }) =>
                c.path === file.label && c.side === side && c.end === n
            : () => false;
        const endsHere = (c: { path: string; side: Side; end: number }) =>
          ends('old', old)(c) || ends('new', now)(c);
        const draft = comments?.draft;
        const below = (comments?.comments ?? []).filter((c) => c.stale !== true && endsHere(c));
        return (
          <Fragment key={at}>
            <tr className={`diff-line is-${line.kind}`} data-kind={line.kind}>
              <Gutter file={file} side="old" line={old} />
              <Gutter file={file} side="new" line={now} />
              <td className="diff-text">
                <DiffSign kind={line.kind} />
                {tokens === undefined
                  ? revealBidi(line.text)
                  : tokens.map((token, i) => <Token key={i} token={token} dark={dark} />)}
              </td>
            </tr>
            {below.map((c) =>
              draft?.id === c.id && file !== undefined ? (
                <CommentEditorRow key={c.id} file={file} />
              ) : (
                <CommentRow key={c.id} comment={c} />
              ),
            )}
            {draft !== undefined &&
            draft.id === undefined &&
            file !== undefined &&
            endsHere(draft) ? (
              <CommentEditorRow file={file} />
            ) : null}
          </Fragment>
        );
      })}
    </tbody>
  );
}

export function DiffBody({
  hunks,
  language,
  highlight,
  onDiscard,
  busy,
  file,
}: {
  readonly hunks: readonly DiffHunk[];
  readonly language: string | null;
  readonly highlight: HighlightClient;
  /** Discards hunk `index`; absent when hunks cannot be discarded. */
  readonly onDiscard: ((index: number) => void) | undefined;
  readonly busy: boolean;
  /** The file the hunks belong to, when lines can take comments. */
  readonly file?: ChangesFile;
}) {
  return (
    <div className="diff changes-diff" data-testid="changes-diff" data-highlight={language ?? ''}>
      <table className="diff-table">
        {hunks.map((hunk, index) => (
          <Hunk
            key={`${String(hunk.newStart)}:${String(index)}`}
            hunk={hunk}
            index={index}
            language={language}
            highlight={highlight}
            onDiscard={onDiscard}
            busy={busy}
            file={file}
          />
        ))}
      </table>
    </div>
  );
}
