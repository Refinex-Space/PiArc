import { useEffect, useState, type CSSProperties, type DragEvent, type MouseEvent } from 'react';
import { useT } from '../app/app-context.js';
import { ChevronDownIcon, ChevronRightIcon, FileIcon, FolderIcon } from '../shell/icons.js';
import { revealBidi } from '../transcript/reveal.js';
import { iconSchemeFromMode, materialIconUrl, type IconScheme } from './material-icons.js';
import type { TreeRow } from './tree-model.js';

let iconScheme: IconScheme = 'base';
const schemeListeners = new Set<() => void>();
let schemeWatching = false;

function currentIconScheme(): IconScheme {
  if (typeof document === 'undefined') return 'base';
  return iconSchemeFromMode(document.documentElement.dataset.colorMode);
}

function watchIconScheme() {
  if (schemeWatching || typeof document === 'undefined') return;
  schemeWatching = true;
  iconScheme = currentIconScheme();
  const observer = new MutationObserver(() => {
    const next = currentIconScheme();
    if (next === iconScheme) return;
    iconScheme = next;
    for (const listener of schemeListeners) listener();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-color-mode'],
  });
}

function useIconScheme(): IconScheme {
  const [scheme, setScheme] = useState(currentIconScheme);
  useEffect(() => {
    watchIconScheme();
    setScheme(iconScheme);
    const listener = () => {
      setScheme(iconScheme);
    };
    schemeListeners.add(listener);
    return () => {
      schemeListeners.delete(listener);
    };
  }, []);
  return scheme;
}

/** A file or folder's type icon from the bundled Material icon theme. */
export function TreeTypeIcon({
  name,
  directory,
  open,
}: {
  readonly name: string;
  readonly directory: boolean;
  readonly open: boolean;
}) {
  const scheme = useIconScheme();
  const src = materialIconUrl(name, directory, open, scheme);
  if (!src) return directory ? <FolderIcon /> : <FileIcon />;
  return <img className="project-tree-type" alt="" draggable={false} src={src} />;
}

function Marked({
  text,
  ranges,
}: {
  readonly text: string;
  readonly ranges: readonly (readonly number[])[];
}) {
  let pos = 0;
  const parts: React.ReactNode[] = [];
  for (const range of ranges) {
    const start = Math.max(pos, range[0] ?? 0),
      end = Math.min(range[1] ?? 0, text.length);
    if (end <= start) continue;
    if (pos < start) parts.push(revealBidi(text.slice(pos, start)));
    parts.push(<mark key={start}>{revealBidi(text.slice(start, end))}</mark>);
    pos = end;
  }
  parts.push(revealBidi(text.slice(pos)));
  return <>{parts}</>;
}

function MatchSnippet({
  text,
  ranges,
}: {
  readonly text: string;
  readonly ranges: readonly (readonly number[])[];
}) {
  const first = ranges[0];
  if (!first) return <code className="project-tree-name">{revealBidi(text)}</code>;
  const from = first[0] ?? 0,
    to = first[1] ?? from;
  const suffix = ranges.slice(1).map(([a, b]) => [(a ?? to) - to, (b ?? to) - to]);
  return (
    <code className="project-tree-snippet" dir="ltr">
      {from > 0 && (
        <span className="project-match-lead" dir="rtl">
          <bdi dir="ltr">{revealBidi(text.slice(0, from))}</bdi>
        </span>
      )}
      <mark>{revealBidi(text.slice(from, to))}</mark>
      <span className="project-match-tail">
        <Marked text={text.slice(to)} ranges={suffix} />
      </span>
    </code>
  );
}

export function ProjectTreeRow({
  row,
  searchResult,
  guides,
  domId,
  current,
  selected,
  focused,
  open,
  top,
  height,
  onClick,
  onContext,
  onDrag,
}: {
  readonly row: TreeRow;
  readonly searchResult: boolean;
  readonly guides: ReadonlySet<string>;
  readonly domId: string;
  readonly current: boolean;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly open: boolean;
  readonly top: number;
  readonly height: number;
  readonly onClick: (event: MouseEvent, pin: boolean) => void;
  readonly onContext: (event: MouseEvent) => void;
  readonly onDrag: (event: DragEvent) => void;
}) {
  const t = useT();
  const match = row.match;
  const note = row.note;
  const noteText =
    note === 'more'
      ? t('files.tree.moreMatches', { count: row.remaining ?? 0 })
      : note === 'empty'
        ? t('files.tree.empty')
        : note === 'loading'
          ? t('files.tree.loading')
          : note === 'truncated'
            ? t('files.tree.limited')
            : note === 'error'
              ? t('files.tree.retry', { reason: row.detail ?? '' })
              : undefined;
  const link = row.link;
  const linkText = link
    ? t(
        link.state === 'ok'
          ? 'files.tree.link'
          : link.state === 'external'
            ? 'files.tree.external'
            : link.state === 'cycle'
              ? 'files.tree.cycle'
              : 'files.tree.dangling',
        { target: revealBidi(link.target) },
      )
    : undefined;
  const slash = row.path.lastIndexOf('/');
  const parent = searchResult && slash >= 0 ? row.path.slice(0, slash) : '';
  const nameRanges = (match?.positions ?? [])
    .filter((p) => p > slash)
    .map((p) => [p - slash - 1, p - slash]);
  const parentRanges = (match?.positions ?? []).filter((p) => p < slash).map((p) => [p, p + 1]);
  const segments = row.path.split('/');
  const lines: number[] = [];
  if (!searchResult && row.depth > 1) {
    let ancestor = '';
    for (let depth = 0; depth < row.depth - 1; depth++) {
      ancestor += (depth ? '/' : '') + (segments[depth] ?? '');
      if (guides.has(ancestor)) lines.push(depth);
    }
  }
  return (
    <div
      role="treeitem"
      id={domId}
      data-file-path={note ? undefined : row.path}
      data-focused={focused || undefined}
      data-current={current || undefined}
      data-note={note}
      aria-current={current ? 'true' : undefined}
      aria-level={row.depth}
      aria-selected={!note && selected}
      aria-expanded={row.directory ? open : undefined}
      aria-disabled={
        row.blocked === true ||
        (note !== undefined && note !== 'error' && note !== 'more') ||
        undefined
      }
      aria-label={
        noteText ??
        (match?.line
          ? t('files.tree.lineMatch', { line: match.line, text: revealBidi(match.preview ?? '') })
          : revealBidi(row.path))
      }
      title={noteText ?? [revealBidi(row.path), linkText].filter(Boolean).join('\n')}
      className="project-tree-row"
      style={
        {
          transform: `translateY(${String(top)}px)`,
          height,
          '--tree-depth': row.depth - 1,
        } as CSSProperties
      }
      draggable={!note && !row.blocked}
      onDragStart={onDrag}
      onContextMenu={onContext}
      onClick={(event) => {
        onClick(event, event.detail > 1);
      }}
      onDoubleClick={(event) => {
        if (!row.directory && !note) onClick(event, true);
      }}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button === 1 && !row.directory && !note) {
          event.preventDefault();
          onClick(event, true);
        }
      }}
    >
      {lines.map((depth) => (
        <i
          aria-hidden="true"
          key={depth}
          className="project-tree-guide"
          style={{ '--tree-guide': depth } as CSSProperties}
        />
      ))}
      {note ? (
        <span className="project-tree-note">{noteText}</span>
      ) : match?.line ? (
        <>
          <span className="project-tree-line-number">{match.line}</span>
          <MatchSnippet text={match.preview ?? ''} ranges={match.ranges ?? []} />
        </>
      ) : (
        <>
          {row.directory && !searchResult && (open ? <ChevronDownIcon /> : <ChevronRightIcon />)}
          <TreeTypeIcon name={row.name} directory={row.directory} open={open} />
          <span className="project-tree-name" dir="ltr">
            <Marked text={row.name} ranges={nameRanges} />
          </span>
          {parent && (
            <small className="project-tree-parent" dir="ltr">
              <Marked text={parent} ranges={parentRanges} />
            </small>
          )}
          {link && (
            <span className="project-tree-link" aria-label={linkText}>
              ↗
            </span>
          )}
        </>
      )}
    </div>
  );
}
