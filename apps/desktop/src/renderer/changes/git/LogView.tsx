// The Git tool's log view (design addendum 9.1, H1–H3): history pages with the commit graph,
// filters, the selected commit's details and changes, the commit operations in a row menu, and
// the stash list. Rows are a listbox: the arrow keys move, Enter opens the details on a narrow
// panel, Shift+F10 (or the context menu key) opens the row menu and Mod+C copies the id.
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';

import { useApp } from '../../app/app-context.js';
import { SegmentedControl } from '../../app/SegmentedControl.js';
import { MenuPopup, useMenu, type MenuItem } from '../../shell/Menu.js';
import { PanelEmpty } from '../../shell/PanelEmpty.js';
import { ChevronDownIcon, ChevronLeftIcon, SearchIcon } from '../../shell/icons.js';
import { revealBidi } from '../../transcript/reveal.js';
import { setPrompt, type GitActions } from './actions.js';
import { CommitDetailPane, StashDetailPane } from './CommitDetail.js';
import { graphRows, type GraphRow } from './graph.js';
import { useHistoryActions, shortId } from './history-actions.js';
import { HistoryPrompt, type HistoryDialog } from './HistoryPrompts.js';
import type { DiffDisplay } from './GitDiff.js';
import {
  gitCall,
  logOf,
  stashesOf,
  type LogCommit,
  type RefLabel,
  type Repository,
  type StashEntry,
} from './protocol.js';
import { gitSession, type GitSnapshot } from './state.js';
import type { ScopeChoice } from './model.js';

/** Below this width the list and the details take turns. */
const SPLIT_WIDTH = 560;
/** Graph column width and row height, in pixels. */
const LANE = 12;
const ROW = 28;
/** The filter waits this long after the last key. */
const FILTER_MS = 250;

type Revs =
  | { readonly kind: 'head' }
  | { readonly kind: 'all' }
  | { readonly kind: 'ref'; readonly name: string };

interface Pages {
  readonly commits: readonly LogCommit[];
  readonly more: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
}

/** Pages of `revs` filtered by `text`, reloaded when the repository moves. */
function useLogPages(sessionId: string, revs: Revs, text: string, repoKey: string) {
  const [pages, setPages] = useState<Pages>({
    commits: [],
    more: false,
    loading: true,
    failed: false,
  });
  const generation = useRef(0);
  const load = useCallback(
    async (skip: number, previous: readonly LogCommit[]) => {
      generation.current += 1;
      const mine = generation.current;
      setPages((old) => ({ ...old, loading: true }));
      const request = {
        op: 'log',
        revs,
        ...(skip > 0 ? { skip } : {}),
        ...(text.trim() === '' ? {} : { text: text.trim() }),
      };
      const reply = await gitCall(sessionId, request, logOf);
      if (mine !== generation.current) return;
      setPages(
        reply.ok
          ? {
              commits: [...previous, ...reply.value.commits],
              more: reply.value.more,
              loading: false,
              failed: false,
            }
          : { commits: previous, more: false, loading: false, failed: true },
      );
    },
    [sessionId, revs, text],
  );
  useEffect(() => {
    void load(0, []);
  }, [load, repoKey]);
  const more = useCallback(() => {
    if (pages.loading || !pages.more) return;
    void load(pages.commits.length, pages.commits);
  }, [load, pages]);
  return { pages, more };
}

function RefBadge({ label }: { readonly label: RefLabel }) {
  return (
    <span
      className={`git-ref is-${label.kind}${label.current === true ? ' is-current' : ''}`}
      data-testid="git-ref"
    >
      {revealBidi(label.name)}
    </span>
  );
}

function GraphCell({ row }: { readonly row: GraphRow }) {
  const x = (column: number) => column * LANE + LANE / 2;
  const mid = ROW / 2;
  const color = (index: number) => `var(--piarc-graph-lane${String(index)})`;
  return (
    <svg
      className="git-graph"
      width={row.width * LANE}
      height={ROW}
      viewBox={`0 0 ${String(row.width * LANE)} ${String(ROW)}`}
      aria-hidden="true"
      focusable="false"
    >
      {row.lines.map((line, index) => {
        const d =
          line.kind === 'through'
            ? `M${String(x(line.from))} 0 V${String(ROW)}`
            : line.kind === 'in'
              ? `M${String(x(line.from))} 0 C${String(x(line.from))} ${String(mid / 2)} ${String(x(line.to))} ${String(mid / 2)} ${String(x(line.to))} ${String(mid)}`
              : `M${String(x(line.from))} ${String(mid)} C${String(x(line.from))} ${String(mid + mid / 2)} ${String(x(line.to))} ${String(mid + mid / 2)} ${String(x(line.to))} ${String(ROW)}`;
        return (
          <path
            key={`${line.kind}-${String(line.from)}-${String(line.to)}-${String(index)}`}
            d={d}
            stroke={color(line.color)}
            strokeWidth={1.5}
            fill="none"
          />
        );
      })}
      <circle
        cx={x(row.column)}
        cy={mid}
        r={row.merge ? 3 : 3.5}
        fill={row.merge ? 'var(--piarc-surface-panel)' : color(row.color)}
        stroke={color(row.color)}
        strokeWidth={1.5}
      />
    </svg>
  );
}

/** Keyboard on a listbox of rows: arrows, Home and End move; the rest is the caller's. */
function moveIn(
  event: KeyboardEvent<HTMLElement>,
  count: number,
  at: number,
  select: (index: number) => void,
): boolean {
  const to =
    event.key === 'ArrowDown'
      ? at + 1
      : event.key === 'ArrowUp'
        ? at - 1
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? count - 1
            : undefined;
  if (to === undefined || count === 0) return false;
  event.preventDefault();
  select(Math.max(0, Math.min(count - 1, to)));
  return true;
}

export function LogView({
  sessionId,
  git,
  repo,
  actions,
  display,
  width,
  onShowCommit,
}: {
  readonly sessionId: string;
  readonly git: GitSnapshot;
  readonly repo: Repository;
  readonly actions: GitActions;
  readonly display: DiffDisplay;
  readonly width: number;
  readonly onShowCommit: (choice: ScopeChoice) => void;
}) {
  const { t, format } = useApp();
  const history = useHistoryActions(sessionId, actions);
  const [mode, setMode] = useState<'commits' | 'stashes'>('commits');
  const [revs, setRevs] = useState<Revs>({ kind: 'head' });
  const [typed, setTyped] = useState('');
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [detailOpen, setDetailOpen] = useState(false);
  const [dialog, setDialog] = useState<HistoryDialog | undefined>(undefined);
  const [stashes, setStashes] = useState<readonly StashEntry[] | undefined>(undefined);
  const menu = useMenu();
  const revsMenu = useMenu();
  const [menuFor, setMenuFor] = useState<LogCommit | undefined>(undefined);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const repoKey = git.status.value?.fingerprint ?? '';
  const { pages, more } = useLogPages(sessionId, revs, text, repoKey);
  const split = width === 0 || width >= SPLIT_WIDTH;
  const filtered = text.trim() !== '';
  const rows = useMemo(
    () => (filtered ? undefined : graphRows(pages.commits)),
    [pages.commits, filtered],
  );
  const graphWidth = useMemo(() => Math.max(1, ...(rows ?? []).map((r) => r.width)) * LANE, [rows]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setText(typed);
    }, FILTER_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [typed]);
  useEffect(() => {
    if (mode !== 'stashes') return;
    void gitCall(sessionId, { op: 'stashes' }, stashesOf).then((reply) => {
      setStashes(reply.ok ? reply.value : []);
    });
  }, [mode, sessionId, repoKey]);
  useEffect(() => {
    if (revsMenu.open !== null) void gitSession(sessionId).loadBranches();
  }, [revsMenu.open, sessionId]);

  const items = mode === 'commits' ? pages.commits : (stashes ?? []);
  const keyOf = (item: LogCommit | StashEntry) => ('sha' in item ? item.sha : item.oid);
  const selectedIndex = items.findIndex((item) => keyOf(item) === selected);
  const select = (index: number, open = false) => {
    const item = items[index];
    if (item === undefined) return;
    setSelected(keyOf(item));
    if (open) setDetailOpen(true);
    requestAnimationFrame(() => {
      list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(keyOf(item))}"]`)?.focus();
    });
  };

  const commitMenu = (commit: LogCommit): MenuItem[] => {
    const writable = repo.writable;
    const locked = writable ? {} : { disabled: true, hint: t('git.log.untrusted') };
    const merge = commit.parents.length > 1;
    const isHead = commit.sha === repo.head;
    const subject = commit.subject;
    return [
      {
        id: 'copy',
        label: t('git.log.copy'),
        testId: 'git-log-copy',
        run: () => void navigator.clipboard.writeText(commit.sha),
      },
      {
        id: 'show',
        label: t('git.log.showChanges'),
        testId: 'git-log-show',
        run: () => {
          onShowCommit({ kind: 'commit', sha: commit.sha, short: shortId(commit.sha), subject });
        },
      },
      {
        id: 'checkout',
        label: t('git.log.checkout'),
        testId: 'git-log-checkout',
        ...locked,
        run: () => {
          setDialog({ kind: 'detach', sha: commit.sha, subject });
        },
      },
      {
        id: 'branch',
        label: t('git.log.newBranch'),
        testId: 'git-log-branch',
        ...locked,
        run: () => {
          setPrompt(sessionId, { kind: 'branchName', mode: 'create', start: commit.sha });
        },
      },
      {
        id: 'tag',
        label: t('git.log.newTag'),
        testId: 'git-log-tag',
        ...locked,
        run: () => {
          setDialog({ kind: 'tag', sha: commit.sha, subject });
        },
      },
      {
        id: 'cherryPick',
        label: t('git.log.cherryPick'),
        testId: 'git-log-cherry-pick',
        ...(merge ? { disabled: true, hint: t('git.log.mergeCommit') } : locked),
        run: () => void history.cherryPick(commit.sha),
      },
      {
        id: 'revert',
        label: t('git.log.revert'),
        testId: 'git-log-revert',
        ...(merge ? { disabled: true, hint: t('git.log.mergeCommit') } : locked),
        run: () => void history.revert(commit.sha),
      },
      {
        id: 'reset',
        label: t('git.log.reset', { branch: revealBidi(repo.branch ?? 'HEAD') }),
        testId: 'git-log-reset',
        ...(repo.head === undefined ? { disabled: true } : locked),
        run: () => {
          if (repo.head === undefined) return;
          setDialog({
            kind: 'reset',
            sha: commit.sha,
            subject,
            head: repo.head,
            branch: repo.branch ?? 'HEAD',
          });
        },
      },
      ...(isHead && commit.parents.length > 0
        ? [
            {
              id: 'undo',
              label: t('git.log.undoCommit'),
              testId: 'git-log-undo',
              ...locked,
              run: () => {
                const pushed = repo.upstream !== undefined && repo.ahead === 0;
                if (pushed) setDialog({ kind: 'undoCommit', head: commit.sha, subject });
                else void history.undoCommit(commit.sha);
              },
            },
          ]
        : []),
    ];
  };

  const openMenu = (commit: LogCommit, x: number, y: number) => {
    setMenuFor(commit);
    menu.openAt(x, y);
  };
  const onRowKey = (event: KeyboardEvent<HTMLElement>, index: number) => {
    if (moveIn(event, items.length, index, select)) return;
    const item = items[index];
    if (item === undefined) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      setSelected(keyOf(item));
      setDetailOpen(true);
    } else if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
      event.preventDefault();
      if ('sha' in item) {
        const box = event.currentTarget.getBoundingClientRect();
        openMenu(item, box.left + 24, box.bottom);
      }
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      void navigator.clipboard.writeText(keyOf(item));
    }
  };
  const onContext = (event: MouseEvent<HTMLElement>, commit: LogCommit) => {
    event.preventDefault();
    setSelected(commit.sha);
    openMenu(commit, event.clientX, event.clientY);
  };

  const revsLabel =
    revs.kind === 'head'
      ? t('git.log.revsHead', { branch: revealBidi(repo.branch ?? 'HEAD') })
      : revs.kind === 'all'
        ? t('git.log.revsAll')
        : revealBidi(revs.name);
  const branches = git.branches.value;
  const revsItems: MenuItem[] = [
    {
      id: 'head',
      label: t('git.log.revsHead', { branch: revealBidi(repo.branch ?? 'HEAD') }),
      selected: revs.kind === 'head',
      run: () => {
        setRevs({ kind: 'head' });
      },
    },
    {
      id: 'all',
      label: t('git.log.revsAll'),
      selected: revs.kind === 'all',
      testId: 'git-log-revs-all',
      run: () => {
        setRevs({ kind: 'all' });
      },
    },
    ...(branches?.local ?? [])
      .filter((b) => !b.current)
      .map((b) => ({
        id: `local:${b.name}`,
        label: revealBidi(b.name),
        selected: revs.kind === 'ref' && revs.name === b.name,
        run: () => {
          setRevs({ kind: 'ref', name: b.name });
        },
      })),
    ...(branches?.remote ?? []).map((b) => {
      const name = `${b.remote}/${b.name}`;
      return {
        id: `remote:${name}`,
        label: revealBidi(name),
        selected: revs.kind === 'ref' && revs.name === name,
        run: () => {
          setRevs({ kind: 'ref', name });
        },
      };
    }),
  ];

  const now = Date.now();
  const selectedCommit = mode === 'commits' ? pages.commits[selectedIndex] : undefined;
  const selectedStash = mode === 'stashes' ? stashes?.[selectedIndex] : undefined;
  const showList = split || !detailOpen || selectedIndex < 0;
  const showDetail = split || (detailOpen && selectedIndex >= 0);
  const back = split ? null : (
    <button
      type="button"
      className="git-link-button git-log-back"
      data-testid="git-log-back"
      onClick={() => {
        setDetailOpen(false);
      }}
    >
      <ChevronLeftIcon size={12} />
      {t('git.log.back')}
    </button>
  );

  const listPane = (
    <div className="git-log-list-pane">
      <div className="git-log-filters">
        <SegmentedControl
          options={['commits', 'stashes'] as const}
          value={mode}
          onChange={(next) => {
            setMode(next);
            setSelected(undefined);
            setDetailOpen(false);
          }}
          labelOf={(v) => t(v === 'commits' ? 'git.log.commits' : 'git.log.stashes')}
          aria-label={t('git.log.modeLabel')}
          testId="git-log-mode"
          testIdPrefix="git-log-mode"
        />
        {mode === 'commits' ? (
          <>
            <label className="git-log-search">
              <SearchIcon size={12} />
              <span className="visually-hidden">{t('git.log.filter')}</span>
              <input
                type="search"
                value={typed}
                placeholder={t('git.log.filter')}
                data-testid="git-log-filter"
                spellCheck={false}
                maxLength={200}
                onChange={(event) => {
                  setTyped(event.target.value);
                }}
              />
            </label>
            <button
              type="button"
              className="git-log-revs"
              data-testid="git-log-revs"
              aria-haspopup="menu"
              aria-expanded={revsMenu.open !== null}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                revsMenu.openAt(box.left, box.bottom + 4);
              }}
            >
              <span className="git-log-revs-label">{revsLabel}</span>
              <ChevronDownIcon size={12} />
            </button>
          </>
        ) : null}
      </div>
      {mode === 'commits' && pages.failed && pages.commits.length === 0 ? (
        <p className="git-note" role="alert" data-testid="git-log-failed">
          {t('git.log.failed')}
        </p>
      ) : items.length === 0 && !(mode === 'commits' ? pages.loading : stashes === undefined) ? (
        <PanelEmpty
          title={
            mode === 'stashes'
              ? t('git.log.noStashes')
              : filtered
                ? t('git.log.noMatch')
                : t('git.log.empty')
          }
          testId="git-log-empty"
        />
      ) : (
        <div
          ref={list}
          id={listId}
          className="git-log-rows"
          role="listbox"
          aria-label={mode === 'commits' ? t('git.log.commits') : t('git.log.stashes')}
          data-testid="git-log-rows"
          onScroll={(event) => {
            const el = event.currentTarget;
            if (mode === 'commits' && el.scrollTop + el.clientHeight > el.scrollHeight - ROW * 10)
              more();
          }}
        >
          {mode === 'commits'
            ? pages.commits.map((commit, index) => {
                const row = rows?.[index];
                const isSelected = commit.sha === selected;
                return (
                  <div
                    key={commit.sha}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={isSelected || (selectedIndex < 0 && index === 0) ? 0 : -1}
                    className={`git-log-row${isSelected ? ' is-selected' : ''}`}
                    data-key={commit.sha}
                    data-testid="git-log-row"
                    onClick={() => {
                      setSelected(commit.sha);
                      setDetailOpen(true);
                    }}
                    onContextMenu={(event) => {
                      onContext(event, commit);
                    }}
                    onKeyDown={(event) => {
                      onRowKey(event, index);
                    }}
                  >
                    {rows === undefined ? null : (
                      <span className="git-log-graph" style={{ width: graphWidth }}>
                        {row === undefined ? null : <GraphCell row={row} />}
                      </span>
                    )}
                    <span className="git-log-subject">
                      {commit.refs.map((label) => (
                        <RefBadge key={`${label.kind}:${label.name}`} label={label} />
                      ))}
                      <span className="git-log-text">
                        {revealBidi(
                          commit.subject === '' ? t('git.commits.noMessage') : commit.subject,
                        )}
                      </span>
                    </span>
                    <span className="git-log-author">{revealBidi(commit.author)}</span>
                    <span className="git-log-time">{format.relative(commit.time * 1000, now)}</span>
                  </div>
                );
              })
            : (stashes ?? []).map((entry, index) => {
                const isSelected = entry.oid === selected;
                return (
                  <div
                    key={entry.oid}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={isSelected || (selectedIndex < 0 && index === 0) ? 0 : -1}
                    className={`git-log-row is-stash${isSelected ? ' is-selected' : ''}`}
                    data-key={entry.oid}
                    data-testid="git-stash-row"
                    onClick={() => {
                      setSelected(entry.oid);
                      setDetailOpen(true);
                    }}
                    onKeyDown={(event) => {
                      onRowKey(event, index);
                    }}
                  >
                    <span className="git-log-subject">
                      <span className="git-ref is-stash">{`stash@{${String(entry.index)}}`}</span>
                      <span className="git-log-text">
                        {revealBidi(
                          entry.message === '' ? t('git.commits.noMessage') : entry.message,
                        )}
                      </span>
                    </span>
                    <span className="git-log-author">
                      {entry.branch === undefined ? '' : revealBidi(entry.branch)}
                    </span>
                    <span className="git-log-time">{format.relative(entry.time * 1000, now)}</span>
                  </div>
                );
              })}
          {mode === 'commits' && pages.more ? (
            <button
              type="button"
              className="git-link-button git-log-more"
              data-testid="git-log-more"
              disabled={pages.loading}
              onClick={more}
            >
              {t('git.log.loadMore')}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );

  const detailPane = !showDetail ? null : (
    <div className="git-log-detail-pane" data-testid="git-log-detail">
      {back}
      {selectedCommit !== undefined ? (
        <CommitDetailPane
          sessionId={sessionId}
          commit={selectedCommit}
          display={display}
          onSelect={(sha) => {
            const index = pages.commits.findIndex((c) => c.sha === sha);
            if (index >= 0) select(index);
          }}
          onMenu={(x, y) => {
            openMenu(selectedCommit, x, y);
          }}
        />
      ) : selectedStash !== undefined ? (
        <StashDetailPane
          sessionId={sessionId}
          entry={selectedStash}
          display={display}
          writable={repo.writable}
          onApply={(pop) => void history.stashApply(selectedStash, pop)}
          onBranch={() => {
            setDialog({ kind: 'stashBranch', entry: selectedStash });
          }}
          onDrop={() => {
            void history.stashDrop(selectedStash).then((reply) => {
              if (reply.ok) setSelected(undefined);
            });
          }}
        />
      ) : split ? (
        <PanelEmpty title={t('git.log.pick')} testId="git-log-pick" />
      ) : null}
    </div>
  );

  return (
    <div className="git-log" data-split={split || undefined} data-testid="git-log">
      {showList ? listPane : null}
      {detailPane}
      {menu.open === null || menuFor === undefined ? null : (
        <MenuPopup
          items={commitMenu(menuFor)}
          at={menu.open}
          onClose={menu.close}
          label={t('git.log.menu', { short: shortId(menuFor.sha) })}
          testId="git-log-menu"
        />
      )}
      {revsMenu.open === null ? null : (
        <MenuPopup
          items={revsItems}
          at={revsMenu.open}
          onClose={revsMenu.close}
          label={t('git.log.revsLabel')}
          filterLabel={t('git.log.revsFilter')}
          testId="git-log-revs-menu"
        />
      )}
      {dialog === undefined ? null : (
        <HistoryPrompt
          dialog={dialog}
          history={history}
          onCheckout={(sha) => void actions.checkout(sha)}
          onClose={() => {
            setDialog(undefined);
          }}
        />
      )}
    </div>
  );
}

/** Stashing from the commit view opens the same dialog as the log view. */
export function StashButtonDialog({
  sessionId,
  actions,
  onClose,
}: {
  readonly sessionId: string;
  readonly actions: GitActions;
  readonly onClose: () => void;
}) {
  const history = useHistoryActions(sessionId, actions);
  return (
    <HistoryPrompt
      dialog={{ kind: 'stash' }}
      history={history}
      onCheckout={() => undefined}
      onClose={onClose}
    />
  );
}
