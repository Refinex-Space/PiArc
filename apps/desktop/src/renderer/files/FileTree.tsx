import { parentPath } from './file-path.js';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useApp } from '../app/app-context.js';
import { documentWindow, useSurfaceDocument } from '../app/surface-document.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { SearchIcon, CloseIcon } from '../shell/icons.js';
import {
  FileActionsMenu,
  type FileActions,
  type FileMenuEntry,
  type FileMenuPoint,
} from './FileActionsMenu.js';
import { useDirectories, type TreeReveal } from './tree-directories.js';
import { useProjectSearch, DEFAULT_SEARCH, type SearchOptions } from './tree-search.js';
import { searchRows, selectRow, treeRows, type TreeRow, type TreeSelection } from './tree-model.js';
import { ProjectTreeRow } from './tree-row.js';
import { listProjectFiles } from './api.js';

export interface TreeOpenOptions {
  readonly pinned?: boolean;
  readonly line?: number;
  readonly column?: number;
}
export interface FileTreeProps {
  readonly sessionId: string;
  readonly root: string;
  readonly activePath: string | null;
  readonly onOpen: (path: string, options?: TreeOpenOptions) => void;
  readonly actions: FileActions;
  readonly reveal?: TreeReveal;
  readonly filterRequest?: { readonly mode: 'filename' | 'content'; readonly nonce: number };
  readonly revision?: number;
  readonly onWatchDirectories?: (paths: readonly string[]) => void;
}

const EMPTY_SELECTION: TreeSelection = { anchor: '', paths: new Set() };
interface ContextMenu {
  at: FileMenuPoint;
  entries: FileMenuEntry[];
}

export function FileTree(props: FileTreeProps) {
  return <TreeBrowser key={JSON.stringify([props.sessionId, props.root])} {...props} />;
}

function TreeBrowser({
  sessionId,
  root,
  activePath,
  onOpen,
  actions,
  filterRequest,
  reveal,
  onWatchDirectories,
  revision = 0,
}: FileTreeProps) {
  const { t, preferences } = useApp();
  const doc = useSurfaceDocument();
  const win = documentWindow(doc);
  const [query, setQuery] = useState('');
  const [fullGroups, setFullGroups] = useState<ReadonlySet<string>>(new Set());
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH);
  const filter = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const treeId = useId();
  const directories = useDirectories(sessionId, revision);
  const result = useProjectSearch(sessionId, query, options, revision);
  const rows = useMemo(
    () =>
      query.trim()
        ? searchRows(result.results, result.content, fullGroups)
        : treeRows(directories.pages, directories.expanded),
    [query, result.results, result.content, directories.pages, directories.expanded, fullGroups],
  );
  const lastWatch = useRef<readonly string[]>([]);
  useEffect(() => {
    const paths = [''];
    if (!query.trim())
      for (const row of rows) {
        if (row.directory && directories.expanded.has(row.path)) paths.push(row.path);
        if (paths.length === 64) break;
      }
    if (
      paths.length === lastWatch.current.length &&
      paths.every((p, i) => lastWatch.current[i] === p)
    )
      return;
    lastWatch.current = paths;
    onWatchDirectories?.(paths);
  }, [rows, directories.expanded, query, onWatchDirectories]);
  const [focus, setFocus] = useState('');
  const [selection, setSelection] = useState<TreeSelection>(EMPTY_SELECTION);
  const [menu, setMenu] = useState<ContextMenu>();
  const menuGeneration = useRef(0);
  const pendingEnter = useRef<string | null>(null);
  const indexes = useMemo(() => new Map(rows.map((r, i) => [r.id, i])), [rows]);
  const focused = indexes.get(focus) ?? 0;
  const guides = useMemo(() => {
    const parents = new Set<string>();
    for (const path of [...selection.paths, ...(activePath ? [activePath] : [])]) {
      const parent = parentPath(path);
      if (parent) parents.add(parent);
      if (directories.expanded.has(path)) parents.add(path);
    }
    return parents;
  }, [selection.paths, activePath, directories.expanded]);
  const pendingReveal = useRef<string | null>(null);

  const size = useMemo(() => {
    const raw = win
      .getComputedStyle(doc.documentElement)
      .getPropertyValue('--piarc-size-button-height');
    return Number.parseFloat(raw) || 28;
  }, [doc, win, preferences.appearance.density]);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => list.current,
    estimateSize: () => size,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 6,
    rangeExtractor: (range) => {
      const shown = defaultRangeExtractor(range);
      if (rows.length && !shown.includes(focused)) shown.push(focused);
      return shown.sort((a, b) => a - b);
    },
  });
  useLayoutEffect(() => {
    virtual.measure();
  }, [virtual, size]);
  const go = (index: number, extend = false) => {
    const i = Math.max(0, Math.min(index, rows.length - 1)),
      target = rows[i];
    if (!target) return;
    setFocus(target.id);
    if (extend && !result.content && !target.note)
      setSelection((prev) => selectRow(prev, rows, target, 'range'));
    else if (!extend) setSelection((prev) => ({ ...prev, anchor: target.id }));
    virtual.scrollToIndex(i, { align: 'auto' });
  };

  const requestReveal = useCallback(
    (path: string) => {
      const clean = path.replace(/\/+$/u, '');
      setQuery('');
      setMenu(undefined);
      pendingEnter.current = null;
      pendingReveal.current = clean;
      setFocus(clean);
      setSelection({ anchor: clean, paths: new Set([clean]) });
      void directories.reveal(clean);
    },
    [directories.reveal],
  );

  useEffect(() => {
    if (reveal) requestReveal(reveal.path);
  }, [reveal?.nonce, reveal?.path, requestReveal]);
  useLayoutEffect(() => {
    const path = pendingReveal.current;
    const index = path !== null ? indexes.get(path) : undefined;
    if (index === undefined) return;
    pendingReveal.current = null;
    virtual.scrollToIndex(index, { align: 'center' });
  }, [indexes, virtual]);
  useEffect(() => {
    if (!filterRequest) return;
    const input = filter.current;
    if (!input) return;
    let start = 0;
    let value = input.value;
    if (filterRequest.mode === 'content') {
      value = '?' + value.trim().replace(/^\?/u, '');
      start = 1;
      setQuery(value);
    }
    const frame = win.requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start, value.length);
    });
    return () => {
      win.cancelAnimationFrame(frame);
    };
  }, [filterRequest?.nonce, filterRequest?.mode, win]);

  const open = (row: TreeRow, pinned: boolean) => {
    if (row.note === 'more') {
      setFullGroups((current) => new Set(current).add(row.path));
      return;
    }
    if (row.note === 'error') {
      directories.retry(row.path);
      return;
    }
    if (row.note || row.blocked) return;
    if (row.directory) {
      if (query.trim()) requestReveal(row.path);
      else void directories.toggle(row.path);
      return;
    }
    onOpen(row.path, {
      pinned,
      ...(row.match?.line ? { line: row.match.line } : {}),
      ...(row.match?.column ? { column: row.match.column } : {}),
    });
  };
  const firstResult = result.content ? rows.find((row) => row.match?.line !== undefined) : rows[0];
  const pressEnter = useRef(open);
  pressEnter.current = open;
  useEffect(() => {
    if (pendingEnter.current !== query || result.phase === 'waiting') return;
    pendingEnter.current = null;
    if (firstResult && result.phase === 'ready') pressEnter.current(firstResult, true);
  }, [firstResult, query, result.phase]);

  const change = (text: string) => {
    menuGeneration.current++;
    pendingEnter.current = null;
    pendingReveal.current = null;
    setQuery(text);
    setFullGroups(new Set());
    setMenu(undefined);
    setFocus('');
    setSelection(EMPTY_SELECTION);
    if (list.current) list.current.scrollTop = 0;
  };
  const activate = (event: MouseEvent, row: TreeRow, index: number, pinned: boolean) => {
    menuGeneration.current++;
    list.current?.focus({ preventScroll: true });
    setFocus(row.id);
    if (!row.note) {
      const mode = event.shiftKey ? 'range' : event.metaKey || event.ctrlKey ? 'toggle' : 'single';
      setSelection((previous) => selectRow(previous, rows, row, result.content ? 'single' : mode));
      if (!result.content && mode !== 'single') return;
    }
    virtual.scrollToIndex(index, { align: 'auto' });
    open(row, pinned);
  };

  const selectedRows = (row: TreeRow) =>
    !result.content && selection.paths.has(row.path)
      ? rows.filter((r) => !r.note && selection.paths.has(r.path))
      : [row];
  const showMenu = async (row: TreeRow, at: FileMenuPoint) => {
    if (row.note) return;
    const generation = ++menuGeneration.current;
    list.current?.focus({ preventScroll: true });
    const picked = selectedRows(row);
    setFocus(row.id);
    if (!selection.paths.has(row.path))
      setSelection(selectRow(EMPTY_SELECTION, rows, row, 'single'));
    const entries: FileMenuEntry[] = picked.map((r) => ({
      path: r.path,
      directory: r.directory,
      ...(r.blocked ? { blocked: true } : {}),
      ...(r.match?.line ? { line: r.match.line, snippet: r.match.preview ?? '' } : {}),
    }));
    const first = entries[0];
    if (entries.length === 1 && first && !first.blocked) {
      const page = await listProjectFiles(sessionId, parentPath(row.path), row.name).catch(
        (error: unknown) => {
          actions.onError?.(
            t('files.tree.inspectFailed', {
              reason: error instanceof Error ? error.message : String(error),
            }),
          );
          return null;
        },
      );
      if (generation !== menuGeneration.current) return;
      const known = page?.entries.find((e) => e.path === row.path);
      if (!known || (known.link && known.link.state !== 'ok'))
        entries[0] = { ...first, gone: true };
    }
    if (generation === menuGeneration.current && list.current?.isConnected)
      setMenu({ entries, at });
  };
  useEffect(() => {
    // Cancel a pending filesystem check if the user moves on before the menu opens.
    const cancel = () => {
      menuGeneration.current++;
    };
    doc.addEventListener('pointerdown', cancel, true);
    doc.addEventListener('keydown', cancel, true);
    win.addEventListener('blur', cancel);
    return () => {
      cancel();
      doc.removeEventListener('pointerdown', cancel, true);
      doc.removeEventListener('keydown', cancel, true);
      win.removeEventListener('blur', cancel);
    };
  }, [doc, win]);
  const closeMenu = useCallback(() => {
    menuGeneration.current++;
    setMenu(undefined);
  }, []);

  function handleKeys(event: KeyboardEvent) {
    if (isImeComposing(event.nativeEvent) || event.altKey) return;
    const row = rows[focused];
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;
    if (key === 'Escape') {
      if (selection.paths.size > 1) setSelection(EMPTY_SELECTION);
      else if (query) change('');
      else return;
    } else if (mod && key.toLowerCase() === 'a' && !result.content) {
      setSelection({
        anchor: row?.id ?? '',
        paths: new Set(rows.filter((r) => !r.note).map((r) => r.path)),
      });
    } else if (key === 'ArrowUp' && focused === 0 && !event.shiftKey) filter.current?.focus();
    else if (key === 'ArrowUp' || key === 'ArrowDown')
      go(focused + (key === 'ArrowUp' ? -1 : 1), event.shiftKey);
    else if (key === 'Home' || key === 'End')
      go(key === 'Home' ? 0 : rows.length - 1, event.shiftKey);
    else if (row && key === 'ArrowLeft' && !query.trim()) {
      if (row.directory && directories.expanded.has(row.path)) void directories.toggle(row.path);
      else {
        const parent = indexes.get(parentPath(row.path));
        if (parent !== undefined) go(parent);
      }
    } else if (row && key === 'ArrowRight') {
      if (!query.trim() && row.directory && !directories.expanded.has(row.path)) open(row, false);
      else go(focused + 1);
    } else if (row && (key === 'Enter' || key === ' ')) {
      if (mod || event.shiftKey)
        setSelection((prev) => selectRow(prev, rows, row, mod ? 'toggle' : 'range'));
      else {
        setSelection(selectRow(EMPTY_SELECTION, rows, row, 'single'));
        open(row, true);
      }
    } else if (row && (key === 'ContextMenu' || (event.shiftKey && key === 'F10'))) {
      const el = doc.getElementById(treeId + '-' + String(focused));
      if (el) {
        const rect = el.getBoundingClientRect();
        void showMenu(row, { x: rect.left, y: rect.bottom, anchor: el });
      }
    } else if (key.length === 1 && !mod) {
      change(query + key);
      filter.current?.focus();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <div className="project-tree" data-testid="project-file-tree">
      <div className="project-filter">
        {result.phase === 'waiting' ? (
          <span aria-hidden="true" className="project-search-spinner" />
        ) : (
          <SearchIcon />
        )}
        <input
          ref={filter}
          data-focus-proxy
          value={query}
          type="text"
          autoComplete="off"
          spellCheck={false}
          aria-label={t('files.tree.filter')}
          aria-controls={treeId}
          aria-describedby={treeId + '-hint'}
          aria-invalid={(options.regexp && result.phase === 'error') || undefined}
          placeholder={t('files.tree.placeholder')}
          maxLength={result.content ? 256 : 64}
          onChange={(e) => {
            change(e.target.value);
          }}
          onBlur={() => {
            pendingEnter.current = null;
          }}
          onKeyDown={(e) => {
            if (isImeComposing(e.nativeEvent)) return;
            if (e.key === 'Escape' && query) {
              change('');
            } else if (e.key === 'ArrowDown') {
              list.current?.focus();
              go(0);
            } else if (e.key === 'Enter' && query.trim() && !e.repeat) {
              if (result.phase === 'waiting') pendingEnter.current = query;
              else if (firstResult) open(firstResult, true);
            } else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
        {result.content && (
          <div className="project-search-options">
            {(['matchCase', 'wholeWord', 'regexp'] as const).map((key) => (
              <button
                type="button"
                key={key}
                aria-label={t(
                  key === 'matchCase'
                    ? 'files.tree.case'
                    : key === 'wholeWord'
                      ? 'files.tree.word'
                      : 'files.tree.regexp',
                )}
                title={t(
                  key === 'matchCase'
                    ? 'files.tree.case'
                    : key === 'wholeWord'
                      ? 'files.tree.word'
                      : 'files.tree.regexp',
                )}
                aria-pressed={options[key]}
                onClick={() => {
                  setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
                }}
              >
                {key === 'matchCase'
                  ? t('files.tree.caseGlyph')
                  : key === 'wholeWord'
                    ? t('files.tree.wordGlyph')
                    : t('files.tree.regexpGlyph')}
              </button>
            ))}
          </div>
        )}
        {query && (
          <button
            type="button"
            className="project-filter-clear"
            aria-label={t('files.tree.clear')}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              change('');
              filter.current?.focus();
            }}
          >
            <CloseIcon />
          </button>
        )}
      </div>
      <span id={treeId + '-hint'} className="visually-hidden">
        {t('files.tree.filterHint')}
      </span>
      {query.trim() && !rows.length && (
        <div role="status" className="project-tree-message">
          {result.phase === 'error'
            ? result.error
            : result.phase === 'waiting'
              ? t('files.tree.searching')
              : !result.needle
                ? t('files.tree.typeQuery')
                : result.content
                  ? t('files.tree.noContent')
                  : t('files.tree.noMatches')}
        </div>
      )}
      <div
        ref={list}
        id={treeId}
        className="project-tree-list"
        role="tree"
        tabIndex={0}
        aria-label={t('files.tree.title')}
        aria-multiselectable={!result.content}
        aria-activedescendant={rows[focused] ? treeId + '-' + String(focused) : undefined}
        aria-busy={query.trim() ? result.phase === 'waiting' : !directories.pages.has('')}
        onKeyDown={handleKeys}
        onMouseDown={(event) => {
          if (!(event.target as Element).closest('[role=treeitem]')) setSelection(EMPTY_SELECTION);
        }}
      >
        <div
          role="presentation"
          className="project-tree-sizer"
          style={{ height: virtual.getTotalSize() }}
        >
          {virtual.getVirtualItems().map((item) => {
            const row = rows[item.index];
            return (
              row && (
                <ProjectTreeRow
                  key={item.key}
                  row={row}
                  searchResult={Boolean(query.trim())}
                  guides={guides}
                  domId={treeId + '-' + String(item.index)}
                  current={!row.note && !row.match?.line && row.path === activePath}
                  selected={!result.content && !row.note && selection.paths.has(row.path)}
                  open={!query.trim() && directories.expanded.has(row.path)}
                  focused={focused === item.index}
                  top={item.start}
                  height={size}
                  onClick={(event, pin) => {
                    activate(event, row, item.index, pin);
                  }}
                  onContext={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void showMenu(row, { x: event.clientX, y: event.clientY });
                  }}
                  onDrag={(event) => {
                    const paths = selectedRows(row)
                      .filter((r) => !r.blocked)
                      .map((r) => r.path);
                    event.dataTransfer.effectAllowed = 'copy';
                    event.dataTransfer.setData(
                      'application/x-piarc-project-files',
                      JSON.stringify({ sessionId, paths }),
                    );
                    event.dataTransfer.setData('text/plain', paths.join('\n'));
                  }}
                />
              )
            );
          })}
        </div>
      </div>
      {result.truncated && (
        <div role="status" className="project-tree-message">
          {t('files.tree.narrow')}
        </div>
      )}
      {menu && (
        <FileActionsMenu
          root={root}
          actions={actions}
          entries={menu.entries}
          at={menu.at}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
