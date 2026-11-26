// One changed file of a Git scope (ADR-0084): a sticky header (folding chevron, type icon,
// name and folder, labels, counts, "Open file", more actions) and the diff, unified or side by
// side, with changed words marked, unchanged runs between hunks that open 100 lines at a time,
// and line comments (T42). A file whose patch Core withheld loads when opened. Lines are text
// nodes and highlight tokens only.
import type { ChangesFile, DiffHunk, DiffLine, FileDiff } from '@piarc/protocol';
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useT } from '../../app/app-context.js';
import { IconButton } from '../../app/IconButton.js';
import { TreeTypeIcon } from '../../files/tree-row.js';
import { ChevronDownIcon, ExternalGlyph, MoreIcon } from '../../shell/icons.js';
import type { HighlightClient } from '../../transcript/highlight/highlight-client.js';
import type { HighlightToken } from '../../transcript/highlight/protocol.js';
import { revealBidi } from '../../transcript/reveal.js';
import { DiffSign } from '../../transcript/rows/tools.js';
import { useDarkScheme } from '../../transcript/use-color-scheme.js';
import type { Side } from '../comments.js';
import { Gutter, useHighlighted } from '../DiffBody.js';
import { CommentEditorRow, CommentRow, useDiffComments } from '../DiffComments.js';
import { languageOf } from '../language.js';
import { ImageDiff, imageType } from './ImageDiff.js';
import { changedWords, gapsOf, GAP_STEP, pairedLines, splitRows, type Gap } from './model.js';
import { fileChangeOf, gitCall, textOf, type FileChange, type Scope } from './protocol.js';

/** The file as the comment drafts know files (T42's `ChangesFile`). */
export function asChangesFile(file: FileChange, diff: FileDiff | undefined): ChangesFile {
  return {
    path: file.path,
    label: file.path,
    kind:
      file.status === 'added' || file.status === 'untracked'
        ? 'created'
        : file.status === 'deleted'
          ? 'deleted'
          : 'modified',
    version: '',
    added: file.added ?? 0,
    removed: file.removed ?? 0,
    ...(diff === undefined ? {} : { diff }),
  };
}

export interface DiffDisplay {
  readonly split: boolean;
  readonly wrap: boolean;
  readonly wordDiff: boolean;
  readonly hideWhitespace: boolean;
}

/** The text of a line: highlight tokens (or plain text) with changed words marked. */
function LineText({
  text,
  tokens,
  words,
  dark,
}: {
  readonly text: string;
  readonly tokens: readonly HighlightToken[] | undefined;
  readonly words: readonly [number, number][] | undefined;
  readonly dark: boolean;
}) {
  const pieces = tokens ?? [{ text, light: null, dark: null, fontStyle: 0 }];
  const out: ReactNode[] = [];
  let offset = 0;
  pieces.forEach((token, t) => {
    const color = dark ? token.dark : token.light;
    const style = color === null ? undefined : { color };
    const start = offset;
    const end = offset + token.text.length;
    offset = end;
    const cuts = new Set<number>([start, end]);
    for (const [s, e] of words ?? []) {
      if (s > start && s < end) cuts.add(s);
      if (e > start && e < end) cuts.add(e);
    }
    const sorted = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      const from = sorted[i] ?? start;
      const to = sorted[i + 1] ?? end;
      const piece = revealBidi(token.text.slice(from - start, to - start));
      const marked = (words ?? []).some(([s, e]) => from >= s && to <= e);
      const key = `${String(t)}:${String(from)}`;
      out.push(
        marked ? (
          <mark key={key} className="git-word" style={style}>
            {piece}
          </mark>
        ) : (
          <span key={key} style={style}>
            {piece}
          </span>
        ),
      );
    }
  });
  return <>{out}</>;
}

/** Words changed between each removed line and the added line it pairs with. */
function useWords(hunk: DiffHunk, enabled: boolean): Map<number, [number, number][]> {
  return useMemo(() => {
    const words = new Map<number, [number, number][]>();
    if (!enabled) return words;
    const pairs = pairedLines(hunk);
    for (const [index, other] of pairs) {
      const line = hunk.lines[index];
      const paired = hunk.lines[other];
      if (line?.kind !== 'removed' || paired === undefined) continue;
      const changed = changedWords(line.text, paired.text);
      if (changed === undefined) continue;
      words.set(index, changed.before);
      words.set(other, changed.after);
    }
    return words;
  }, [hunk, enabled]);
}

interface HunkProps {
  readonly hunk: DiffHunk;
  readonly index: number;
  readonly file: ChangesFile;
  readonly language: string | null;
  readonly highlight: HighlightClient;
  readonly display: DiffDisplay;
}

/** Comment rows that end at `old` or `new` on this line. */
function CommentsBelow({
  file,
  old,
  now,
  span,
}: {
  readonly file: ChangesFile;
  readonly old: number | undefined;
  readonly now: number | undefined;
  readonly span: number;
}) {
  const comments = useDiffComments();
  if (comments === undefined) return null;
  const endsHere = (c: { path: string; side: Side; end: number }) =>
    c.path === file.label &&
    ((c.side === 'old' && c.end === old) || (c.side === 'new' && c.end === now));
  const below = comments.comments.filter((c) => c.stale !== true && endsHere(c));
  const draft = comments.draft;
  return (
    <>
      {below.map((c) =>
        draft?.id === c.id ? (
          <CommentEditorRow key={c.id} file={file} span={span} />
        ) : (
          <CommentRow key={c.id} comment={c} span={span} />
        ),
      )}
      {draft !== undefined && draft.id === undefined && endsHere(draft) ? (
        <CommentEditorRow file={file} span={span} />
      ) : null}
    </>
  );
}

function UnifiedHunk({ hunk, index, file, language, highlight, display }: HunkProps) {
  const dark = useDarkScheme();
  const lines = useHighlighted(highlight, language, hunk.lines.map((l) => l.text).join('\n'));
  const words = useWords(hunk, display.wordDiff);
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return (
    <tbody className="git-hunk" data-testid="git-hunk" data-index={index}>
      {hunk.lines.map((line, at) => {
        const old = line.kind === 'added' ? undefined : oldLine++;
        const now = line.kind === 'removed' ? undefined : newLine++;
        return (
          <Fragment key={at}>
            <tr className={`git-line is-${line.kind}`} data-kind={line.kind}>
              <Gutter
                file={file}
                side={line.kind === 'removed' ? 'old' : 'new'}
                line={line.kind === 'removed' ? old : now}
              />
              <td className="git-text">
                <DiffSign kind={line.kind} />
                <LineText text={line.text} tokens={lines?.[at]} words={words.get(at)} dark={dark} />
              </td>
            </tr>
            <CommentsBelow file={file} old={old} now={now} span={2} />
          </Fragment>
        );
      })}
    </tbody>
  );
}

function SplitCell({
  side,
  entry,
  file,
  tokens,
  words,
  dark,
}: {
  readonly side: Side;
  readonly entry: { readonly line: DiffLine; readonly number: number } | undefined;
  readonly file: ChangesFile;
  readonly tokens: readonly HighlightToken[] | undefined;
  readonly words: readonly [number, number][] | undefined;
  readonly dark: boolean;
}) {
  if (entry === undefined) {
    return (
      <>
        <td className="diff-gutter is-empty" />
        <td className="git-text is-empty" />
      </>
    );
  }
  return (
    <>
      <Gutter file={file} side={side} line={entry.number} />
      <td className={`git-text is-${entry.line.kind}`}>
        <DiffSign kind={entry.line.kind} />
        <LineText text={entry.line.text} tokens={tokens} words={words} dark={dark} />
      </td>
    </>
  );
}

function SplitHunk({ hunk, index, file, language, highlight, display }: HunkProps) {
  const dark = useDarkScheme();
  const lines = useHighlighted(highlight, language, hunk.lines.map((l) => l.text).join('\n'));
  const words = useWords(hunk, display.wordDiff);
  const rows = useMemo(() => splitRows(hunk), [hunk]);
  return (
    <tbody className="git-hunk is-split" data-testid="git-hunk" data-index={index}>
      {rows.map((row, at) => (
        <Fragment key={at}>
          <tr className="git-line">
            <SplitCell
              side="old"
              entry={row.old}
              file={file}
              tokens={row.oldIndex === undefined ? undefined : lines?.[row.oldIndex]}
              words={row.oldIndex === undefined ? undefined : words.get(row.oldIndex)}
              dark={dark}
            />
            <SplitCell
              side="new"
              entry={row.new}
              file={file}
              tokens={row.newIndex === undefined ? undefined : lines?.[row.newIndex]}
              words={row.newIndex === undefined ? undefined : words.get(row.newIndex)}
              dark={dark}
            />
          </tr>
          <CommentsBelow file={file} old={row.old?.number} now={row.new?.number} span={4} />
        </Fragment>
      ))}
    </tbody>
  );
}

/** A run of unchanged lines: a separator that opens lines above, below or all. */
function GapRows({
  gap,
  text,
  shown,
  span,
  split,
  onShow,
}: {
  readonly gap: Gap;
  readonly text: readonly string[] | undefined;
  readonly shown: { readonly top: number; readonly bottom: number };
  readonly span: number;
  readonly split: boolean;
  readonly onShow: (top: number, bottom: number) => void;
}) {
  const t = useT();
  const total = gap.end - gap.start + 1;
  const hidden = total - shown.top - shown.bottom;
  const context = (from: number, to: number) =>
    text === undefined
      ? null
      : Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => {
          const n = from + i;
          const content = revealBidi(text[n - 1] ?? '');
          return split ? (
            <tr key={n} className="git-line is-context">
              <td className="diff-gutter">{n + gap.delta}</td>
              <td className="git-text">{content}</td>
              <td className="diff-gutter">{n}</td>
              <td className="git-text">{content}</td>
            </tr>
          ) : (
            <tr key={n} className="git-line is-context">
              <td className="diff-gutter">{n}</td>
              <td className="git-text">
                <span className="diff-sign" aria-hidden="true">
                  {' '}
                </span>
                {content}
              </td>
            </tr>
          );
        });
  return (
    <tbody className="git-gap" data-testid="git-gap">
      {context(gap.start, gap.start + shown.top - 1)}
      {hidden > 0 ? (
        <tr className="git-gap-row">
          <td colSpan={span}>
            <div className="git-gap-bar">
              {hidden <= GAP_STEP ? (
                <button
                  type="button"
                  className="git-gap-button"
                  onClick={() => {
                    onShow(shown.top + hidden, shown.bottom);
                  }}
                >
                  {t('git.diff.unchanged', { count: hidden })}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="git-gap-button"
                    aria-label={t('git.diff.expandUp', { count: GAP_STEP })}
                    onClick={() => {
                      onShow(shown.top + GAP_STEP, shown.bottom);
                    }}
                  >
                    ↓ {GAP_STEP}
                  </button>
                  <span className="git-gap-count">
                    {t('git.diff.unchanged', { count: hidden })}
                  </span>
                  <button
                    type="button"
                    className="git-gap-button"
                    aria-label={t('git.diff.expandDown', { count: GAP_STEP })}
                    onClick={() => {
                      onShow(shown.top, shown.bottom + GAP_STEP);
                    }}
                  >
                    ↑ {GAP_STEP}
                  </button>
                </>
              )}
            </div>
          </td>
        </tr>
      ) : null}
      {context(gap.end - shown.bottom + 1, gap.end)}
    </tbody>
  );
}

/** Labels of a file: new, deleted, renamed, binary, mode, whitespace only. */
/** A hunk under a header with its range and `actions` (the commit view's stage buttons). */
export function ActionHunk({
  hunk,
  index,
  file,
  highlight,
  display,
  actions,
}: Omit<HunkProps, 'language'> & { readonly actions: ReactNode }) {
  const Hunk = display.split ? SplitHunk : UnifiedHunk;
  return (
    <>
      <tbody className="git-hunk-head">
        <tr>
          <td colSpan={display.split ? 4 : 2}>
            <span className="git-hunk-range">
              @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </span>
            <span className="git-hunk-actions">{actions}</span>
          </td>
        </tr>
      </tbody>
      <Hunk
        hunk={hunk}
        index={index}
        file={file}
        language={languageOf(file.path)}
        highlight={highlight}
        display={display}
      />
    </>
  );
}

function labelsOf(
  file: FileChange,
  diff: FileDiff | undefined,
  hideWhitespace: boolean,
  t: ReturnType<typeof useT>,
): string[] {
  const labels: string[] = [];
  if (file.status === 'untracked') labels.push(t('git.label.untracked'));
  if (file.binary) labels.push(t('git.label.binary'));
  if (file.submodule) labels.push(t('git.label.submodule'));
  if (diff?.degraded === true) labels.push(t('git.label.tooLarge'));
  if (file.newMode === '100755' && file.oldMode !== undefined)
    labels.push(t('git.label.executable'));
  if (file.oldMode === '100755' && file.newMode === '100644')
    labels.push(t('git.label.notExecutable'));
  if (
    hideWhitespace &&
    diff?.hunks.length === 0 &&
    diff.degraded !== true &&
    file.status === 'modified' &&
    file.newMode === undefined
  ) {
    labels.push(t('git.label.whitespaceOnly'));
  }
  return labels;
}

export interface FileSectionProps {
  readonly sessionId: string;
  readonly file: FileChange;
  readonly scope: Scope;
  readonly display: DiffDisplay;
  readonly open: boolean;
  readonly current: boolean;
  readonly highlight: HighlightClient;
  readonly onToggle: () => void;
  readonly onOpenFile: ((path: string) => void) | undefined;
  readonly onMenu: (file: FileChange, x: number, y: number) => void;
  /** The branch scope's merge base: the old side of an image diff. */
  readonly mergeBase?: string | undefined;
}

/** One file of the diff list. */
export function FileSection(props: FileSectionProps) {
  const { sessionId, file, scope, display, open, current, highlight } = props;
  const t = useT();
  const [loaded, setLoaded] = useState<FileDiff | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState<string[] | undefined>(undefined);
  const [shown, setShown] = useState(new Map<number, { top: number; bottom: number }>());
  const diff = file.diff ?? loaded;
  const withheld = diff === undefined && !file.binary && !file.submodule;
  const image = file.binary && imageType(file.path) !== undefined;
  useEffect(() => {
    if (!open || !withheld || loading || loaded !== undefined) return;
    setLoading(true);
    const request = {
      op: 'fileDiff',
      scope,
      path: file.path,
      ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
      ...(display.hideWhitespace ? { ignoreWhitespace: true } : {}),
    };
    void gitCall(
      sessionId,
      request,
      (value) => fileChangeOf({ path: file.path, status: file.status, diff: value })?.diff,
    ).then((reply) => {
      setLoading(false);
      if (reply.ok) setLoaded(reply.value);
    });
  }, [open, withheld, loading, loaded, sessionId, scope, file, display.hideWhitespace]);
  const changes = useMemo(() => asChangesFile(file, diff), [file, diff]);
  const hunks = diff?.degraded === true ? [] : (diff?.hunks ?? []);
  const gaps = useMemo(() => gapsOf(hunks, text?.length), [hunks, text]);
  const language = languageOf(file.path);
  const labels = labelsOf(file, diff, display.hideWhitespace, t);
  const slash = file.path.lastIndexOf('/');
  const name = file.path.slice(slash + 1);
  const folder = slash === -1 ? '' : file.path.slice(0, slash);
  const span = display.split ? 4 : 2;
  const canExpand =
    file.status === 'modified' || file.status === 'renamed' || file.status === 'typeChanged';
  const needText = () => {
    if (text !== undefined || !canExpand) return;
    const source =
      scope.kind === 'commit' ? { kind: 'commit', rev: scope.sha } : { kind: 'worktree' };
    void gitCall(sessionId, { op: 'fileText', source, path: file.path }, textOf).then((reply) => {
      if (reply.ok && reply.value.text !== undefined) {
        const lines = reply.value.text.split('\n');
        if (lines.at(-1) === '') lines.pop();
        setText(lines);
      }
    });
  };
  const show = (gap: Gap, top: number, bottom: number) => {
    needText();
    setShown((current) => new Map(current).set(gap.before, { top, bottom }));
  };
  const gapAt = (before: number) => gaps.find((g) => g.before === before);
  const renderGap = (before: number) => {
    const gap = gapAt(before);
    if (gap === undefined) return null;
    return (
      <GapRows
        key={`gap-${String(before)}`}
        gap={gap}
        text={text}
        shown={shown.get(before) ?? { top: 0, bottom: 0 }}
        span={span}
        split={display.split}
        onShow={(top, bottom) => {
          show(gap, top, bottom);
        }}
      />
    );
  };
  const Hunk = display.split ? SplitHunk : UnifiedHunk;
  return (
    <section
      className="git-file"
      data-testid="git-file-section"
      data-path={file.path}
      data-current={current || undefined}
      aria-label={revealBidi(file.path)}
    >
      <header className="git-file-head">
        <button
          type="button"
          className="git-file-toggle"
          aria-expanded={open}
          aria-label={t('git.file.toggle', { path: revealBidi(file.path) })}
          disabled={diff === undefined && !withheld && !image}
          data-testid="git-file-toggle"
          onClick={props.onToggle}
        >
          <ChevronDownIcon />
        </button>
        <TreeTypeIcon name={name} directory={false} open={false} />
        <span
          className={`git-file-name is-${file.status}`}
          data-tooltip={
            file.oldPath === undefined
              ? undefined
              : `${revealBidi(file.oldPath)} → ${revealBidi(file.path)}`
          }
        >
          <span className="git-file-base">{revealBidi(name)}</span>
          {folder === '' ? null : <span className="git-file-folder">{revealBidi(folder)}</span>}
          {file.status === 'added' || file.status === 'untracked' ? (
            <span className="visually-hidden">{t('git.label.new')}</span>
          ) : null}
          {file.status === 'deleted' ? (
            <span className="visually-hidden">{t('git.label.deleted')}</span>
          ) : null}
        </span>
        {file.oldPath === undefined ? null : (
          <span className="git-file-label">
            {t('git.label.renamed', { path: revealBidi(file.oldPath) })}
          </span>
        )}
        {labels.map((label) => (
          <span key={label} className="git-file-label">
            {label}
          </span>
        ))}
        <span className="git-counts">
          {file.added === undefined ? null : (
            <>
              <span className="diff-added">+{file.added}</span>{' '}
              <span className="diff-removed">−{file.removed ?? 0}</span>
            </>
          )}
        </span>
        <span className="git-file-actions">
          {props.onOpenFile === undefined || file.status === 'deleted' ? null : (
            <IconButton
              label={t('git.file.open')}
              size="xs"
              className="git-file-open"
              onClick={() => {
                props.onOpenFile?.(file.path);
              }}
            >
              <ExternalGlyph />
            </IconButton>
          )}
          <IconButton
            label={t('git.file.more')}
            size="xs"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              props.onMenu(file, box.left, box.bottom + 4);
            }}
          >
            <MoreIcon />
          </IconButton>
        </span>
      </header>
      {open && image ? (
        <ImageDiff sessionId={sessionId} file={file} scope={scope} mergeBase={props.mergeBase} />
      ) : !open ? null : loading ? (
        <p className="git-note">{t('git.diff.loading')}</p>
      ) : diff?.degraded === true ? (
        <pre className="git-plain" data-testid="git-plain">
          {revealBidi(diff.unified)}
        </pre>
      ) : hunks.length === 0 ? null : (
        <div
          className={`git-diff${display.wrap ? ' is-wrapped' : ''}`}
          data-highlight={language ?? ''}
        >
          <table className={`git-table${display.split ? ' is-split' : ''}`} data-testid="git-diff">
            {/* Fixed layout takes its widths from here, not from a full-width first row. */}
            {display.split ? (
              <colgroup>
                <col className="git-col-gutter" />
                <col className="git-col-text" />
                <col className="git-col-gutter" />
                <col className="git-col-text" />
              </colgroup>
            ) : null}
            {hunks.map((hunk, index) => (
              <Fragment key={`${String(hunk.newStart)}:${String(index)}`}>
                {renderGap(index)}
                <Hunk
                  hunk={hunk}
                  index={index}
                  file={changes}
                  language={language}
                  highlight={highlight}
                  display={display}
                />
              </Fragment>
            ))}
            {renderGap(hunks.length)}
          </table>
          {canExpand && text === undefined ? (
            <button type="button" className="git-more-lines" onClick={needText}>
              {t('git.diff.showMore')}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
