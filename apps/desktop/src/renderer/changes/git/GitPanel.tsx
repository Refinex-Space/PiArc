// The Git tool (ADR-0084): the session tool that was "Changes". Its title row holds the view
// switch (Changes, Commit) and, in Changes, the file list toggle, the scope button, "Go to
// file" and the display menu; narrow tiles move the list toggle and "Go to file" into the menu.
// The Changes view follows the reference's Changes pane: four scopes, the changed files column,
// the diff list. The Commit view (`CommitView.tsx`) stages, commits, switches branches and
// syncs. Outside a Git repository only the session's own changes are shown.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import { useApp, useT } from '../../app/app-context.js';
import { IconButton } from '../../app/IconButton.js';
import { SegmentedControl } from '../../app/SegmentedControl.js';
import { useWindowFocused } from '../../app/window-focus.js';
import { projectFileRoot, projectPath } from '../../files/file-path.js';
import { attachProjectFiles, openProjectFile } from '../../files/navigation.js';
import { MenuPopup, useMenu, type MenuItem } from '../../shell/Menu.js';
import { PanelEmpty } from '../../shell/PanelEmpty.js';
import { showPanel } from '../../shell/registry.js';
import { ToolHeaderContent, useToolVisible } from '../../shell/ToolHeaderSlot.js';
import { useUi } from '../../shell/ui.js';
import {
  AlertIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  FileListIcon,
  GitBranchIcon,
  MoreVerticalIcon,
  SearchIcon,
  SpinnerGlyph,
} from '../../shell/icons.js';
import { useSession, useTurnInfo } from '../../store/hooks.js';
import { revealBidi } from '../../transcript/reveal.js';
import { ChangesPanel } from '../ChangesPanel.js';
import { isSendKey } from '../comments.js';
import { CommentsBar, DiffCommentsProvider, useDiffCommentsState } from '../DiffComments.js';
import { CommitView } from './CommitView.js';
import { LogView } from './LogView.js';
import { useAutoFetch } from './auto-fetch.js';
import { FileColumn } from './FileColumn.js';
import { claimCommands } from './focus.js';
import { asChangesFile, FileSection } from './GitDiff.js';
import { GoToFile } from './GoToFile.js';
import {
  clampWidth,
  FILES_FIT_WIDTH,
  gitScope,
  readDisplay,
  rememberedScope,
  rememberScope,
  saveDisplay,
  scopeKey,
  settleScope,
  SPLIT_FIT_WIDTH,
  type DisplayPrefs,
  type ScopeChoice,
} from './model.js';
import type { Changes, FileChange, Repository } from './protocol.js';
import { gitSession, useGit, type GitSnapshot } from './state.js';
import { useGitActions, useGitBoard } from './actions.js';
import { MergeView } from './MergeView.js';
import { GitNotices, GitPrompts } from './GitPrompts.js';

/** Changed lines past which every file starts folded. */
const LARGE_DIFF_LINES = 5000;
/** The loading indicator waits this long, so quick answers do not flash it. */
const LOADING_DELAY_MS = 1000;
/** How often the repository fingerprint is checked while the panel is visible. */
const PROBE_MS = 3000;
/** How often the status is read while the session's turn runs. */
const RUNNING_MS = 10_000;

type View = 'changes' | 'commit' | 'log';

const VIEW_KEY = 'piarc.git.view.v1';

function rememberedView(): View {
  try {
    const saved = window.localStorage.getItem(VIEW_KEY);
    return saved === 'commit' || saved === 'log' ? saved : 'changes';
  } catch {
    return 'changes';
  }
}

/** The element's width, followed with a resize observer. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth);
    });
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return width;
}

/** True once `active` has stayed true for `delay` ms. */
function useDelayed(active: boolean, delay: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => {
      setShown(true);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [active, delay]);
  return shown;
}

/** When the status is read again (ADR-0084 A6.6): shown, focus, turn edges, polling. */
function useGitRefresh(sessionId: string, visible: boolean): void {
  const session = gitSession(sessionId);
  const focused = useWindowFocused();
  const turn = useTurnInfo(sessionId);
  const running = turn.running;
  const wasRunning = useRef(running);
  useEffect(() => {
    if (visible) void session.refreshStatus();
  }, [session, visible]);
  useEffect(() => {
    if (visible && focused) void session.refreshStatus();
  }, [session, visible, focused]);
  useEffect(() => {
    if (wasRunning.current !== running) {
      wasRunning.current = running;
      void session.refreshStatus();
    }
  }, [session, running]);
  useEffect(() => {
    if (!visible || !focused) return;
    const timer = setInterval(() => {
      void session.probe();
    }, PROBE_MS);
    return () => {
      clearInterval(timer);
    };
  }, [session, visible, focused]);
  useEffect(() => {
    if (!visible || !running) return;
    const timer = setInterval(() => {
      void session.refreshStatus();
    }, RUNNING_MS);
    return () => {
      clearInterval(timer);
    };
  }, [session, visible, running]);
}

/** The label of the scope button. */
function scopeLabel(
  choice: ScopeChoice,
  repo: Repository | undefined,
  base: string | undefined,
  t: ReturnType<typeof useT>,
) {
  switch (choice.kind) {
    case 'uncommitted':
      return t('git.scope.uncommitted');
    case 'session':
      return t('git.scope.session');
    case 'commit':
      return `${choice.short} ${choice.subject === '' ? t('git.commits.noMessage') : choice.subject}`;
    case 'branch':
      return repo?.detached === true || base === undefined ? undefined : base;
  }
}

/** The English heading of comments sent from a scope (model-facing, not translated). */
function commentHeading(choice: ScopeChoice, changes: Changes | undefined): string | undefined {
  switch (choice.kind) {
    case 'uncommitted':
      return 'Review comments on the uncommitted changes:';
    case 'commit':
      return `Review comments on commit ${choice.short} (${choice.subject}):`;
    case 'branch': {
      const base = changes?.base;
      return base === undefined
        ? 'Review comments on the changes:'
        : `Review comments on the changes since ${base.name} (merge base ${(base.mergeBase ?? '').slice(0, 7)}):`;
    }
    case 'session':
      return undefined;
  }
}

export function GitPanel({ sessionId }: { readonly sessionId: string }) {
  const { t, preferences } = useApp();
  const git = useGit(sessionId);
  const actions = useGitActions(sessionId);
  const board = useGitBoard(sessionId);
  const visible = useToolVisible();
  useGitRefresh(sessionId, visible);
  useAutoFetch(sessionId, git.status.value?.repository, preferences.git.autoFetch, visible);
  const root = useRef<HTMLDivElement>(null);
  const width = useWidth(root);
  const [view, setViewState] = useState<View>(rememberedView);
  const [scope, setScopeState] = useState<ScopeChoice>(() => rememberedScope(sessionId));
  const [display, setDisplayState] = useState<DisplayPrefs>(readDisplay);
  const [goto, setGoto] = useState(false);
  const status = git.status;
  const repo = status.value?.repository;
  const notRepo = status.failure?.kind === 'notRepo';
  const setView = (next: View) => {
    setViewState(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // A convenience only.
    }
  };
  const setScope = useCallback(
    (choice: ScopeChoice) => {
      setScopeState(choice);
      rememberScope(sessionId, choice);
    },
    [sessionId],
  );
  const setDisplay = (change: Partial<DisplayPrefs>) => {
    setDisplayState((old) => {
      const next = { ...old, ...change };
      saveDisplay(next);
      return next;
    });
  };
  // Mod+P and Mod+Shift+Y while focus is inside the panel (the menu sends them as commands).
  useEffect(
    () =>
      claimCommands((command) => {
        const element = root.current;
        if (!element?.contains(element.ownerDocument.activeElement)) return false;
        if (command === 'files.quick' && view === 'changes') {
          setGoto(true);
          return true;
        }
        if (command === 'files.tree' && view === 'changes') {
          setDisplay({ showFiles: !display.showFiles });
          return true;
        }
        return false;
      }),
    [view, display.showFiles],
  );
  const effectiveScope: ScopeChoice = notRepo ? { kind: 'session' } : scope;
  const compact = width > 0 && width < 380;
  const loading = useDelayed(
    status.loading && status.value === undefined && status.failure === undefined,
    LOADING_DELAY_MS,
  );
  const body = (() => {
    if (status.value === undefined && status.failure === undefined) {
      return loading ? <Loading /> : null;
    }
    if (status.failure?.kind === 'gitMissing') {
      return (
        <div className="git-body-note">
          <PanelEmpty
            icon={<AlertIcon />}
            title={t('git.missing.title')}
            description={t('git.missing.body')}
            testId="git-missing"
          />
          <ChangesPanel sessionId={sessionId} />
        </div>
      );
    }
    if (notRepo) {
      return (
        <div className="git-body-note">
          <p className="git-banner" data-testid="git-not-repo-note">
            {t('git.notRepo')}
          </p>
          <ChangesPanel sessionId={sessionId} />
        </div>
      );
    }
    if (status.failure !== undefined && repo === undefined) {
      return (
        <div className="tool-empty" role="alert" data-testid="git-failed">
          <AlertIcon />
          <p>{t('git.failed')}</p>
          <button
            type="button"
            className="button button-small"
            onClick={() => {
              void gitSession(sessionId).refreshStatus();
            }}
          >
            {t('git.retry')}
          </button>
        </div>
      );
    }
    if (board.mergeView !== undefined) {
      return <MergeView sessionId={sessionId} path={board.mergeView} actions={actions} />;
    }
    if (view === 'commit') return <CommitView sessionId={sessionId} git={git} width={width} />;
    if (view === 'log' && repo !== undefined) {
      return (
        <LogView
          sessionId={sessionId}
          git={git}
          repo={repo}
          actions={actions}
          width={width}
          display={{
            split: display.layout === 'split' && (width === 0 || width >= SPLIT_FIT_WIDTH * 2),
            wrap: display.wrap,
            wordDiff: display.wordDiff,
            hideWhitespace: display.hideWhitespace,
          }}
          onShowCommit={(choice) => {
            setScope(choice);
            setView('changes');
          }}
        />
      );
    }
    if (effectiveScope.kind === 'session') return <ChangesPanel sessionId={sessionId} />;
    return (
      <GitChangesView
        sessionId={sessionId}
        git={git}
        scope={effectiveScope}
        onScope={setScope}
        display={display}
        setDisplay={setDisplay}
        width={width}
        goto={goto}
        onGoto={setGoto}
      />
    );
  })();
  return (
    <div className="git-panel" ref={root} data-testid="git-panel" data-view={view}>
      <ToolHeaderContent>
        <div className="git-heading">
          {notRepo ? (
            <span className="git-heading-title">{t('panel.changes')}</span>
          ) : (
            <SegmentedControl
              options={['changes', 'commit', 'log'] as const}
              value={view}
              onChange={setView}
              labelOf={(v) => t(`git.view.${v}`)}
              aria-label={t('git.view.label')}
              testId="git-view"
              testIdPrefix="git-view"
              className="git-view-switch"
            />
          )}
          {view === 'changes' && !notRepo && !compact ? (
            <IconButton
              label={t(display.showFiles ? 'git.files.hide' : 'git.files.show')}
              keys="Mod+Shift+Y"
              aria-pressed={display.showFiles}
              disabled={width > 0 && width < FILES_FIT_WIDTH}
              data-testid="git-files-toggle"
              onClick={() => {
                setDisplay({ showFiles: !display.showFiles });
              }}
            >
              <FileListIcon />
            </IconButton>
          ) : null}
          {view === 'changes' ? (
            <ScopeButton
              sessionId={sessionId}
              git={git}
              scope={effectiveScope}
              onScope={setScope}
              disabled={notRepo}
            />
          ) : null}
          <span className="git-heading-spacer" />
          {view === 'changes' && !notRepo && !compact ? (
            <IconButton
              label={t('git.goto.open')}
              keys="Mod+P"
              data-testid="git-goto"
              onClick={() => {
                setGoto(true);
              }}
            >
              <SearchIcon />
            </IconButton>
          ) : null}
          <DisplayMenu
            sessionId={sessionId}
            view={view}
            display={display}
            setDisplay={setDisplay}
            compact={compact}
            filesFit={width === 0 || width >= FILES_FIT_WIDTH}
            splitFits={width === 0 || width >= SPLIT_FIT_WIDTH}
            onGoto={() => {
              setGoto(true);
            }}
          />
        </div>
      </ToolHeaderContent>
      {body}
      <GitNotices sessionId={sessionId} />
      <GitPrompts sessionId={sessionId} repo={repo} actions={actions} />
    </div>
  );
}

function Loading() {
  const t = useT();
  return (
    <div className="tool-empty" data-testid="git-loading" role="status">
      <SpinnerGlyph />
      <p>{t('git.loading')}</p>
    </div>
  );
}

/** The scope button and its menu: all changes, uncommitted, the session's own; base and commits. */
function ScopeButton({
  sessionId,
  git,
  scope,
  onScope,
  disabled,
}: {
  readonly sessionId: string;
  readonly git: GitSnapshot;
  readonly scope: ScopeChoice;
  readonly onScope: (choice: ScopeChoice) => void;
  readonly disabled: boolean;
}) {
  const t = useT();
  const menu = useMenu();
  const session = gitSession(sessionId);
  const repo = git.status.value?.repository;
  const base = (scope.kind === 'branch' ? scope.base : undefined) ?? repo?.base?.name;
  const label = scopeLabel(scope, repo, base, t);
  const branches = git.branches.value;
  const commits = git.commits.value?.commits ?? [];
  const dirty = (git.status.value?.files.length ?? 0) > 0;
  const items: MenuItem[] = [
    {
      id: 'all',
      label: t('git.scope.all'),
      ...(repo?.base === undefined
        ? {}
        : { hint: t('git.scope.vs', { base: base ?? repo.base.name }) }),
      selected: scope.kind === 'branch',
      disabled: repo?.base === undefined,
      testId: 'git-scope-all',
      run: () => {
        onScope(scope.kind === 'branch' ? scope : { kind: 'branch' });
      },
    },
    {
      id: 'uncommitted',
      label: t('git.scope.uncommitted'),
      selected: scope.kind === 'uncommitted',
      ...(dirty ? {} : { hint: t('git.scope.clean') }),
      testId: 'git-scope-uncommitted',
      run: () => {
        onScope({ kind: 'uncommitted' });
      },
    },
    {
      id: 'session',
      label: t('git.scope.session'),
      hint: t('git.scope.sessionHint'),
      selected: scope.kind === 'session',
      testId: 'git-scope-session',
      run: () => {
        onScope({ kind: 'session' });
      },
    },
    {
      id: 'base',
      label: t('git.scope.compare'),
      ...(base === undefined ? {} : { hint: base }),
      testId: 'git-scope-compare',
      submenu:
        branches === undefined
          ? [
              {
                id: 'loading',
                label: t('git.scope.loadingBranches'),
                disabled: true,
                run: () => undefined,
              },
            ]
          : branches.local.slice(0, 200).map((b) => ({
              id: `base:${b.name}`,
              label: b.name,
              ...(b.name === repo?.base?.name ? { hint: t('git.scope.default') } : {}),
              selected: b.name === base,
              run: () => {
                onScope({ kind: 'branch', base: b.name });
              },
            })),
    },
    ...(commits.length === 0
      ? []
      : [
          {
            id: 'commits',
            label: t('git.scope.commits'),
            hint:
              scope.kind === 'commit'
                ? scope.short
                : String(git.commits.value?.total ?? commits.length),
            submenu: commits.slice(0, 50).map((c) => ({
              id: `commit:${c.sha}`,
              label: c.subject === '' ? t('git.commits.noMessage') : c.subject,
              hint: c.short,
              selected: scope.kind === 'commit' && scope.sha === c.sha,
              run: () => {
                onScope({ kind: 'commit', sha: c.sha, short: c.short, subject: c.subject });
              },
            })),
          } satisfies MenuItem,
        ]),
  ];
  const shown = label ?? t('git.scope.all');
  return (
    <>
      <button
        type="button"
        className="git-scope"
        data-testid="git-scope"
        aria-haspopup="menu"
        aria-expanded={menu.open !== null}
        disabled={disabled}
        onClick={(event) => {
          void session.loadBranches();
          const box = event.currentTarget.getBoundingClientRect();
          menu.openAt(box.left, box.bottom + 4, event.currentTarget);
        }}
      >
        <span className="visually-hidden">{t('git.scope.menu')}: </span>
        {scope.kind === 'branch' && label !== undefined ? (
          <>
            <span className="git-scope-text">{revealBidi(label)}</span>
            <ArrowRightIcon size={12} />
            <span className="git-scope-text">{t('git.scope.worktree')}</span>
          </>
        ) : scope.kind === 'branch' && repo?.detached === true ? (
          <>
            <span className="git-scope-text">{t('git.scope.head')}</span>
            <ArrowRightIcon size={12} />
            <span className="git-scope-text">{t('git.scope.worktree')}</span>
          </>
        ) : (
          <span className="git-scope-text">{revealBidi(shown)}</span>
        )}
        <ChevronDownIcon size={12} />
      </button>
      {menu.open === null ? null : (
        <MenuPopup
          items={items}
          at={menu.open}
          onClose={menu.close}
          label={t('git.scope.menu')}
          testId="git-scope-menu"
        />
      )}
    </>
  );
}

/** The display menu: file list, folding, layout, refresh. */
function DisplayMenu({
  sessionId,
  view,
  display,
  setDisplay,
  compact,
  filesFit,
  splitFits,
  onGoto,
}: {
  readonly sessionId: string;
  readonly view: View;
  readonly display: DisplayPrefs;
  readonly setDisplay: (change: Partial<DisplayPrefs>) => void;
  readonly compact: boolean;
  readonly filesFit: boolean;
  readonly splitFits: boolean;
  readonly onGoto: () => void;
}) {
  const t = useT();
  const menu = useMenu();
  const refresh: MenuItem = {
    id: 'refresh',
    label: t('git.menu.refresh'),
    testId: 'git-menu-refresh',
    run: () => {
      gitSession(sessionId).changed();
    },
  };
  const items: MenuItem[] =
    view !== 'changes'
      ? [refresh]
      : [
          ...(compact
            ? [
                { id: 'goto', label: t('git.goto.open'), shortcut: 'Mod+P', run: onGoto },
                {
                  id: 'files',
                  label: t('git.menu.showFiles'),
                  selected: display.showFiles,
                  disabled: !filesFit,
                  run: () => {
                    setDisplay({ showFiles: !display.showFiles });
                  },
                },
              ]
            : []),
          {
            id: 'tree',
            label: t('git.menu.tree'),
            selected: display.tree,
            testId: 'git-menu-tree',
            run: () => {
              setDisplay({ tree: !display.tree });
            },
          },
          {
            id: 'kinds',
            label: t('git.menu.byKind'),
            selected: display.groupByKind,
            testId: 'git-menu-kinds',
            run: () => {
              setDisplay({ groupByKind: !display.groupByKind });
            },
          },
          {
            id: 'split',
            label: t('git.menu.split'),
            selected: display.layout === 'split',
            ...(splitFits ? {} : { hint: t('git.menu.splitNarrow') }),
            testId: 'git-menu-split',
            run: () => {
              setDisplay({ layout: display.layout === 'split' ? 'unified' : 'split' });
            },
          },
          {
            id: 'wrap',
            label: t('git.menu.wrap'),
            selected: display.wrap,
            testId: 'git-menu-wrap',
            run: () => {
              setDisplay({ wrap: !display.wrap });
            },
          },
          {
            id: 'words',
            label: t('git.menu.words'),
            selected: display.wordDiff,
            testId: 'git-menu-words',
            run: () => {
              setDisplay({ wordDiff: !display.wordDiff });
            },
          },
          {
            id: 'whitespace',
            label: t('git.menu.whitespace'),
            selected: display.hideWhitespace,
            testId: 'git-menu-whitespace',
            run: () => {
              setDisplay({ hideWhitespace: !display.hideWhitespace });
            },
          },
          refresh,
        ];
  return (
    <>
      <IconButton
        label={t('git.menu.label')}
        aria-haspopup="menu"
        aria-expanded={menu.open !== null}
        data-testid="git-menu"
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          menu.openAt(box.right - 240, box.bottom + 4, event.currentTarget);
        }}
      >
        <MoreVerticalIcon />
      </IconButton>
      {menu.open === null ? null : (
        <MenuPopup
          items={items}
          at={menu.open}
          onClose={menu.close}
          label={t('git.menu.label')}
          testId="git-menu-popup"
        />
      )}
    </>
  );
}

/** The Changes view of a Git scope: the files column and the diff list. */
function GitChangesView({
  sessionId,
  git,
  scope,
  onScope,
  display,
  setDisplay,
  width,
  goto,
  onGoto,
}: {
  readonly sessionId: string;
  readonly git: GitSnapshot;
  readonly scope: ScopeChoice;
  readonly onScope: (choice: ScopeChoice) => void;
  readonly display: DisplayPrefs;
  readonly setDisplay: (change: Partial<DisplayPrefs>) => void;
  readonly width: number;
  readonly goto: boolean;
  readonly onGoto: (open: boolean) => void;
}) {
  const { t, keyPlatform } = useApp();
  const { transcriptServices } = useUi();
  const session = gitSession(sessionId);
  const entry = useSession(sessionId);
  const actions = useGitActions(sessionId);
  const repo = git.status.value?.repository;
  const settled = settleScope(
    scope,
    scope.kind === 'commit' ? git.commits.value?.commits : undefined,
  );
  useEffect(() => {
    if (settled !== scope) onScope(settled);
  }, [settled, scope, onScope]);
  const load = session.changes(settled, display.hideWhitespace);
  const changes = load.value;
  useEffect(() => {
    void session.loadChanges(settled, display.hideWhitespace);
  }, [session, settled, display.hideWhitespace, load.stale]);
  const base = settled.kind === 'branch' ? settled.base : undefined;
  useEffect(() => {
    if (repo?.base !== undefined || base !== undefined) void session.loadCommits(base);
  }, [session, base, repo?.base, git.commits.stale]);
  const files = changes?.files ?? [];
  const large =
    changes !== undefined &&
    (changes.withheld || changes.added + changes.removed > LARGE_DIFF_LINES);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const key = scopeKey(settled);
  const lastKey = useRef('');
  useEffect(() => {
    if (changes === undefined) return;
    const next = `${key}|${String(changes.files.length)}|${String(large)}`;
    if (next === lastKey.current) return;
    lastKey.current = next;
    setOpen(
      large
        ? new Set()
        : new Set(changes.files.filter((f) => f.diff?.degraded !== true).map((f) => f.path)),
    );
  }, [changes, key, large]);
  const list = useRef<HTMLDivElement>(null);
  const reveal = (path: string, focus: boolean) => {
    setCurrent(path);
    setOpen((old) => new Set(old).add(path));
    requestAnimationFrame(() => {
      const section = list.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
      section?.scrollIntoView({ block: 'start' });
      if (focus) section?.querySelector<HTMLElement>('.git-file-toggle')?.focus();
    });
  };
  const projectRoot = projectFileRoot(entry);
  const projectOf = (path: string) =>
    repo === undefined
      ? undefined
      : projectPath(`${repo.root.replaceAll('\\', '/')}/${path}`, projectRoot);
  const openFile = (path: string) => {
    const location = projectOf(path);
    if (location !== undefined) openProjectFile(sessionId, { path: location });
  };
  const comments = useDiffCommentsState(
    sessionId,
    useMemo(() => files.map((f) => asChangesFile(f, f.diff)), [files]),
    key,
    commentHeading(settled, changes),
  );
  const menu = useMenu();
  const [menuFile, setMenuFile] = useState<FileChange | undefined>(undefined);
  const fileMenu = (file: FileChange): MenuItem[] => {
    const location = projectOf(file.path);
    const absolute = repo === undefined ? file.path : `${repo.root}/${file.path}`;
    const copy = (text: string) => {
      void navigator.clipboard.writeText(text);
    };
    return [
      ...(location === undefined || file.status === 'deleted'
        ? []
        : [
            {
              id: 'attach',
              label: t('git.file.attach'),
              run: () => {
                showPanel('conversation');
                attachProjectFiles(sessionId, [location]);
              },
            },
          ]),
      {
        id: 'copy',
        label: t('git.file.copy'),
        submenu: [
          {
            id: 'abs',
            label: t('files.tree.absolute'),
            run: () => {
              copy(absolute);
            },
          },
          {
            id: 'rel',
            label: t('files.tree.relative'),
            run: () => {
              copy(file.path);
            },
          },
          {
            id: 'name',
            label: t('files.tree.filename'),
            run: () => {
              copy(file.path.slice(file.path.lastIndexOf('/') + 1));
            },
          },
        ],
      },
      ...(location === undefined || file.status === 'deleted'
        ? []
        : [
            {
              id: 'open',
              label: t('git.file.open'),
              run: () => {
                openFile(file.path);
              },
            },
            {
              id: 'reveal',
              label: t(keyPlatform === 'mac' ? 'git.file.revealMac' : 'git.file.reveal'),
              run: () => {
                void window.piarc.projectFileAction(sessionId, location, 'reveal');
              },
            },
          ]),
      ...(settled.kind === 'uncommitted' && repo?.writable === true
        ? [
            {
              id: 'rollback',
              label: t('git.file.rollback'),
              danger: true,
              testId: 'git-file-rollback',
              run: () => {
                void actions.rollback([file.path]);
              },
            },
          ]
        : []),
    ];
  };
  const onMenu = (file: FileChange, x: number, y: number) => {
    setMenuFile(file);
    menu.openAt(x, y);
  };
  const showColumn =
    display.showFiles && (width === 0 || width >= FILES_FIT_WIDTH) && files.length > 0;
  const split =
    display.layout === 'split' &&
    (width === 0 || width - (showColumn ? display.filesWidth : 0) >= SPLIT_FIT_WIDTH);
  const stale = useDelayed(load.loading && load.value !== undefined, 200);
  const loading = useDelayed(load.loading && load.value === undefined, LOADING_DELAY_MS);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isSendKey(event.nativeEvent, keyPlatform)) {
      event.preventDefault();
      const draft = comments.draft;
      const file = files.find((f) => f.path === draft?.path);
      void comments.send(file === undefined ? undefined : asChangesFile(file, file.diff));
      return;
    }
    if (event.key === 'F7') {
      event.preventDefault();
      jumpToChange(list.current, event.shiftKey ? -1 : 1);
    }
  };
  if (changes === undefined) {
    if (load.failure !== undefined) {
      return (
        <div className="tool-empty" role="alert" data-testid="git-failed">
          <AlertIcon />
          <p>{t('git.failed')}</p>
          <button
            type="button"
            className="button button-small"
            onClick={() => void session.loadChanges(settled, display.hideWhitespace, true)}
          >
            {t('git.retry')}
          </button>
        </div>
      );
    }
    return loading ? <Loading /> : null;
  }
  return (
    <DiffCommentsProvider value={comments}>
      <div
        className="git-changes"
        data-stale={stale || undefined}
        aria-busy={load.loading}
        onKeyDown={onKeyDown}
      >
        {showColumn ? (
          <FileColumn
            files={files}
            tree={display.tree}
            byKind={display.groupByKind}
            current={current}
            width={display.filesWidth}
            onWidth={(w) => {
              setDisplay({ filesWidth: clampWidth(w) });
            }}
            onHide={() => {
              setDisplay({ showFiles: false });
            }}
            onSelect={reveal}
            onOpen={openFile}
            onMenu={onMenu}
            commits={git.commits}
            commitsOpen={display.commitsOpen}
            onCommitsOpen={(o) => {
              setDisplay({ commitsOpen: o });
            }}
            scope={settled}
            dirty={(git.status.value?.files.length ?? 0) > 0}
            onScope={onScope}
          />
        ) : null}
        <div className="git-diff-list" ref={list} tabIndex={-1} data-testid="git-diff-list">
          {large ? (
            <p className="git-banner" data-testid="git-large">
              {t('git.large')}
            </p>
          ) : null}
          {changes.truncated ? (
            <p className="git-banner" data-testid="git-truncated">
              {t('git.truncated')}
            </p>
          ) : null}
          {files.length === 0 ? (
            <PanelEmpty
              title={t(settled.kind === 'uncommitted' ? 'git.empty.uncommitted' : 'git.empty.all')}
              icon={<GitBranchIcon size={20} />}
              testId="git-empty"
            />
          ) : (
            files.map((file) => (
              <FileSection
                key={file.path}
                sessionId={sessionId}
                file={file}
                scope={gitScope(settled) ?? { kind: 'uncommitted' }}
                display={{
                  split,
                  wrap: display.wrap,
                  wordDiff: display.wordDiff,
                  hideWhitespace: display.hideWhitespace,
                }}
                open={open.has(file.path)}
                current={current === file.path}
                highlight={transcriptServices.highlight}
                mergeBase={changes.base?.mergeBase}
                onToggle={() => {
                  setOpen((old) => {
                    const next = new Set(old);
                    if (next.has(file.path)) next.delete(file.path);
                    else next.add(file.path);
                    return next;
                  });
                }}
                onOpenFile={projectOf(file.path) === undefined ? undefined : openFile}
                onMenu={onMenu}
              />
            ))
          )}
          <CommentsBar />
        </div>
        {goto ? (
          <GoToFile
            files={files}
            onPick={(path) => {
              onGoto(false);
              reveal(path, true);
            }}
            onClose={() => {
              onGoto(false);
            }}
          />
        ) : null}
        {menu.open === null || menuFile === undefined ? null : (
          <MenuPopup
            items={fileMenu(menuFile)}
            at={menu.open}
            onClose={menu.close}
            label={t('git.file.menu')}
            testId="git-file-menu"
          />
        )}
      </div>
    </DiffCommentsProvider>
  );
}

/** Scrolls the diff list to the next (or previous) block of changed lines, centered. */
function jumpToChange(list: HTMLElement | null, direction: 1 | -1): void {
  if (list === null) return;
  const marks = [...list.querySelectorAll<HTMLElement>('.git-hunk')];
  const top = list.getBoundingClientRect().top;
  const middle = list.clientHeight / 2;
  const positions = marks.map((m) => m.getBoundingClientRect().top - top + list.scrollTop);
  const here = list.scrollTop + middle;
  const target =
    direction === 1
      ? positions.find((p) => p > here + 4)
      : [...positions].reverse().find((p) => p < here - 4);
  if (target !== undefined) list.scrollTo({ top: target - middle });
}
