// The changed files column of the Changes view (ADR-0084): a tree (single-child folders merged)
// or a flat list, optionally grouped by kind, each row with its type icon and line counts; the
// branch's commits below when it is ahead of its base. Arrow keys move between rows, Enter opens
// the file in the diff, Shift+F10 opens the row menu. The divider resizes the column; dragging
// it far enough to the left hides the column.
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { useApp, useT } from '../../app/app-context.js';
import { TreeTypeIcon } from '../../files/tree-row.js';
import { ChevronDownIcon } from '../../shell/icons.js';
import { revealBidi } from '../../transcript/reveal.js';
import {
  buildTree,
  FILES_WIDTH,
  flatRows,
  groupByKind,
  treeRows,
  type FileKind,
  type FileRow,
  type ScopeChoice,
} from './model.js';
import type { CommitRow, FileChange } from './protocol.js';
import type { Load } from './state.js';
import type { Commits } from './protocol.js';

/** How many commits the section lists. */
const COMMITS_SHOWN = 100;

function Counts({ file }: { readonly file: FileChange }) {
  if (file.added === undefined) return null;
  return (
    <span className="git-row-counts">
      <span className="diff-added">+{file.added}</span>
      <span className="diff-removed">−{file.removed ?? 0}</span>
    </span>
  );
}

interface Props {
  readonly files: readonly FileChange[];
  readonly tree: boolean;
  readonly byKind: boolean;
  readonly current: string | undefined;
  readonly width: number;
  readonly onWidth: (width: number) => void;
  readonly onHide: () => void;
  readonly onSelect: (path: string, focusDiff: boolean) => void;
  readonly onOpen: ((path: string) => void) | undefined;
  readonly onMenu: (file: FileChange, x: number, y: number) => void;
  readonly commits: Load<Commits>;
  readonly commitsOpen: boolean;
  readonly onCommitsOpen: (open: boolean) => void;
  readonly scope: ScopeChoice;
  readonly dirty: boolean;
  readonly onScope: (choice: ScopeChoice) => void;
}

function rowsOf(
  files: readonly FileChange[],
  tree: boolean,
  collapsed: ReadonlySet<string>,
): FileRow[] {
  return tree ? treeRows(buildTree(files), collapsed) : flatRows(files);
}

export function FileColumn(props: Props) {
  const t = useT();
  const { files, tree, byKind, current } = props;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [closedKinds, setClosedKinds] = useState<ReadonlySet<FileKind>>(new Set());
  const list = useRef<HTMLDivElement>(null);
  const groups = useMemo(
    () => (byKind ? groupByKind(files) : [['source', [...files]] as [FileKind, FileChange[]]]),
    [files, byKind],
  );
  const toggleDir = (path: string) => {
    setCollapsed((old) => {
      const next = new Set(old);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])];
    // The tool may be popped out: its own document holds the focus.
    const focused = event.currentTarget.ownerDocument.activeElement;
    const at = rows.findIndex((r) => r === focused || r.contains(focused));
    const move = (to: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (target !== undefined) {
        event.preventDefault();
        target.focus();
      }
    };
    const row = rows[at];
    switch (event.key) {
      case 'ArrowDown':
        move(at + 1);
        return;
      case 'ArrowUp':
        move(at - 1);
        return;
      case 'Home':
        move(0);
        return;
      case 'End':
        move(rows.length - 1);
        return;
      case 'ArrowLeft':
      case 'ArrowRight': {
        const dir = row?.dataset.dir;
        if (dir === undefined) return;
        const open = row?.getAttribute('aria-expanded') === 'true';
        if ((event.key === 'ArrowLeft') === open) {
          event.preventDefault();
          toggleDir(dir);
        }
        return;
      }
      case 'Enter': {
        const path = row?.dataset.path;
        if (path === undefined) return;
        event.preventDefault();
        props.onSelect(path, true);
        return;
      }
      default:
        if (event.key === 'F10' && event.shiftKey && row?.dataset.path !== undefined) {
          const file = files.find((f) => f.path === row.dataset.path);
          const box = row.getBoundingClientRect();
          if (file !== undefined) {
            event.preventDefault();
            props.onMenu(file, box.left + 16, box.bottom);
          }
        }
    }
  };
  const renderRows = (rows: readonly FileRow[]) =>
    rows.map((row) => {
      if (row.type === 'dir') {
        return (
          <div
            key={`d:${row.path}`}
            className="git-row is-dir"
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={row.open}
            data-row=""
            data-dir={row.path}
            tabIndex={-1}
            style={{
              paddingInlineStart: `calc(var(--piarc-space-2) + ${String(row.depth)} * 14px)`,
            }}
            onClick={() => {
              toggleDir(row.path);
            }}
          >
            <span className="git-row-chevron" aria-hidden="true">
              <ChevronDownIcon size={12} />
            </span>
            <TreeTypeIcon name={row.name} directory open={row.open} />
            <span className="git-row-name">{revealBidi(row.name)}</span>
          </div>
        );
      }
      const file = row.file;
      const slash = file.path.lastIndexOf('/');
      const name = file.path.slice(slash + 1);
      const folder = slash === -1 ? '' : file.path.slice(0, slash);
      return (
        <div
          key={`f:${file.path}`}
          className={`git-row is-file is-${file.status}`}
          role="treeitem"
          aria-level={row.depth + 1}
          aria-selected={current === file.path}
          aria-current={current === file.path ? 'true' : undefined}
          data-row=""
          data-path={file.path}
          data-testid="git-file"
          tabIndex={current === file.path ? 0 : -1}
          draggable={false}
          style={{
            paddingInlineStart: `calc(var(--piarc-space-2) + ${String(row.depth)} * 14px + 14px)`,
          }}
          onClick={(event) => {
            if (
              (event.metaKey || event.ctrlKey) &&
              props.onOpen !== undefined &&
              file.status !== 'deleted'
            ) {
              props.onOpen(file.path);
              return;
            }
            props.onSelect(file.path, false);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            props.onMenu(file, event.clientX, event.clientY);
          }}
        >
          <TreeTypeIcon name={name} directory={false} open={false} />
          <span
            className="git-row-name"
            data-tooltip={
              file.oldPath === undefined
                ? undefined
                : `${revealBidi(file.oldPath)} → ${revealBidi(file.path)}`
            }
          >
            {revealBidi(name)}
            {!tree && folder !== '' ? (
              <span className="git-row-folder">{revealBidi(folder)}</span>
            ) : null}
          </span>
          <Counts file={file} />
        </div>
      );
    });
  return (
    <div className="git-files" style={{ width: props.width }} data-testid="git-files">
      <div
        className="git-files-scroll"
        ref={list}
        role="tree"
        aria-label={t('git.files.label')}
        onKeyDown={onKeyDown}
      >
        {groups.map(([kind, groupFiles], index) => {
          const open = !closedKinds.has(kind) || groupFiles.some((f) => f.path === current);
          return byKind ? (
            <div key={kind} className={`git-kind${index > 0 ? ' is-separated' : ''}`} role="group">
              <button
                type="button"
                className="git-kind-head"
                aria-expanded={open}
                onClick={() => {
                  setClosedKinds((old) => {
                    const next = new Set(old);
                    if (next.has(kind)) next.delete(kind);
                    else next.add(kind);
                    return next;
                  });
                }}
              >
                <ChevronDownIcon size={12} />
                <span>{t(`git.kind.${kind}`)}</span>
                <span className="git-kind-count">{groupFiles.length}</span>
              </button>
              {open ? renderRows(rowsOf(groupFiles, tree, collapsed)) : null}
            </div>
          ) : (
            <div key={kind} role="group">
              {renderRows(rowsOf(groupFiles, tree, collapsed))}
            </div>
          );
        })}
      </div>
      <CommitsSection {...props} />
      <Divider width={props.width} onWidth={props.onWidth} onHide={props.onHide} />
    </div>
  );
}

function CommitsSection(props: Props) {
  const { t, format } = useApp();
  const commits = props.commits.value?.commits ?? [];
  const total = props.commits.value?.total ?? 0;
  if (commits.length === 0) return null;
  const row = (choice: ScopeChoice, key: string, body: React.ReactNode, testId?: string) => {
    const selected =
      choice.kind === props.scope.kind &&
      (choice.kind !== 'commit' ||
        (props.scope.kind === 'commit' && props.scope.sha === choice.sha));
    return (
      <button
        key={key}
        type="button"
        className={`git-commit-row${selected ? ' is-selected' : ''}`}
        aria-pressed={selected}
        data-testid={testId}
        onClick={() => {
          props.onScope(choice);
        }}
      >
        {body}
      </button>
    );
  };
  const now = Date.now();
  const commitRow = (c: CommitRow) =>
    row(
      { kind: 'commit', sha: c.sha, short: c.short, subject: c.subject },
      c.sha,
      <>
        <span className="git-commit-subject">
          {revealBidi(c.subject === '' ? t('git.commits.noMessage') : c.subject)}
        </span>
        <span className="git-commit-meta">
          {c.short} · {revealBidi(c.author)} · {format.relative(c.time * 1000, now)}
        </span>
      </>,
      'git-commit-row',
    );
  return (
    <section className="git-commits" aria-label={t('git.commits.title', { count: total })}>
      <button
        type="button"
        className="git-commits-head"
        aria-expanded={props.commitsOpen}
        onClick={() => {
          props.onCommitsOpen(!props.commitsOpen);
        }}
      >
        <ChevronDownIcon size={12} />
        <span>{t('git.commits.title', { count: total })}</span>
      </button>
      {!props.commitsOpen ? null : (
        <div className="git-commits-list">
          {row(
            { kind: 'branch' },
            'all',
            <span className="git-commit-subject">{t('git.scope.all')}</span>,
          )}
          {props.dirty
            ? row(
                { kind: 'uncommitted' },
                'uncommitted',
                <span className="git-commit-subject">{t('git.scope.uncommitted')}</span>,
              )
            : null}
          {commits.slice(0, COMMITS_SHOWN).map(commitRow)}
          {total > COMMITS_SHOWN ? (
            <p className="git-note">{t('git.commits.more', { count: total - COMMITS_SHOWN })}</p>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** A column's width bounds; dragging below `hideBelow` hides the column. */
export interface ColumnBounds {
  readonly min: number;
  readonly max: number;
  readonly initial: number;
  readonly hideBelow?: number | undefined;
}

/** A column's resize handle: drag, arrow keys, Home/End, double click to reset. */
export function Divider({
  width,
  onWidth,
  onHide,
  bounds = FILES_WIDTH,
  label,
  testId = 'git-files-divider',
}: {
  readonly width: number;
  readonly onWidth: (width: number) => void;
  readonly onHide?: (() => void) | undefined;
  readonly bounds?: ColumnBounds | undefined;
  readonly label?: string | undefined;
  readonly testId?: string | undefined;
}) {
  const t = useT();
  const clamp = (w: number) => Math.round(Math.min(bounds.max, Math.max(bounds.min, w)));
  const start = useRef<{ x: number; width: number } | undefined>(undefined);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    if (from === undefined) return;
    const next = from.width + event.clientX - from.x;
    if (onHide !== undefined && bounds.hideBelow !== undefined && next < bounds.hideBelow) {
      start.current = undefined;
      onHide();
      return;
    }
    onWidth(clamp(next));
  };
  return (
    <div
      className="git-files-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={label ?? t('git.files.resize')}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={width}
      tabIndex={0}
      data-testid={testId}
      data-tooltip={t('git.files.resizeHint')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        start.current = undefined;
      }}
      onDoubleClick={() => {
        onWidth(bounds.initial);
      }}
      onKeyDown={(event) => {
        const step = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0;
        if (step !== 0) {
          event.preventDefault();
          onWidth(clamp(width + step));
        } else if (event.key === 'Home') {
          event.preventDefault();
          onWidth(bounds.min);
        } else if (event.key === 'End') {
          event.preventDefault();
          onWidth(bounds.max);
        }
      }}
    />
  );
}
